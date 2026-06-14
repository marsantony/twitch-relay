// ESPN 非官方 scoreboard API。league 例：fifa.world（世足）、eng.1（英超）、usa.1（MLS）。
// 非官方、無 SLA——本模組把 ESPN 原始結構正規化成 snapshot，隔離上游變動；
// 換資料源時只需要再寫一個回傳同形 snapshot 的 source。
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ESPN 預設 scoreboard（不帶 dates）會被釘在某個過期日期（實測落後本地約一天），
// 導致看不到當日 live 比賽。改抓滾動日期範圍 <昨>-<明> 穩定涵蓋此刻在踢的比賽，
// 不受 ESPN 日期錨點偏移影響；窗口內已完賽的比賽由 diff 引擎靜默基線、不回放。
export function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function dateRange(now, backDays = 1, fwdDays = 1) {
  const start = new Date(now);
  start.setDate(start.getDate() - backDays);
  const end = new Date(now);
  end.setDate(end.getDate() + fwdDays);
  return `${dateStr(start)}-${dateStr(end)}`;
}

// ESPN 的 details 事件沒有 id，自行合成去重 key。
// 只用「ESPN 不會回頭修訂」的欄位當身分：分鐘顯示 + 事件類別 + 球員。
// 不用 clock.value（秒數會被 ESPN 修訂，曾造成同一進球重播）、
// 也不用 type.id（Goal 70 ↔ Goal-Header 137 會被重新分類，同樣會變 key）。
export function eventKey(matchId, detail) {
  const athleteId = detail.athletesInvolved?.[0]?.id ?? "na";
  const minute = detail.clock?.displayValue ?? "?";
  let category;
  if (detail.scoringPlay) category = "goal";
  else if (detail.redCard) category = "red";
  else if (detail.yellowCard) category = "yellow";
  else category = detail.type?.id ?? "other"; // 其他類型（換人等）沿用 typeId
  return `${matchId}:${category}:${minute}:${athleteId}`;
}

export function normalizeScoreboard(raw) {
  const matches = (raw.events ?? []).map((event) => {
    const comp = event.competitions?.[0] ?? {};
    const side = (homeAway) => {
      const c = comp.competitors?.find((x) => x.homeAway === homeAway) ?? {};
      return {
        id: c.team?.id,
        name: c.team?.displayName ?? "?",
        score: Number(c.score ?? 0),
      };
    };
    const events = (comp.details ?? []).map((d) => ({
      key: eventKey(event.id, d),
      typeId: d.type?.id,
      typeText: d.type?.text ?? "",
      clockDisplay: d.clock?.displayValue ?? "",
      teamId: d.team?.id,
      scoringPlay: Boolean(d.scoringPlay),
      yellowCard: Boolean(d.yellowCard),
      redCard: Boolean(d.redCard),
      penaltyKick: Boolean(d.penaltyKick),
      ownGoal: Boolean(d.ownGoal),
      shootout: Boolean(d.shootout),
      athlete: d.athletesInvolved?.[0]?.displayName ?? "",
    }));
    return {
      id: event.id,
      statusState: event.status?.type?.state ?? "pre", // pre | in | post
      statusName: event.status?.type?.name ?? "", // STATUS_HALFTIME 等
      displayClock: event.status?.displayClock ?? "",
      home: side("home"),
      away: side("away"),
      events,
    };
  });
  return { matches };
}

export function createEspnSource({
  league,
  fetchImpl = fetch,
  timeoutMs = 10000,
  now = () => new Date(),
}) {
  const base = `${BASE}/${league}/scoreboard`;
  return {
    async fetchSnapshot() {
      // 每次 poll 用當下時間重算範圍 → 自動跟著日期滾動，跨午夜不卡住
      const url = `${base}?dates=${dateRange(now())}`;
      let res;
      try {
        // 加 timeout：長跑 poller 若連線 hang 住，fetch 不會 resolve，backoff 也救不了
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        return { ok: false, error: `ESPN 連線失敗：${err.message}` };
      }
      if (!res.ok) return { ok: false, error: `ESPN 回應 ${res.status}` };
      let raw;
      try {
        raw = await res.json();
      } catch {
        return { ok: false, error: "ESPN 回應不是合法 JSON" };
      }
      return { ok: true, value: normalizeScoreboard(raw) };
    },
  };
}
