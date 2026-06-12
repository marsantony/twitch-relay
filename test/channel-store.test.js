import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelsFileFor,
  loadChannels,
  addChannel,
  removeChannel,
} from "../src/channels/store.js";

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), "twitch-relay-ch-"));
  return join(dir, "channels.json");
}

describe("channelsFileFor", () => {
  it("檔名跟著 config 名走（per-config）", () => {
    const a = channelsFileFor("configs/worldcup2026.json");
    const b = channelsFileFor("/x/y/premier.json");
    expect(a).toMatch(/channels-worldcup2026\.json$/);
    expect(b).toMatch(/channels-premier\.json$/);
  });
});

describe("loadChannels", () => {
  it("檔案不存在 → 空陣列（非錯誤）", async () => {
    const r = await loadChannels(await tempFile());
    expect(r).toEqual({ ok: true, value: [] });
  });
});

describe("addChannel / removeChannel", () => {
  it("新增後可讀回，存 login 與 id", async () => {
    const file = await tempFile();
    const r = await addChannel({ login: "alice", id: "111" }, file);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ login: "alice", id: "111" }]);
    const back = await loadChannels(file);
    expect(back.value).toEqual([{ login: "alice", id: "111" }]);
  });

  it("重複新增（大小寫不敏感）→ 不重複，回 already", async () => {
    const file = await tempFile();
    await addChannel({ login: "Alice", id: "111" }, file);
    const r = await addChannel({ login: "alice", id: "111" }, file);
    expect(r.already).toBe(true);
    expect(r.value).toHaveLength(1);
  });

  it("移除（大小寫不敏感）", async () => {
    const file = await tempFile();
    await addChannel({ login: "alice", id: "111" }, file);
    await addChannel({ login: "bob", id: "222" }, file);
    const r = await removeChannel("ALICE", file);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ login: "bob", id: "222" }]);
  });

  it("移除不存在的頻道 → 回 missing，清單不變", async () => {
    const file = await tempFile();
    await addChannel({ login: "alice", id: "111" }, file);
    const r = await removeChannel("ghost", file);
    expect(r.missing).toBe(true);
    expect(r.value).toHaveLength(1);
  });
});
