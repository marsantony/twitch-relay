import { describe, it, expect } from "vitest";
import { createTokenManager } from "../src/auth/token-manager.js";

const BASE = { clientId: "cid", accessToken: "at1", refreshToken: "rt1" };

function makeDeps({ disk = { ...BASE }, refresh, writeResult = { ok: true } } = {}) {
  const state = { disk: { ...disk }, writes: [], refreshCalls: 0 };
  return {
    state,
    readTokens: async () => ({ ok: true, value: { ...state.disk } }),
    writeTokens: async (t) => {
      state.writes.push(t);
      if (writeResult.ok) state.disk = { ...t };
      return writeResult;
    },
    refreshTokens:
      refresh ??
      (async () => {
        state.refreshCalls++;
        return { accessToken: "at2", refreshToken: "rt2", scopes: [], expiresIn: 14400 };
      }),
    sleepImpl: async () => {},
  };
}

describe("createTokenManager", () => {
  it("load → 找不到 token 檔給可動作錯誤", async () => {
    const tm = createTokenManager({ readTokens: async () => ({ ok: true, value: null }) });
    await expect(tm.load()).rejects.toThrow(/auth/);
  });

  it("withAuth：無 401 直接回傳，clientId 可取得", async () => {
    const deps = makeDeps();
    const tm = createTokenManager(deps);
    const r = await tm.withAuth((token) => `ok:${token}`);
    expect(r).toBe("ok:at1");
    expect(tm.clientId).toBe("cid");
    expect(deps.state.refreshCalls).toBe(0);
  });

  it("withAuth：401 → refresh → 用新 token 重試一次", async () => {
    const deps = makeDeps();
    const tm = createTokenManager(deps);
    let calls = 0;
    const r = await tm.withAuth((token) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("401"), { status: 401 });
      return `ok:${token}`;
    });
    expect(r).toBe("ok:at2");
    expect(deps.state.refreshCalls).toBe(1);
    expect(deps.state.writes.at(-1).refreshToken).toBe("rt2"); // 新 token 已落地
  });

  it("process 內 single-flight：並發多個 401 只 refresh 一次", async () => {
    const deps = makeDeps();
    const tm = createTokenManager(deps);
    // 三個頻道同時打，第一次都拿 at1 撞 401
    const results = await Promise.all([
      tm.withAuth((t) => (t === "at1" ? Promise.reject(Object.assign(new Error("401"), { status: 401 })) : t)),
      tm.withAuth((t) => (t === "at1" ? Promise.reject(Object.assign(new Error("401"), { status: 401 })) : t)),
      tm.withAuth((t) => (t === "at1" ? Promise.reject(Object.assign(new Error("401"), { status: 401 })) : t)),
    ]);
    expect(results).toEqual(["at2", "at2", "at2"]);
    expect(deps.state.refreshCalls).toBe(1); // 關鍵：只 refresh 一次
  });

  it("跨 process：refresh 前重讀發現別人已 refresh → 不再自己 refresh", async () => {
    const deps = makeDeps();
    // 模擬：load 後別的 process 已把磁碟換成 at2/rt2
    let reads = 0;
    deps.readTokens = async () => {
      reads++;
      // 第一次 load 給舊的；之後（refresh 前重讀）給新的
      return { ok: true, value: reads === 1 ? { ...BASE } : { ...BASE, accessToken: "at2", refreshToken: "rt2" } };
    };
    const tm = createTokenManager(deps);
    let calls = 0;
    const r = await tm.withAuth((token) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("401"), { status: 401 });
      return token;
    });
    expect(r).toBe("at2");
    expect(deps.state.refreshCalls).toBe(0); // 重讀就撿到，沒自己 refresh
  });

  it("輸家：refresh 撞 invalid_grant → 重試重讀撿到贏家寫的新 token", async () => {
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("invalid refresh token");
      },
    });
    let reads = 0;
    deps.readTokens = async () => {
      reads++;
      // load=舊；refresh 前重讀=舊（還沒人寫）；重試迴圈第 2 次=贏家已寫新的
      const fresh = reads >= 3;
      return {
        ok: true,
        value: fresh ? { ...BASE, accessToken: "at2", refreshToken: "rt2" } : { ...BASE },
      };
    };
    const tm = createTokenManager(deps);
    let calls = 0;
    const r = await tm.withAuth((token) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("401"), { status: 401 });
      return token;
    });
    expect(r).toBe("at2");
  });

  it("重試預算耗盡 → fail loud 請重新授權", async () => {
    const deps = makeDeps({
      refresh: async () => {
        throw new Error("invalid refresh token");
      },
    });
    // 磁碟永遠是舊的（沒有贏家來救）
    deps.readTokens = async () => ({ ok: true, value: { ...BASE } });
    const tm = createTokenManager({ ...deps, rereadAttempts: 3 });
    await expect(
      tm.withAuth((token) => {
        if (token === "at1") throw Object.assign(new Error("401"), { status: 401 });
        return token;
      }),
    ).rejects.toThrow(/重新執行 auth/);
  });

  it("refresh 成功但寫檔失敗 → fail loud（refresh token 已被消耗）", async () => {
    const deps = makeDeps({ writeResult: { ok: false, error: "磁碟唯讀" } });
    const tm = createTokenManager(deps);
    await expect(
      tm.withAuth((token) => {
        if (token === "at1") throw Object.assign(new Error("401"), { status: 401 });
        return token;
      }),
    ).rejects.toThrow(/寫入失敗/);
  });

  it("非 401 錯誤 → 直接拋出，不 refresh", async () => {
    const deps = makeDeps();
    const tm = createTokenManager(deps);
    await expect(
      tm.withAuth(() => {
        throw Object.assign(new Error("500"), { status: 500 });
      }),
    ).rejects.toThrow("500");
    expect(deps.state.refreshCalls).toBe(0);
  });
});
