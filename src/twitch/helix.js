// Twitch Helix 薄封裝（user access token）。沿用 twitch-link-logger 的 fetchImpl 注入慣例。
// HTTP 層失敗丟 HelixError（帶 status，401 供上層 refresh 重試）；
// 發話的「200 但被擋」不是 HTTP 失敗，由回傳值的 isSent / dropReason 表達。
const HELIX = "https://api.twitch.tv/helix";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TIMEOUT_MS = 10000; // 避免連線 hang 住卡死整條 pipeline

const timeoutSignal = () => AbortSignal.timeout(TIMEOUT_MS);

export class HelixError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headers(token, clientId) {
  return { Authorization: `Bearer ${token}`, "Client-Id": clientId };
}

/** 驗證 token 並取得本人身分；回 { login, userId }。無效時丟 HelixError(401)。 */
export async function validateToken({ token, fetchImpl = fetch }) {
  const res = await fetchImpl(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${token}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new HelixError(`token 驗證失敗：${res.status}`, res.status);
  const data = await res.json();
  return { login: data.login, userId: data.user_id };
}

/** 以 login 查使用者；回 { id, login, displayName } 或 null。 */
export async function getUser({ login, token, clientId, fetchImpl = fetch }) {
  const res = await fetchImpl(`${HELIX}/users?login=${encodeURIComponent(login)}`, {
    headers: headers(token, clientId),
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new HelixError(`查 users 失敗：${res.status}`, res.status);
  const data = await res.json();
  const u = data.data && data.data[0];
  return u ? { id: u.id, login: u.login, displayName: u.display_name } : null;
}

/** 發聊天訊息。HTTP 成功時回 { isSent, dropReason }——isSent 為 false 時訊息沒進聊天室。 */
export async function sendChatMessage({
  broadcasterId,
  senderId,
  message,
  token,
  clientId,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(`${HELIX}/chat/messages`, {
    method: "POST",
    headers: { ...headers(token, clientId), "Content-Type": "application/json" },
    body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: senderId, message }),
    signal: timeoutSignal(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HelixError(`發話失敗：${res.status} ${data.message ?? ""}`, res.status);
  const result = data.data && data.data[0];
  return { isSent: Boolean(result?.is_sent), dropReason: result?.drop_reason ?? null };
}
