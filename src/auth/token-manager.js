// 共用的 token 取用層。把 auth（load / refresh / persist / 401 retry）從 sink 抽出來，
// 讓同一 process 內多個頻道 sink 共用一份 token 與一次 refresh。
//
// 兩層去重，應付「多個 pipeline 共用同一帳號 token 檔」的並發 refresh：
//   1. process 內：單一 inFlightRefresh promise，並發的多個 401 合併成一次 refresh
//   2. process 間：retry-with-re-read。refresh token 一次性，輸家撞 invalid_grant 後不放棄，
//      等贏家把新 token 寫進磁碟，重讀撿來用。正確性來自「復原」，不需要鎖。
import * as dcfDefault from "./dcf.js";
import {
  readTokens as readTokensDefault,
  writeTokens as writeTokensDefault,
} from "./token-store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 重試預算：贏家寫檔只要幾毫秒，這裡留寬鬆餘裕，耗盡才判定 token 真的失效
const REREAD_ATTEMPTS = 5;
const REREAD_INTERVAL_MS = 500;

export class AuthError extends Error {}

export function createTokenManager({
  tokenPath,
  refreshTokens = dcfDefault.refreshTokens,
  readTokens = readTokensDefault,
  writeTokens = writeTokensDefault,
  sleepImpl = sleep,
  rereadAttempts = REREAD_ATTEMPTS,
  rereadIntervalMs = REREAD_INTERVAL_MS,
} = {}) {
  let auth = null; // 記憶體副本 { clientId, accessToken, refreshToken, ... }
  let inFlightRefresh = null; // process 內 single-flight

  async function readFromDisk() {
    const r = await readTokens(tokenPath);
    if (!r.ok) throw new AuthError(r.error);
    if (!r.value) {
      throw new AuthError("找不到 token 檔，請先執行：node src/cli.js auth --client-id <id>");
    }
    return r.value;
  }

  async function load() {
    auth = await readFromDisk();
    return auth;
  }

  async function persist(next) {
    const w = await writeTokens(next, tokenPath);
    if (!w.ok) {
      // 舊 refresh token 已被消耗、新的沒落地 → 下次必死，現在就 fail loud
      throw new AuthError(`refresh 成功但 token 檔寫入失敗（${w.error}），請重新執行 auth`);
    }
    auth = next;
  }

  // 真的去 refresh 一次（呼叫端已確保是 single-flight）。
  // 撞 invalid_grant（別的 process 先 rotate 了）→ 重讀磁碟撿新 token，不再自己 refresh。
  async function doRefresh(usedAccessToken) {
    // 先重讀：等鎖期間若已有人 refresh，直接用，省一次無謂呼叫
    const onDisk = await readFromDisk();
    if (onDisk.accessToken !== usedAccessToken) {
      auth = onDisk;
      return;
    }
    try {
      const fresh = await refreshTokens({
        clientId: auth.clientId,
        refreshToken: auth.refreshToken,
      });
      await persist({ ...auth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
    } catch (err) {
      // 輸家：refresh token 已被贏家消耗。等贏家寫檔，重讀撿新 token。
      for (let i = 0; i < rereadAttempts; i++) {
        await sleepImpl(rereadIntervalMs);
        const retry = await readFromDisk();
        if (retry.accessToken !== usedAccessToken) {
          auth = retry;
          return;
        }
      }
      throw new AuthError(`token 已失效且無法自動恢復（${err.message}），請重新執行 auth`);
    }
  }

  async function refresh(usedAccessToken) {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefresh(usedAccessToken).finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  // 執行 fn(accessToken)；遇 401 → refresh（去重）→ 用新 token 重試一次。
  async function withAuth(fn) {
    if (!auth) await load();
    const used = auth.accessToken;
    try {
      return await fn(auth.accessToken);
    } catch (err) {
      if (err?.status !== 401) throw err;
      await refresh(used);
      return await fn(auth.accessToken);
    }
  }

  return { load, withAuth, get clientId() {
    return auth?.clientId;
  } };
}
