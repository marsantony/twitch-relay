import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../src/util/json-file.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "twitch-relay-"));
}

describe("json-file", () => {
  it("檔案不存在 → ok 且 value 為 null（不是錯誤）", async () => {
    const dir = await tempDir();
    const r = await readJsonFile(join(dir, "nope.json"));
    expect(r).toEqual({ ok: true, value: null });
  });

  it("寫入後可讀回相同內容", async () => {
    const dir = await tempDir();
    const file = join(dir, "sub", "data.json"); // 上層目錄不存在也要能寫
    const data = { a: 1, nested: { b: "x" } };
    const w = await writeJsonFileAtomic(file, data);
    expect(w.ok).toBe(true);
    const r = await readJsonFile(file);
    expect(r).toEqual({ ok: true, value: data });
  });

  it("預設權限 600", async () => {
    const dir = await tempDir();
    const file = join(dir, "secret.json");
    await writeJsonFileAtomic(file, { token: "x" });
    const s = await stat(file);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("壞 JSON → ok: false，錯誤訊息指出檔案路徑", async () => {
    const dir = await tempDir();
    const file = join(dir, "broken.json");
    await writeFile(file, "{ 半寫的檔案");
    const r = await readJsonFile(file);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(file);
  });
});
