import { describe, it, expect } from "vitest";
import { requestDeviceCode, pollForToken, refreshTokens, AuthError } from "../src/auth/dcf.js";
import { jsonResponse, sequenceFetch } from "./helpers.js";

const noSleep = async () => {};

describe("requestDeviceCode", () => {
  it("回傳正規化後的 device code 資訊", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, {
        device_code: "dev123",
        user_code: "ABCD-1234",
        verification_uri: "https://www.twitch.tv/activate",
        interval: 5,
        expires_in: 1800,
      }),
    ]);
    const dc = await requestDeviceCode({ clientId: "cid", scopes: ["user:write:chat"], fetchImpl });
    expect(dc).toEqual({
      deviceCode: "dev123",
      userCode: "ABCD-1234",
      verificationUri: "https://www.twitch.tv/activate",
      intervalSec: 5,
      expiresInSec: 1800,
    });
    const body = fetchImpl.calls[0].options.body.toString();
    expect(body).toContain("client_id=cid");
    expect(body).toContain("scopes=user%3Awrite%3Achat");
  });

  it("HTTP 失敗 → AuthError", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(400, { message: "invalid client" })]);
    await expect(
      requestDeviceCode({ clientId: "bad", scopes: [], fetchImpl }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("pollForToken", () => {
  it("pending 之後成功 → 回傳 tokens", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(400, { message: "authorization_pending" }),
      jsonResponse(200, {
        access_token: "at",
        refresh_token: "rt",
        scope: ["user:write:chat"],
        expires_in: 14400,
      }),
    ]);
    const tokens = await pollForToken({
      clientId: "cid",
      scopes: ["user:write:chat"],
      deviceCode: "dev123",
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("使用者拒絕 → AuthError，不再輪詢", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(400, { message: "access denied" })]);
    await expect(
      pollForToken({ clientId: "cid", scopes: [], deviceCode: "d", fetchImpl, sleepImpl: noSleep }),
    ).rejects.toThrow(/授權失敗/);
  });
});

describe("refreshTokens", () => {
  it("成功 → 回傳新 tokens（refresh token 已輪換）", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { access_token: "at2", refresh_token: "rt2", expires_in: 14400 }),
    ]);
    const t = await refreshTokens({ clientId: "cid", refreshToken: "rt1", fetchImpl });
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("rt2");
  });

  it("失敗 → 錯誤訊息提示重新授權", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(400, { message: "Invalid refresh token" })]);
    await expect(refreshTokens({ clientId: "cid", refreshToken: "used", fetchImpl })).rejects.toThrow(
      /重新授權/,
    );
  });
});
