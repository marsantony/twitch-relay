// diff 狀態的持久化（已播報 key、各場比賽狀態）。
// 檔名跟著 config 名走，不同 config 的 state 不互相污染。
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readJsonFile, writeJsonFileAtomic } from "../util/json-file.js";
import { emptyState } from "./diff.js";

export function stateFileFor(configPath) {
  const name = basename(configPath).replace(/\.json$/, "");
  return join(homedir(), ".config", "twitch-relay", `state-${name}.json`);
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
