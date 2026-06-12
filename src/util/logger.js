// 統一的 console logger，時間戳用 sv-SE（YYYY-MM-DD HH:mm:ss）。
export function createLogger({ out = console } = {}) {
  const ts = () => new Date().toLocaleString("sv-SE");
  return {
    info: (msg) => out.log(`${ts()} ${msg}`),
    warn: (msg) => out.warn(`${ts()} ⚠️ ${msg}`),
    error: (msg) => out.error(`${ts()} ❌ ${msg}`),
  };
}
