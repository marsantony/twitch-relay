#!/usr/bin/env node
// twitch-relay CLI：
//   auth --client-id <id>                          一次性 DCF 授權（Public client，不需 secret）
//   channels list|add|remove [<login>] --config <path>   管理播報頻道（存在 repo 外）
//   run --config <path> [--dry-run] [--channel <login>]… [--state <path>]   啟動播報
import { readFile } from "node:fs/promises";
import { requestDeviceCode, pollForToken } from "./auth/dcf.js";
import { writeTokens, defaultTokenPath } from "./auth/token-store.js";
import { createTokenManager } from "./auth/token-manager.js";
import { getUser } from "./twitch/helix.js";
import {
  channelsFileFor,
  loadChannels,
  addChannel,
  removeChannel,
} from "./channels/store.js";
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
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--dry-run") {
      flags.dryRun = true;
    } else if (tok.startsWith("--")) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${tok} 缺少對應的值`);
      }
      const key = tok.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = key in flags ? [].concat(flags[key], value) : value; // 可重複 → 陣列
      i++;
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

function dedupeByLogin(channels) {
  const seen = new Set();
  const out = [];
  for (const c of channels) {
    const key = c.login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
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

async function cmdChannels({ positionals, config }) {
  if (!config) throw new Error("請提供 --config <path>");
  const logger = createLogger();
  const [sub, login] = positionals;
  const file = channelsFileFor(config);

  if (sub === "list") {
    const r = await loadChannels(file);
    if (!r.ok) throw new Error(r.error);
    if (r.value.length === 0) logger.info("（尚無頻道）");
    else r.value.forEach((c) => logger.info(`- ${c.login}`));
    return;
  }
  if (sub === "add") {
    if (!login) throw new Error("用法：channels add <login> --config <path>");
    const tm = createTokenManager({});
    await tm.load();
    const user = await tm.withAuth((token) => getUser({ login, token, clientId: tm.clientId }));
    if (!user) throw new Error(`找不到頻道：${login}（請確認帳號拼寫）`);
    const r = await addChannel({ login: user.login, id: user.id }, file);
    if (!r.ok) throw new Error(r.error);
    logger.info(r.already ? `頻道已在清單：${user.login}` : `已新增頻道：${user.login}`);
    return;
  }
  if (sub === "remove") {
    if (!login) throw new Error("用法：channels remove <login> --config <path>");
    const r = await removeChannel(login, file);
    if (!r.ok) throw new Error(r.error);
    logger.info(r.missing ? `頻道不在清單：${login}` : `已移除頻道：${login}`);
    return;
  }
  throw new Error("用法：channels list|add|remove [<login>] --config <path>");
}

function createSource(cfg = {}) {
  if (cfg.type === "espn") return createEspnSource({ league: cfg.league });
  throw new Error(`未知的 source type：${cfg.type}`);
}

async function cmdRun({ config: configPath, dryRun, channel, state: stateOverride }) {
  if (!configPath) throw new Error("請提供 --config <path>");
  const logger = createLogger();
  const config = JSON.parse(await readFile(configPath, "utf8"));

  // 頻道 = store + --channel flag（合併去重）；空則報錯，不隱式發到自己台
  const stored = await loadChannels(channelsFileFor(configPath));
  if (!stored.ok) throw new Error(stored.error);
  const flagChannels = [].concat(channel ?? []).map((login) => ({ login }));
  const channels = dedupeByLogin([...stored.value, ...flagChannels]);
  if (channels.length === 0) {
    throw new Error("尚未設定頻道，請先 channels add <name> 或用 --channel <name>");
  }

  const source = createSource(config.source);
  const formatEvent = createFormatter(config.format);
  const sink = dryRun
    ? createConsoleSink({ logger, channels })
    : createTwitchChatSink({ channels });
  const info = await sink.init();
  logger.info(`將以 ${info.login} 身分播報到：${info.channels.join(", ")}`);

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

const { command, positionals, flags } = parseArgs(process.argv.slice(2));
try {
  if (command === "auth") await cmdAuth(flags);
  else if (command === "channels") await cmdChannels({ positionals, ...flags });
  else if (command === "run") await cmdRun(flags);
  else {
    console.log("用法：");
    console.log("  node src/cli.js auth --client-id <id>");
    console.log("  node src/cli.js channels list|add|remove [<login>] --config <path>");
    console.log("  node src/cli.js run --config <path> [--dry-run] [--channel <login>]… [--state <path>]");
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`❌ ${err?.message ?? err}`);
  process.exitCode = 1;
}
