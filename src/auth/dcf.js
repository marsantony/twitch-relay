// Twitch OAuth Device Code Grant Flow（public client，不需 client secret）。
// 文件：https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

export class AuthError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取得 device code 與使用者要輸入的 user code。 */
export async function requestDeviceCode({ clientId, scopes, fetchImpl = fetch }) {
  const body = new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") });
  const res = await fetchImpl(DEVICE_URL, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(`取得 device code 失敗：${res.status} ${data.message ?? ""}`);
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    intervalSec: data.interval ?? 5,
    expiresInSec: data.expires_in,
  };
}

/** 輪詢直到使用者完成授權。pending 之外的錯誤（過期、拒絕）直接丟出。 */
export async function pollForToken({
  clientId,
  scopes,
  deviceCode,
  intervalSec = 5,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  for (;;) {
    await sleepImpl(intervalSec * 1000);
    const body = new URLSearchParams({
      client_id: clientId,
      scopes: scopes.join(" "),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetchImpl(TOKEN_URL, { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return toTokens(data);
    const message = String(data.message ?? "");
    if (message.includes("authorization_pending")) continue;
    if (message.includes("slow")) {
      intervalSec += 5;
      continue;
    }
    throw new AuthError(`授權失敗：${res.status} ${message}（可能過期或被拒絕，請重新執行 auth）`);
  }
}

/** 用 refresh token 換新 token。public client 的 refresh token 一次性，呼叫端負責立即落地。 */
export async function refreshTokens({ clientId, refreshToken, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(TOKEN_URL, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(`refresh token 失敗：${res.status} ${data.message ?? ""}，請執行 auth 重新授權`);
  }
  return toTokens(data);
}

function toTokens(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scopes: data.scope ?? [],
    expiresIn: data.expires_in,
  };
}
