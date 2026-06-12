#!/usr/bin/env node
// twitch-relay CLI：
//   auth --client-id <id>                     一次性 DCF 授權（Public client，不需 secret）
//   run --config <path> [--dry-run] [--state <path>]   啟動播報 pipeline
import { readFile } from "node:fs/promises";
import { requestDeviceCode, pollForToken } from "./auth/dcf.js";
import { writeTokens, defaultTokenPath } from "./auth/token-store.js";
import { createEspnSource } from "./sources/espn.js";
import { createFormatter } from "./format/soccer-zh.js";
import { createTwitchChatSink } from "./sinks/twitch-chat.js";
import { createConsoleSink } from "./sinks/console.js";
import { createPipeline } from "./core/pipeline.js";
import { loadState, saveState, stateFileFor } from "./core/state.js";
import { createLogger } from "./util/logger.js";

const SCOPES = ["user:write:chat"];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") flags.dryRun = true;
    else if (rest[i].startsWith("--")) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${rest[i]} 缺少對應的值`);
      }
      const key = rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = value;
      i++;
    }
  }
  return { command, flags };
}

async function cmdAuth({ clientId }) {
  if (!clientId) {
    throw new Error("請提供 --client-id（在 dev.twitch.tv/console 建立 Public client type 的 app）");
  }
  const logger = createLogger();
  const dc = await requestDeviceCode({ clientId, scopes: SCOPES });
  logger.info(`請用瀏覽器開啟：${dc.verificationUri}`);
  logger.info(`並輸入代碼：${dc.userCode}（${Math.round(dc.expiresInSec / 60)} 分鐘內有效）`);
  logger.info("等待授權中…");
  const tokens = await pollForToken({
    clientId,
    scopes: SCOPES,
    deviceCode: dc.deviceCode,
    intervalSec: dc.intervalSec,
  });
  const w = await writeTokens({ clientId, ...tokens, obtainedAt: new Date().toISOString() });
  if (!w.ok) throw new Error(w.error);
  logger.info(`授權完成，token 已存到 ${defaultTokenPath()}`);
}

function createSource(cfg = {}) {
  if (cfg.type === "espn") return createEspnSource({ league: cfg.league });
  throw new Error(`未知的 source type：${cfg.type}`);
}

async function cmdRun({ config: configPath, dryRun, state: stateOverride }) {
  if (!configPath) throw new Error("請提供 --config <path>");
  const logger = createLogger();
  const config = JSON.parse(await readFile(configPath, "utf8"));

  const source = createSource(config.source);
  const formatEvent = createFormatter(config.format);
  const sink = dryRun
    ? createConsoleSink({ logger })
    : createTwitchChatSink({ channel: config.sink?.channel });
  const ids = await sink.init();
  if (!dryRun) logger.info(`將以 ${ids.login} 身分發話到頻道 ID ${ids.broadcasterId}`);

  // 啟動提醒：印出本日賽程，順便驗證 source 可用
  const first = await source.fetchSnapshot();
  if (first.ok) {
    logger.info(`目前賽程 ${first.value.matches.length} 場：`);
    for (const m of first.value.matches) {
      logger.info(
        `　${m.home.name} ${m.home.score}-${m.away.score} ${m.away.name}（${m.statusName || "未開賽"}）`,
      );
    }
  } else {
    logger.warn(`賽程抓取失敗：${first.error}`);
  }

  const statePath = stateOverride ?? stateFileFor(configPath);
  logger.info(`state 檔：${statePath}`);
  if (dryRun) logger.info("dry-run 模式：訊息只印到 console，但 state 照常寫入（避免轉正式時洗版）");

  const pipeline = createPipeline({
    source,
    formatEvent,
    sink,
    statePath,
    loadState,
    saveState,
    logger,
    pollIntervalSec: config.source?.pollIntervalSec ?? 20,
  });
  await pipeline.run({});
}

const { command, flags } = parseArgs(process.argv.slice(2));
try {
  if (command === "auth") await cmdAuth(flags);
  else if (command === "run") await cmdRun(flags);
  else {
    console.log("用法：node src/cli.js auth --client-id <id>");
    console.log("　　　node src/cli.js run --config configs/worldcup2026.json [--dry-run] [--state <path>]");
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`❌ ${err?.message ?? err}`);
  process.exitCode = 1;
}
