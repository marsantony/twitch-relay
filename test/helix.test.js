import { describe, it, expect } from "vitest";
import { validateToken, getUser, sendChatMessage, HelixError } from "../src/twitch/helix.js";
import { jsonResponse, sequenceFetch } from "./helpers.js";

describe("validateToken", () => {
  it("有效 token → 回 login 與 userId", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(200, { login: "mars", user_id: "111" })]);
    const r = await validateToken({ token: "t", fetchImpl });
    expect(r).toEqual({ login: "mars", userId: "111" });
  });

  it("無效 token → HelixError 帶 status 401", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(401, {})]);
    const err = await validateToken({ token: "bad", fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(HelixError);
    expect(err.status).toBe(401);
  });
});

describe("getUser", () => {
  it("查到 → 回正規化使用者", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { data: [{ id: "222", login: "ch", display_name: "Ch" }] }),
    ]);
    const u = await getUser({ login: "ch", token: "t", clientId: "cid", fetchImpl });
    expect(u).toEqual({ id: "222", login: "ch", displayName: "Ch" });
  });

  it("查不到 → null", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(200, { data: [] })]);
    const u = await getUser({ login: "ghost", token: "t", clientId: "cid", fetchImpl });
    expect(u).toBeNull();
  });
});

describe("sendChatMessage", () => {
  const args = { broadcasterId: "111", senderId: "111", message: "hi", token: "t", clientId: "cid" };

  it("發成功 → isSent true", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { data: [{ message_id: "m1", is_sent: true }] }),
    ]);
    const r = await sendChatMessage({ ...args, fetchImpl });
    expect(r).toEqual({ isSent: true, dropReason: null });
    const body = JSON.parse(fetchImpl.calls[0].options.body);
    expect(body).toEqual({ broadcaster_id: "111", sender_id: "111", message: "hi" });
  });

  it("HTTP 200 但被擋 → isSent false 帶 dropReason（不可被當成功）", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, {
        data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_rejected", message: "AutoMod" } }],
      }),
    ]);
    const r = await sendChatMessage({ ...args, fetchImpl });
    expect(r.isSent).toBe(false);
    expect(r.dropReason.code).toBe("msg_rejected");
  });

  it("401 → HelixError 帶 status（供上層 refresh 重試）", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(401, { message: "Invalid OAuth token" })]);
    const err = await sendChatMessage({ ...args, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(HelixError);
    expect(err.status).toBe(401);
  });
});
