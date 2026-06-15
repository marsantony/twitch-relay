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

function baseline(match) {
  return diffSnapshot(emptyState(), { matches: [match] }).nextState;
}

describe("diffSnapshot — 進球用比分觸發", () => {
  it("首見比賽當基線：不播報、比分入基線", () => {
    const snap = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const { events, nextState } = diffSnapshot(emptyState(), snap);
    expect(events).toEqual([]);
    expect(nextState.matches.m1.homeScore).toBe(1);
  });

  it("比分增加 → 播一次進球（含得分者與正確比分）；同快照再 diff 不重播", () => {
    const s1 = baseline(makeMatch());
    const withGoal = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const r2 = diffSnapshot(s1, withGoal);
    const goals = r2.events.filter((e) => e.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].side).toBe("home");
    expect(goals[0].athlete).toBe("球員A");
    expect(goals[0].match.homeScore).toBe(1);

    const r3 = diffSnapshot(r2.nextState, withGoal); // 比分沒再變
    expect(r3.events.filter((e) => e.kind === "goal")).toEqual([]);
  });

  it("比分晚到：事件先出現(比分未動)不播 → 比分追上才播並掛上得分者", () => {
    const s1 = baseline(makeMatch()); // 0-0
    // poll A：進球事件已在 details，但官方比分還是 0-0（ESPN 晚到）
    const eventFirst = { matches: [makeMatch({ home: 0, events: [goalEvent("k1")] })] };
    const rA = diffSnapshot(s1, eventFirst);
    expect(rA.events.filter((e) => e.kind === "goal")).toEqual([]); // 不播

    // poll B：比分追上 1-0
    const scoreCaughtUp = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const rB = diffSnapshot(rA.nextState, scoreCaughtUp);
    const goals = rB.events.filter((e) => e.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].athlete).toBe("球員A"); // 得分者撈得到
    expect(goals[0].match.homeScore).toBe(1);
  });

  it("重播免疫：比分不變、但事件 key 被 ESPN 改 → 不重播", () => {
    const s1 = baseline(makeMatch());
    const r2 = diffSnapshot(s1, { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] });
    expect(r2.events.filter((e) => e.kind === "goal")).toHaveLength(1);
    // 下一次 poll：比分仍 1-0，但同一顆進球被 ESPN re-key 成 k2
    const r3 = diffSnapshot(r2.nextState, {
      matches: [makeMatch({ home: 1, events: [goalEvent("k2")] })],
    });
    expect(r3.events.filter((e) => e.kind === "goal")).toEqual([]); // 比分沒變就不播
  });

  it("客隊進球 → side=away", () => {
    const s1 = baseline(makeMatch());
    const r = diffSnapshot(s1, {
      matches: [makeMatch({ away: 1, events: [goalEvent("k1", { teamId: "a", athlete: "客員B" })] })],
    });
    const goals = r.events.filter((e) => e.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].side).toBe("away");
    expect(goals[0].athlete).toBe("客員B");
  });

  it("一個 poll 內比分 +2（兩球）→ 播兩則", () => {
    const s1 = baseline(makeMatch());
    const r = diffSnapshot(s1, {
      matches: [
        makeMatch({ home: 2, events: [goalEvent("k1", { athlete: "A" }), goalEvent("k2", { athlete: "B" })] }),
      ],
    });
    expect(r.events.filter((e) => e.kind === "goal")).toHaveLength(2);
  });

  it("撈不到得分者事件（比分先到）→ 仍播進球、掛得分隊名、athlete 空", () => {
    const s1 = baseline(makeMatch());
    const r = diffSnapshot(s1, { matches: [makeMatch({ home: 1, events: [] })] });
    const goals = r.events.filter((e) => e.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].athlete).toBe("");
    expect(goals[0].scoringTeamName).toBe("主隊");
  });

  it("VAR 取消：比分減少 → goalCancelled", () => {
    const s1 = baseline(makeMatch({ home: 1, events: [goalEvent("k1")] })); // 基線 1-0
    const r = diffSnapshot(s1, { matches: [makeMatch({ home: 0, events: [] })] });
    expect(r.events.some((e) => e.kind === "goalCancelled" && e.side === "home")).toBe(true);
  });
});

describe("diffSnapshot — 紅黃牌仍用事件 key", () => {
  it("黃牌 → card；換人(非進球非牌)不播", () => {
    const s1 = baseline(makeMatch());
    const next = {
      matches: [
        makeMatch({
          events: [cardEvent("k-card"), goalEvent("k-sub", { scoringPlay: false, typeText: "Substitution" })],
        }),
      ],
    };
    const r = diffSnapshot(s1, next);
    expect(r.events.filter((e) => e.kind === "card")).toHaveLength(1);
  });

  it("同一張牌 key 不變 → 不重播", () => {
    const s1 = baseline(makeMatch());
    const snap = { matches: [makeMatch({ events: [cardEvent("kc")] })] };
    const r2 = diffSnapshot(s1, snap);
    expect(r2.events.filter((e) => e.kind === "card")).toHaveLength(1);
    const r3 = diffSnapshot(r2.nextState, snap);
    expect(r3.events.filter((e) => e.kind === "card")).toEqual([]);
  });
});

describe("diffSnapshot — 狀態與其他", () => {
  it("狀態轉換 pre→in、in→post", () => {
    const s1 = baseline(makeMatch({ state: "pre", name: "STATUS_SCHEDULED" }));
    const r2 = diffSnapshot(s1, { matches: [makeMatch({ state: "in", name: "STATUS_FIRST_HALF" })] });
    expect(r2.events).toContainEqual(
      expect.objectContaining({ kind: "status", prevState: "pre", newState: "in" }),
    );
    const r3 = diffSnapshot(r2.nextState, {
      matches: [makeMatch({ state: "post", name: "STATUS_FULL_TIME", home: 0 })],
    });
    expect(r3.events.find((e) => e.kind === "status").newState).toBe("post");
  });

  it("state 經 JSON 序列化重啟後不重播", () => {
    const withGoal = { matches: [makeMatch({ home: 1, events: [goalEvent("k1")] })] };
    const s1 = diffSnapshot(emptyState(), withGoal).nextState; // 基線 1-0
    const restored = JSON.parse(JSON.stringify(s1));
    const r = diffSnapshot(restored, withGoal);
    expect(r.events.filter((e) => e.kind === "goal")).toEqual([]);
  });

  it("多場比賽互不干擾", () => {
    const both = {
      matches: [makeMatch({ id: "m1" }), makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" })],
    };
    const s1 = diffSnapshot(emptyState(), both).nextState;
    const r = diffSnapshot(s1, {
      matches: [
        makeMatch({ id: "m1", home: 1, events: [goalEvent("g")] }),
        makeMatch({ id: "m2", state: "pre", name: "STATUS_SCHEDULED" }),
      ],
    });
    const goals = r.events.filter((e) => e.kind === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0].match.homeName).toBe("主隊");
  });
});
