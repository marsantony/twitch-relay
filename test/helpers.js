// 測試共用：mock fetch 回應與序列。
export function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 依序回傳預錄回應的 fetch stub；Error 項目會被 throw（模擬連線失敗）。 */
export function sequenceFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error("sequenceFetch：沒有預錄的回應了");
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
