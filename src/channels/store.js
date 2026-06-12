// 頻道清單儲存：~/.config/twitch-relay/channels-<config>.json，內容 [{ login, id }]。
// 跟 state 檔一樣 per-config（不同 pipeline 的頻道集互不干擾），存在 repo 外、不進 git。
// 存 id 是為了 run 啟動時免再 getUser 重查（id 穩定、login 可變）。
import { readJsonFile, writeJsonFileAtomic } from "../util/json-file.js";
import { configScopedPath } from "../util/config-path.js";

export function channelsFileFor(configPath) {
  return configScopedPath("channels", configPath);
}

/** 讀頻道清單。檔案不存在 → 空陣列；parse 失敗 → fail loud（沿用 json-file 三態）。 */
export async function loadChannels(filePath) {
  const r = await readJsonFile(filePath);
  if (!r.ok) return r;
  return { ok: true, value: r.value ?? [] };
}

function saveChannels(channels, filePath) {
  return writeJsonFileAtomic(filePath, channels);
}

/** 新增頻道（以 login 去重，大小寫不敏感）。回 { ok, value: channels } 或 { ok:false, error }。 */
export async function addChannel({ login, id }, filePath) {
  const r = await loadChannels(filePath);
  if (!r.ok) return r;
  const lower = login.toLowerCase();
  if (r.value.some((c) => c.login.toLowerCase() === lower)) {
    return { ok: true, value: r.value, already: true };
  }
  const next = [...r.value, { login, id }];
  const w = await saveChannels(next, filePath);
  if (!w.ok) return w;
  return { ok: true, value: next };
}

/** 移除頻道（以 login 比對，大小寫不敏感）。 */
export async function removeChannel(login, filePath) {
  const r = await loadChannels(filePath);
  if (!r.ok) return r;
  const lower = login.toLowerCase();
  const next = r.value.filter((c) => c.login.toLowerCase() !== lower);
  if (next.length === r.value.length) {
    return { ok: true, value: next, missing: true };
  }
  const w = await saveChannels(next, filePath);
  if (!w.ok) return w;
  return { ok: true, value: next };
}
