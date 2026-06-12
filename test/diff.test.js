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

function goalEvent(key, overrides = {}) {
  return {
    key,
    typeId: "70",
    typeText: "Goal",
    clockDisplay: "12'",
    teamId: "h",
    scoringPlay: true,
    yellowCard: false,
    redCard: false,
    penaltyKick: false,
    ownGoal: false,
    shootout: false,
    athlete: "球員A",
    ...overrides,
  };
}

function cardEvent(key, overrides = {}) {
  return goalEvent(key, { scoringPlay: false, yellowCard: true, typeId: "94", ...overrides });
}

describe("diffSnapshot", () => {
  it("首次看到的比賽當基線：事件進 seen、不播報（寧漏播不洗版）", () => {
    const snap = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const { events, nextState } = diffSnapshot(emptyState(), snap);
    expect(events).toEqual([]);
    expect(nextState.seenEventKeys.k1).toBe(true);
  });

  it("基線後出現新進球 → 播報一次，再 diff 同樣快照不重播", () => {
    const base = { matches: [makeMatch()] };
    const s1 = diffSnapshot(emptyState(), base).nextState;

    const withGoal = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const r2 = diffSnapshot(s1, withGoal);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe("goal");
    expect(r2.events[0].match.homeScore).toBe(1);

    const r3 = diffSnapshot(r2.nextState, withGoal);
    expect(r3.events).toEqual([]);
  });

  it("事件消失後再出現也不重播（ESPN CDN 抖動防護）", () => {
    const withGoal = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const without = { matches: [makeMatch({ home: 1, events: [] })] };
    const s1 = diffSnapshot(emptyState(), withGoal).nextState;
    const r2 = diffSnapshot(s1, without);
    expect(r2.warnings.some((w) => w.includes("k1"))).toBe(true); // 消失 → warning
    const r3 = diffSnapshot(r2.nextState, withGoal); // 又出現
    expect(r3.events).toEqual([]); // seen 是 append-only，不重播
  });

  it("黃牌 → card 事件；非進球非牌的事件不播報", () => {
    const base = { matches: [makeMatch()] };
    const s1 = diffSnapshot(emptyState(), base).nextState;
    const next = {
      matches: [
        makeMatch({
          events: [
            cardEvent("k-card"),
            goalEvent("k-sub", { scoringPlay: false, typeText: "Substitution" }),
          ],
        }),
      ],
    };
    const r = diffSnapshot(s1, next);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe("card");
  });

  it("狀態轉換 pre→in 與 in→post → status 事件", () => {
    const pre = { matches: [makeMatch({ state: "pre", name: "STATUS_SCHEDULED" })] };
    const s1 = diffSnapshot(emptyState(), pre).nextState;

    const live = { matches: [makeMatch({ state: "in", name: "STATUS_FIRST_HALF" })] };
    const r2 = diffSnapshot(s1, live);
    expect(r2.events).toEqual([
      expect.objectContaining({ kind: "status", prevState: "pre", newState: "in" }),
    ]);

    const done = { matches: [makeMatch({ state: "post", name: "STATUS_FULL_TIME", home: 2 })] };
    const r3 = diffSnapshot(r2.nextState, done);
    const statusEv = r3.events.find((e) => e.kind === "status");
    expect(statusEv.newState).toBe("post");
  });

  it("比分變化但無新進球事件 → warning（資料異常訊號）", () => {
    const s1 = diffSnapshot(emptyState(), { matches: [makeMatch({ home: 0 })] }).nextState;
    const r = diffSnapshot(s1, { matches: [makeMatch({ home: 1 })] });
    expect(r.warnings.some((w) => w.includes("比分變化但無對應進球事件"))).toBe(true);
  });

  it("state 經 JSON 序列化重啟後不重播（持久化重建）", () => {
    const withGoal = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const s1 = diffSnapshot(emptyState(), withGoal).nextState;
    const restored = JSON.parse(JSON.stringify(s1)); // 模擬寫檔再讀回
    const r = diffSnapshot(restored, withGoal);
    expect(r.events).toEqual([]);
  });

  it("多場比賽互不干擾", () => {
    const both = {
      matches: [makeMatch({ id: "m1" }), makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" })],
    };
    const s1 = diffSnapshot(emptyState(), both).nextState;
    const next = {
      matches: [
        makeMatch({ id: "m1", home: 1, events: [goalEvent("m1:goal")] }),
        makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" }),
      ],
    };
    const r = diffSnapshot(s1, next);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].match.homeName).toBe("主隊");
  });
});
