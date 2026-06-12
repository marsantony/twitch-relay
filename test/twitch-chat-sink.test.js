import { describe, it, expect } from "vitest";
import { createTwitchChatSink, translateDropReason } from "../src/sinks/twitch-chat.js";

// 假的 token-manager：直接以固定 token 執行 fn，clientId 固定
function fakeTokenManager() {
  return {
    load: async () => {},
    clientId: "cid",
    withAuth: async (fn) => fn("at1"),
  };
}

function fakeHelix(overrides = {}) {
  return {
    validateToken: async () => ({ login: "mars", userId: "111" }),
    getUser: async ({ login }) => ({ id: `id-${login}`, login, displayName: login }),
    sendChatMessage: async () => ({ isSent: true, dropReason: null }),
    ...overrides,
  };
}

describe("translateDropReason", () => {
  it("已知 code → 中文 hint + 原始訊息", () => {
    const r = translateDropReason({ code: "msg_duplicate", message: "dup" });
    expect(r).toContain("重複訊息");
    expect(r).toContain("dup");
  });

  it("未知 code → 原樣輸出", () => {
    expect(translateDropReason({ code: "weird", message: "x" })).toContain("weird");
  });

  it("無 dropReason → 原因不明", () => {
    expect(translateDropReason(null)).toBe("原因不明");
  });
});

describe("createTwitchChatSink fan-out", () => {
  it("沒有頻道 → init 報錯", async () => {
    const sink = createTwitchChatSink({
      channels: [],
      tokenManager: fakeTokenManager(),
      helix: fakeHelix(),
    });
    await expect(sink.init()).rejects.toThrow(/channels add|--channel/);
  });

  it("init：缺 id 的頻道用 getUser 解析；有 id 的不重查", async () => {
    let getUserCalls = 0;
    const helix = fakeHelix({
      getUser: async ({ login }) => {
        getUserCalls++;
        return { id: `id-${login}`, login, displayName: login };
      },
    });
    const sink = createTwitchChatSink({
      channels: [{ login: "alice" }, { login: "bob", id: "222" }],
      tokenManager: fakeTokenManager(),
      helix,
    });
    const info = await sink.init();
    expect(info.login).toBe("mars");
    expect(info.channels).toEqual(["alice", "bob"]);
    expect(getUserCalls).toBe(1); // 只解析缺 id 的 alice
  });

  it("send：一則訊息 fan-out 到所有頻道，各自回結果", async () => {
    const sent = [];
    const helix = fakeHelix({
      sendChatMessage: async ({ broadcasterId }) => {
        sent.push(broadcasterId);
        return { isSent: true, dropReason: null };
      },
    });
    const sink = createTwitchChatSink({
      channels: [{ login: "alice", id: "111" }, { login: "bob", id: "222" }],
      tokenManager: fakeTokenManager(),
      helix,
    });
    await sink.init();
    const { results } = await sink.send("hi");
    expect(results).toEqual([
      { channel: "alice", status: "sent" },
      { channel: "bob", status: "sent" },
    ]);
    expect(sent.sort()).toEqual(["111", "222"]);
  });

  it("某頻道 dropped（is_sent:false）不影響其他頻道", async () => {
    const helix = fakeHelix({
      sendChatMessage: async ({ broadcasterId }) =>
        broadcasterId === "111"
          ? { isSent: false, dropReason: { code: "msg_rejected", message: "AutoMod" } }
          : { isSent: true, dropReason: null },
    });
    const sink = createTwitchChatSink({
      channels: [{ login: "alice", id: "111" }, { login: "bob", id: "222" }],
      tokenManager: fakeTokenManager(),
      helix,
    });
    await sink.init();
    const { results } = await sink.send("hi");
    expect(results[0]).toMatchObject({ channel: "alice", status: "dropped" });
    expect(results[0].reason).toContain("AutoMod");
    expect(results[1]).toEqual({ channel: "bob", status: "sent" });
  });

  it("某頻道 send 丟例外 → 該頻道 failed，其他正常", async () => {
    const helix = fakeHelix({
      sendChatMessage: async ({ broadcasterId }) => {
        if (broadcasterId === "111") throw new Error("500 內部錯誤");
        return { isSent: true, dropReason: null };
      },
    });
    const sink = createTwitchChatSink({
      channels: [{ login: "alice", id: "111" }, { login: "bob", id: "222" }],
      tokenManager: fakeTokenManager(),
      helix,
    });
    await sink.init();
    const { results } = await sink.send("hi");
    expect(results[0]).toMatchObject({ channel: "alice", status: "failed" });
    expect(results[0].error).toContain("500");
    expect(results[1].status).toBe("sent");
  });
});
