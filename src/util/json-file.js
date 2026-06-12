// JSON 檔案讀寫的共用 IO 層。回傳三態 Result：
// { ok: true, value }（讀到）/ { ok: true, value: null }（檔案不存在）/ { ok: false, error }
// 寫入一律 tmp + rename 原子完成，避免程序中斷留下半寫檔案。
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export async function readJsonFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, value: null };
    return { ok: false, error: `讀取 ${filePath} 失敗：${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: `${filePath} 不是合法 JSON，請手動處理（備份後刪除）` };
  }
}

export async function writeJsonFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const tmpPath = `${filePath}.tmp`;
  try {
    await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode });
    await fs.rename(tmpPath, filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `寫入 ${filePath} 失敗：${err.message}` };
  }
}
