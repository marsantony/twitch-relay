// diff 狀態的持久化（已播報 key、各場比賽狀態）。
// 檔名跟著 config 名走，不同 config 的 state 不互相污染。
import { readJsonFile, writeJsonFileAtomic } from "../util/json-file.js";
import { configScopedPath } from "../util/config-path.js";
import { emptyState } from "./diff.js";

export function stateFileFor(configPath) {
  return configScopedPath("state", configPath);
}

/** 讀 state。檔案不存在 → 全新 emptyState；parse 失敗 → fail loud，不靜默清空重來。 */
export async function loadState(filePath) {
  const r = await readJsonFile(filePath);
  if (!r.ok) return r;
  return { ok: true, value: r.value ?? emptyState() };
}

export function saveState(state, filePath) {
  return writeJsonFileAtomic(filePath, state);
}
