import { describe, it, expect } from "vitest";
import { createTwitchChatSink, translateDropReason } from "../src/sinks/twitch-chat.js";

const TOKENS = { clientId: "cid", accessToken: "at1", refreshToken: "rt1" };

function fakeDeps({ tokens = TOKENS, helix = {}, refresh, writeResult = { ok: true } } = {}) {
  const written = [];
  return {
    written,
    readTokens: async () => ({ ok: true, value: tokens }),
    writeTokens: async (t) => {
      written.push(t);
      return writeResult;
    },
    refreshTokens:
      refresh ??
      (async () => ({ accessToken: "at2", refreshToken: "rt2", scopes: [], expiresIn: 14400 })),
    helix: {
      validateToken: async () => ({ login: "mars", userId: "111" }),
      getUser: async ({ login }) => ({ id: "999", login, displayName: login }),
      sendChatMessage: async () => ({ isSent: true, dropReason: null }),
      ...helix,
    },
  };
}

describe("translateDropReason", () => {
  it("已知 code → 中文 hint + 原始訊息", () => {
    const r = translateDropReason({ code: "msg_duplicate", message: "dup" });
    expect(r).toContain("重複訊息");
    expect(r).toContain("dup");
  });

  it("未知 code → 原樣輸出，不丟資訊", () => {
    expect(translateDropReason({ code: "channel_settings", message: "x" })).toContain(
      "channel_settings",
    );
  });

  it("無 dropReason → 原因不明", () => {
    expect(translateDropReason(null)).toBe("原因不明");
  });
});

describe("createTwitchChatSink", () => {
  it("init：channel 留空 → broadcaster 即本人", async () => {
    const deps = fakeDeps();
    const sink = createTwitchChatSink({ channel: "", ...deps });
    const ids = await sink.init();
    expect(ids).toEqual({ broadcasterId: "111", senderId: "111", login: "mars" });
  });

  it("init：指定別人頻道 → 解析 broadcaster id", async () => {
    const deps = fakeDeps();
    const sink = createTwitchChatSink({ channel: "someone", ...deps });
    const ids = await sink.init();
    expect(ids.broadcasterId).toBe("999");
    expect(ids.senderId).toBe("111");
  });

  it("沒有 token 檔 → init 給出可動作的錯誤", async () => {
    const deps = fakeDeps();
    deps.readTokens = async () => ({ ok: true, value: null });
    const sink = createTwitchChatSink({ ...deps });
    await expect(sink.init()).rejects.toThrow(/auth/);
  });

  it("send 成功 → { status: 'sent' }", async () => {
    const deps = fakeDeps();
    const sink = createTwitchChatSink({ ...deps });
    await sink.init();
    expect(await sink.send("hi")).toEqual({ status: "sent" });
  });

  it("HTTP 200 但 is_sent false → dropped 帶翻譯後原因（不可默默當成功）", async () => {
    const deps = fakeDeps({
      helix: {
        sendChatMessage: async () => ({
          isSent: false,
          dropReason: { code: "msg_rejected", message: "AutoMod" },
        }),
      },
    });
    const sink = createTwitchChatSink({ ...deps });
    await sink.init();
    const r = await sink.send("hi");
    expect(r.status).toBe("dropped");
    expect(r.reason).toContain("AutoMod");
  });

  it("401 → refresh → 用新 token 重送成功，且新 token 已落地", async () => {
    const sends = [];
    const deps = fakeDeps({
      helix: {
        sendChatMessage: async ({ token }) => {
          sends.push(token);
          if (sends.length === 1) {
            throw Object.assign(new Error("401"), { status: 401 });
          }
          return { isSent: true, dropReason: null };
        },
      },
    });
    const sink = createTwitchChatSink({ ...deps });
    await sink.init();
    const r = await sink.send("hi");
    expect(r).toEqual({ status: "sent" });
    expect(sends).toEqual(["at1", "at2"]);
    expect(deps.written.at(-1).refreshToken).toBe("rt2"); // refresh token 已輪換落地
  });

  it("refresh 成功但寫檔失敗 → failed 且提示重新授權（refresh token 已被消耗）", async () => {
    const deps = fakeDeps({
      helix: {
        sendChatMessage: async () => {
          throw Object.assign(new Error("401"), { status: 401 });
        },
      },
      writeResult: { ok: false, error: "磁碟唯讀" },
    });
    const sink = createTwitchChatSink({ ...deps });
    await sink.init();
    const r = await sink.send("hi");
    expect(r.status).toBe("failed");
    expect(r.error).toContain("重新執行 auth");
  });

  it("非 401 錯誤 → failed，不觸發 refresh", async () => {
    let refreshed = false;
    const deps = fakeDeps({
      helix: {
        sendChatMessage: async () => {
          throw Object.assign(new Error("500 內部錯誤"), { status: 500 });
        },
      },
      refresh: async () => {
        refreshed = true;
        return {};
      },
    });
    const sink = createTwitchChatSink({ ...deps });
    await sink.init();
    const r = await sink.send("hi");
    expect(r.status).toBe("failed");
    expect(refreshed).toBe(false);
  });
});
