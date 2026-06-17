import { describe, it, expect } from "vitest";
import { diffSnapshot, emptyState } from "../src/core/diff.js";

function makeMatch({
  id = "m1",
  state = "in",
  name = "STATUS_FIRST_HALF",
  clock = "10'",
  home = 0,
  away = 0,
  events = [],
} = {}) {
  return {
    id,
    statusState: state,
    statusName: name,
    displayClock: clock,
    home: { id: "h", name: "主隊", score: home },
    away: { id: "a", name: "客隊", score: away },
    events,
  };
}

// 進球事件（只有 scoringPlay 與 key 重要；得分者欄位已不使用）
function goalEvent(key) {
  return { key, scoringPlay: true, yellowCard: false, redCard: false };
}
function cardEvent(key) {
  return { key, scoringPlay: false, yellowCard: true, redCard: false, clockDisplay: "20'", athlete: "X" };
}
// n 顆進球事件（讓 score 與事件數自洽）
function goals(n) {
  return Array.from({ length: n }, (_, i) => goalEvent("g" + i));
}

function baseline(match) {
  return diffSnapshot(emptyState(), { matches: [match] }).nextState;
}
function goalsOf(r) {
  return r.events.filter((e) => e.kind === "goal");
}

describe("diffSnapshot — 進球（比分觸發、不掛得分者）", () => {
  it("首見比賽當基線：不播報", () => {
    const r = diffSnapshot(emptyState(), { matches: [makeMatch({ home: 1, events: goals(1) })] });
    expect(r.events).toEqual([]);
    expect(r.nextState.matches.m1.homeScore).toBe(1);
  });

  it("自洽且比分上升 → 播一則進球（只帶得分隊+比分，無得分者）；同快照不重播", () => {
    const s1 = baseline(makeMatch());
    const snap = { matches: [makeMatch({ home: 1, events: goals(1) })] };
    const r2 = diffSnapshot(s1, snap);
    expect(goalsOf(r2)).toHaveLength(1);
    expect(r2.events[0]).toMatchObject({ kind: "goal", side: "home", scoringTeamName: "主隊" });
    expect(r2.events[0].athlete).toBeUndefined(); // 不掛得分者
    expect(r2.events[0].match.homeScore).toBe(1);
    expect(goalsOf(diffSnapshot(r2.nextState, snap))).toEqual([]); // 比分沒變不重播
  });

  it("不自洽（比分歸 0 但事件還在）→ 不播、沿用 confirmed；彈回後也不補播", () => {
    const s1 = baseline(makeMatch({ home: 1, away: 1, events: goals(2) })); // 基線 1-1, 2 事件
    // 抖動：比分 0-0 但 2 個進球事件還在 → total 0 ≠ count 2 → 不自洽
    const glitch = { matches: [makeMatch({ home: 0, away: 0, events: goals(2) })] };
    const rG = diffSnapshot(s1, glitch);
    expect(rG.events).toEqual([]); // 不播取消、不播進球
    expect(rG.nextState.matches.m1.homeScore).toBe(1); // 沿用 confirmed
    expect(rG.nextState.matches.m1.awayScore).toBe(1);
    // 彈回 1-1（== confirmed）→ 無事
    const rBack = diffSnapshot(rG.nextState, { matches: [makeMatch({ home: 1, away: 1, events: goals(2) })] });
    expect(rBack.events).toEqual([]);
  });

  it("全清空型抖動（0-0 且事件也空，湊巧自洽）→ 形狀守門擋掉（兩隊降）", () => {
    const s1 = baseline(makeMatch({ home: 1, away: 1, events: goals(2) }));
    const reset = { matches: [makeMatch({ home: 0, away: 0, events: [] })] }; // 0==0 自洽，但降 2 球
    const r = diffSnapshot(s1, reset);
    expect(r.events).toEqual([]); // 不播
    expect(r.nextState.matches.m1.homeScore).toBe(1); // 沿用 confirmed
  });

  it("真 VAR：單側剛好 -1 且自洽 → 播 goalCancelled", () => {
    const s1 = baseline(makeMatch({ home: 2, away: 1, events: goals(3) })); // 基線 2-1, 3 事件
    const var1 = { matches: [makeMatch({ home: 1, away: 1, events: goals(2) })] }; // 1-1, 2 事件，降 1
    const r = diffSnapshot(s1, var1);
    expect(r.events.some((e) => e.kind === "goalCancelled" && e.side === "home")).toBe(true);
    expect(r.nextState.matches.m1.homeScore).toBe(1);
  });

  it("比分晚到：事件先到(不自洽)不播 → 比分追上(自洽)才播", () => {
    const s1 = baseline(makeMatch()); // 0-0, 0 事件
    const eventFirst = { matches: [makeMatch({ home: 0, events: goals(1) })] }; // 0 分但 1 事件 → 不自洽
    const rA = diffSnapshot(s1, eventFirst);
    expect(goalsOf(rA)).toEqual([]);
    const scoreUp = { matches: [makeMatch({ home: 1, events: goals(1) })] }; // 1 分 1 事件 → 自洽
    const rB = diffSnapshot(rA.nextState, scoreUp);
    expect(goalsOf(rB)).toHaveLength(1);
  });

  it("一個 poll 內比分 +2（自洽）→ 播兩則", () => {
    const s1 = baseline(makeMatch());
    const r = diffSnapshot(s1, { matches: [makeMatch({ home: 2, events: goals(2) })] });
    expect(goalsOf(r)).toHaveLength(2);
  });

  it("客隊進球 → side=away、得分隊=客隊", () => {
    const s1 = baseline(makeMatch());
    const r = diffSnapshot(s1, { matches: [makeMatch({ away: 1, events: goals(1) })] });
    expect(goalsOf(r)[0]).toMatchObject({ side: "away", scoringTeamName: "客隊" });
  });

  it("state 經 JSON 序列化重啟後不重播", () => {
    const snap = { matches: [makeMatch({ home: 1, events: goals(1) })] };
    const s1 = diffSnapshot(emptyState(), snap).nextState;
    const restored = JSON.parse(JSON.stringify(s1));
    expect(goalsOf(diffSnapshot(restored, snap))).toEqual([]);
  });
});

describe("diffSnapshot — 紅黃牌（事件 key 觸發，與自洽性無關）", () => {
  it("黃牌 → card；同 key 不重播", () => {
    const s1 = baseline(makeMatch());
    const snap = { matches: [makeMatch({ events: [cardEvent("kc")] })] };
    const r2 = diffSnapshot(s1, snap);
    expect(r2.events.filter((e) => e.kind === "card")).toHaveLength(1);
    expect(diffSnapshot(r2.nextState, snap).events.filter((e) => e.kind === "card")).toEqual([]);
  });

  it("不自洽的 poll 仍照常處理紅黃牌", () => {
    const s1 = baseline(makeMatch({ home: 1, events: goals(1) })); // 1-0 自洽基線
    // 比分歸 0（不自洽）但同時來一張黃牌 → 牌照播、比分守住
    const snap = { matches: [makeMatch({ home: 0, events: [goalEvent("g0"), cardEvent("kc")] })] };
    const r = diffSnapshot(s1, snap);
    expect(r.events.filter((e) => e.kind === "card")).toHaveLength(1);
    expect(r.nextState.matches.m1.homeScore).toBe(1); // 比分沿用 confirmed
  });
});

describe("diffSnapshot — 狀態與多場", () => {
  it("狀態轉換 pre→in、in→post", () => {
    const s1 = baseline(makeMatch({ state: "pre", name: "STATUS_SCHEDULED" }));
    const r2 = diffSnapshot(s1, { matches: [makeMatch({ state: "in", name: "STATUS_FIRST_HALF" })] });
    expect(r2.events).toContainEqual(
      expect.objectContaining({ kind: "status", prevState: "pre", newState: "in" }),
    );
    const r3 = diffSnapshot(r2.nextState, {
      matches: [makeMatch({ state: "post", name: "STATUS_FULL_TIME" })],
    });
    expect(r3.events.find((e) => e.kind === "status").newState).toBe("post");
  });

  it("多場比賽互不干擾", () => {
    const both = {
      matches: [makeMatch({ id: "m1" }), makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" })],
    };
    const s1 = diffSnapshot(emptyState(), both).nextState;
    const r = diffSnapshot(s1, {
      matches: [
        makeMatch({ id: "m1", home: 1, events: goals(1) }),
        makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" }),
      ],
    });
    expect(goalsOf(r)).toHaveLength(1);
    expect(goalsOf(r)[0].match.homeName).toBe("主隊");
  });
});
