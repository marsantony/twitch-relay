// ESPN 非官方 scoreboard API。league 例：fifa.world（世足）、eng.1（英超）、usa.1（MLS）。
// 非官方、無 SLA——本模組把 ESPN 原始結構正規化成 snapshot，隔離上游變動；
// 換資料源時只需要再寫一個回傳同形 snapshot 的 source。
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// ESPN 的 details 事件沒有 id，自行合成去重 key
export function eventKey(matchId, detail) {
  const athleteId = detail.athletesInvolved?.[0]?.id ?? "na";
  return `${matchId}:${detail.type?.id}:${detail.clock?.value}:${athleteId}`;
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

export function createEspnSource({ league, fetchImpl = fetch, timeoutMs = 10000 }) {
  const url = `${BASE}/${league}/scoreboard`;
  return {
    async fetchSnapshot() {
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
