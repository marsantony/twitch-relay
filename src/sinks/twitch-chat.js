// Twitch 聊天室 sink。send() 回三態：
// { status: "sent" } / { status: "dropped", reason } / { status: "failed", error }
// HTTP 200 不等於發成功——必須檢查 is_sent / drop_reason，這是最容易被吃掉的失敗路徑。
import * as helixDefault from "../twitch/helix.js";
import { refreshTokens as refreshTokensDefault } from "../auth/dcf.js";
import {
  readTokens as readTokensDefault,
  writeTokens as writeTokensDefault,
} from "../auth/token-store.js";

// drop_reason code → 可動作中文 hint（概念沿用 TwitchSelfReply 的 translateIrcError）
const DROP_HINTS = [
  ["msg_duplicate", "重複訊息：30 秒內相同內容會被擋"],
  ["msg_ratelimit", "送話過快：達到訊息頻率上限"],
  ["msg_slowmode", "slow mode：頻道限制發話間隔"],
  ["msg_followersonly", "只開放追隨者發言"],
  ["msg_subsonly", "只開放訂閱者發言"],
  ["msg_emoteonly", "只能發 emote"],
  ["msg_r9k", "r9k 模式：每則訊息必須不同"],
  ["msg_timedout", "你在該頻道被 timeout"],
  ["msg_banned", "你被該頻道封鎖"],
  ["msg_channel_suspended", "頻道被停權"],
  ["msg_suspended", "帳號被停權"],
  ["msg_rejected", "被 AutoMod 擋下"],
  ["msg_verified_email", "需要先驗證 email"],
];

export function translateDropReason(dropReason) {
  if (!dropReason) return "原因不明";
  const code = String(dropReason.code ?? dropReason).toLowerCase();
  const hit = DROP_HINTS.find(([key]) => code.includes(key));
  const detail = dropReason.message ? `（${dropReason.message}）` : "";
  return `${hit ? hit[1] : code}${detail}`;
}

export function createTwitchChatSink({
  channel,
  tokenPath,
  helix = helixDefault,
  refreshTokens = refreshTokensDefault,
  readTokens = readTokensDefault,
  writeTokens = writeTokensDefault,
} = {}) {
  let auth = null; // token 檔內容（記憶體副本，refresh 後同步更新）
  let ids = null; // { broadcasterId, senderId, login }

  async function loadAuth() {
    const r = await readTokens(tokenPath);
    if (!r.ok) throw new Error(r.error);
    if (!r.value) {
      throw new Error("找不到 token 檔，請先執行：node src/cli.js auth --client-id <id>");
    }
    return r.value;
  }

  async function refreshAndPersist() {
    const fresh = await refreshTokens({ clientId: auth.clientId, refreshToken: auth.refreshToken });
    const next = { ...auth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken };
    const w = await writeTokens(next, tokenPath);
    if (!w.ok) {
      // 舊 refresh token 已被消耗、新 token 沒落地 → 下次啟動必死，現在就 fail loud
      throw new Error(`refresh 成功但 token 檔寫入失敗（${w.error}），請重新執行 auth`);
    }
    auth = next;
  }

  async function withAuth(fn) {
    try {
      return await fn(auth.accessToken);
    } catch (err) {
      if (err?.status !== 401) throw err;
      await refreshAndPersist();
      return await fn(auth.accessToken);
    }
  }

  async function init() {
    auth = await loadAuth();
    const self = await withAuth((token) => helix.validateToken({ token }));
    let broadcasterId = self.userId;
    if (channel && channel.toLowerCase() !== self.login.toLowerCase()) {
      const user = await withAuth((token) =>
        helix.getUser({ login: channel, token, clientId: auth.clientId }),
      );
      if (!user) throw new Error(`找不到頻道：${channel}`);
      broadcasterId = user.id;
    }
    ids = { broadcasterId, senderId: self.userId, login: self.login };
    return ids;
  }

  async function send(message) {
    try {
      const result = await withAuth((token) =>
        helix.sendChatMessage({
          broadcasterId: ids.broadcasterId,
          senderId: ids.senderId,
          message,
          token,
          clientId: auth.clientId,
        }),
      );
      if (result.isSent) return { status: "sent" };
      return { status: "dropped", reason: translateDropReason(result.dropReason) };
    } catch (err) {
      return { status: "failed", error: String(err?.message ?? err) };
    }
  }

  return { init, send };
}
