// Twitch 聊天室 sink（多頻道 fan-out）。一則訊息送到所有頻道，各頻道獨立、互不影響。
// send() 回 { results: [{ channel, status, reason?/error? }] }；status:
//   "sent" / "dropped"（HTTP 200 但 is_sent:false）/ "failed"（HTTP 層錯誤）
// HTTP 200 不等於發成功——必檢 is_sent / drop_reason，這是最容易被吃掉的失敗路徑。
import * as helixDefault from "../twitch/helix.js";
import { createTokenManager } from "../auth/token-manager.js";

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

/**
 * @param channels 要播報的頻道清單 [{ login, id }]（id 可選；缺則 init 時用 getUser 補）
 */
export function createTwitchChatSink({
  channels = [],
  tokenPath,
  helix = helixDefault,
  tokenManager = createTokenManager({ tokenPath }),
} = {}) {
  let senderId = null;
  let targets = null; // [{ login, id }]，id 已解析

  async function resolveId(channel) {
    if (channel.id) return channel;
    const user = await tokenManager.withAuth((token) =>
      helix.getUser({ login: channel.login, token, clientId: tokenManager.clientId }),
    );
    if (!user) throw new Error(`找不到頻道：${channel.login}`);
    return { login: user.login, id: user.id };
  }

  async function init() {
    await tokenManager.load();
    const self = await tokenManager.withAuth((token) => helix.validateToken({ token }));
    senderId = self.userId;
    if (channels.length === 0) {
      throw new Error("沒有要播報的頻道，請先 channels add <name> 或用 --channel");
    }
    targets = await Promise.all(channels.map(resolveId)); // 並發解析各頻道 id
    return { login: self.login, senderId, channels: targets.map((t) => t.login) };
  }

  async function sendToOne(target, message) {
    try {
      const result = await tokenManager.withAuth((token) =>
        helix.sendChatMessage({
          broadcasterId: target.id,
          senderId,
          message,
          token,
          clientId: tokenManager.clientId,
        }),
      );
      if (result.isSent) return { channel: target.login, status: "sent" };
      return { channel: target.login, status: "dropped", reason: translateDropReason(result.dropReason) };
    } catch (err) {
      return { channel: target.login, status: "failed", error: String(err?.message ?? err) };
    }
  }

  // fan-out 到所有頻道；某頻道失敗不影響其他。回各頻道結果。
  async function send(message) {
    const results = await Promise.all(targets.map((t) => sendToOne(t, message)));
    return { results };
  }

  return { init, send };
}
