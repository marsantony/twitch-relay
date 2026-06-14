import { describe, it, expect } from "vitest";
import {
  normalizeScoreboard,
  createEspnSource,
  eventKey,
  dateStr,
  dateRange,
} from "../src/sources/espn.js";
import { jsonResponse, sequenceFetch } from "./helpers.js";

// 依 2026-06-12 對 ESPN 實測的回應結構縮減而成（見 tasks/research.md）
const RAW = {
  events: [
    {
      id: "1001",
      status: { displayClock: "60'", type: { state: "in", name: "STATUS_SECOND_HALF" } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", score: "1", team: { id: "360", displayName: "Manchester United" } },
            { homeAway: "away", score: "0", team: { id: "331", displayName: "Brighton" } },
          ],
          details: [
            {
              type: { id: "137", text: "Goal - Header" },
              clock: { value: 1973.0, displayValue: "33'" },
              team: { id: "360" },
              scoreValue: 1,
              scoringPlay: true,
              redCard: false,
              yellowCard: false,
              penaltyKick: false,
              ownGoal: false,
              shootout: false,
              athletesInvolved: [{ id: "366781", displayName: "Patrick Dorgu", jersey: "13" }],
            },
            {
              type: { id: "94", text: "Yellow Card" },
              clock: { value: 2700.0, displayValue: "45'+3'" },
              team: { id: "360" },
              yellowCard: true,
              athletesInvolved: [{ id: "328466", displayName: "Kobbie Mainoo" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("normalizeScoreboard", () => {
  it("正規化比賽與事件", () => {
    const snap = normalizeScoreboard(RAW);
    expect(snap.matches).toHaveLength(1);
    const m = snap.matches[0];
    expect(m.id).toBe("1001");
    expect(m.statusState).toBe("in");
    expect(m.statusName).toBe("STATUS_SECOND_HALF");
    expect(m.home).toEqual({ id: "360", name: "Manchester United", score: 1 });
    expect(m.away).toEqual({ id: "331", name: "Brighton", score: 0 });
    expect(m.events).toHaveLength(2);
    const [goal, card] = m.events;
    expect(goal.scoringPlay).toBe(true);
    expect(goal.athlete).toBe("Patrick Dorgu");
    expect(goal.clockDisplay).toBe("33'");
    expect(card.yellowCard).toBe(true);
  });

  it("事件 key = 比賽:類別:分鐘:球員（用穩定欄位，不用會被修訂的秒數/typeId）", () => {
    const snap = normalizeScoreboard(RAW);
    // 進球：category=goal、分鐘 33'、球員 366781（不含 typeId 137、不含秒數 1973）
    expect(snap.matches[0].events[0].key).toBe("1001:goal:33':366781");
    // 黃牌：category=yellow
    expect(snap.matches[0].events[1].key).toBe("1001:yellow:45'+3':328466");
  });

  it("秒數被 ESPN 修訂但分鐘不變 → key 不變（修正重播 bug 的核心）", () => {
    const goalAtSec = (sec) => ({
      type: { id: "70" },
      clock: { value: sec, displayValue: "21'" },
      scoringPlay: true,
      athletesInvolved: [{ id: "317285" }],
    });
    expect(eventKey("m", goalAtSec(1230))).toBe(eventKey("m", goalAtSec(1244)));
  });

  it("進球被重新分類 Goal↔Goal-Header → key 不變（category 取代 typeId）", () => {
    const base = { clock: { displayValue: "38'" }, scoringPlay: true, athletesInvolved: [{ id: "286828" }] };
    const asGoal = eventKey("m", { ...base, type: { id: "70" } });
    const asHeader = eventKey("m", { ...base, type: { id: "137" } });
    expect(asGoal).toBe(asHeader);
  });

  it("同球員不同分鐘（梅開二度）→ 不同 key（不會誤刪第二球）", () => {
    const goalAt = (min) => ({
      clock: { displayValue: min },
      scoringPlay: true,
      athletesInvolved: [{ id: "999" }],
    });
    expect(eventKey("m", goalAt("21'"))).not.toBe(eventKey("m", goalAt("67'")));
  });

  it("缺 athletesInvolved / clock 時 fallback 不丟例外", () => {
    expect(eventKey("1", { yellowCard: true })).toBe("1:yellow:?:na");
  });

  it("空 scoreboard → 空 matches", () => {
    expect(normalizeScoreboard({})).toEqual({ matches: [] });
  });
});

describe("日期範圍（ESPN 預設 scoreboard 釘在過期日期的修正）", () => {
  it("dateStr 補零", () => {
    expect(dateStr(new Date(2026, 5, 14))).toBe("20260614"); // 月份 0-based，5=六月
    expect(dateStr(new Date(2026, 0, 3))).toBe("20260103");
  });

  it("dateRange 預設 ±1 天，給出 <昨>-<明>", () => {
    expect(dateRange(new Date(2026, 5, 14))).toBe("20260613-20260615");
  });

  it("dateRange 跨月正確進位", () => {
    expect(dateRange(new Date(2026, 6, 1))).toBe("20260630-20260702"); // 6/30 - 7/2
    expect(dateRange(new Date(2026, 0, 1))).toBe("20251231-20260102"); // 跨年
  });
});

describe("createEspnSource", () => {
  const FIXED_NOW = () => new Date(2026, 5, 14);

  it("成功 → ok + snapshot，URL 帶滾動日期範圍", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(200, RAW)]);
    const source = createEspnSource({ league: "fifa.world", fetchImpl, now: FIXED_NOW });
    const r = await source.fetchSnapshot();
    expect(r.ok).toBe(true);
    expect(r.value.matches).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toContain("/soccer/fifa.world/scoreboard");
    expect(fetchImpl.calls[0].url).toContain("?dates=20260613-20260615"); // 不再抓過期預設
  });

  it("連線失敗 → ok: false，不丟例外", async () => {
    const fetchImpl = sequenceFetch([new Error("ECONNRESET")]);
    const source = createEspnSource({ league: "fifa.world", fetchImpl });
    const r = await source.fetchSnapshot();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNRESET");
  });

  it("HTTP 503 → ok: false", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(503, {})]);
    const source = createEspnSource({ league: "fifa.world", fetchImpl });
    const r = await source.fetchSnapshot();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("503");
  });
});
