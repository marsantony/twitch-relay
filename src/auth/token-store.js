// token 檔讀寫：~/.config/twitch-relay/token.json（權限 600，不放 repo 內）。
// 內容：{ clientId, accessToken, refreshToken, scopes, obtainedAt }
// refresh token 是一次性的——寫入失敗等於整個 session 報廢，
// 所以底層用原子寫，呼叫端必須以「寫入成功」為 refresh 完成的判準。
import { join } from "node:path";
import { homedir } from "node:os";
import { readJsonFile, writeJsonFileAtomic } from "../util/json-file.js";

export function defaultTokenPath() {
  return join(homedir(), ".config", "twitch-relay", "token.json");
}

export function readTokens(filePath = defaultTokenPath()) {
  return readJsonFile(filePath);
}

export function writeTokens(tokens, filePath = defaultTokenPath()) {
  return writeJsonFileAtomic(filePath, tokens, { mode: 0o600 });
}
