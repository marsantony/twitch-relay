import { describe, it, expect } from "vitest";
import { createFormatter } from "../src/format/soccer-zh.js";

const match = { homeName: "墨西哥", awayName: "南非", homeScore: 1, awayScore: 0, displayClock: "33'" };

function goal(overrides = {}) {
  return {
    kind: "goal",
    clockDisplay: "33'",
    typeText: "Goal",
    athlete: "球員A",
    penaltyKick: false,
    ownGoal: false,
    shootout: false,
    redCard: false,
    yellowCard: false,
    match,
    ...overrides,
  };
}

describe("soccer-zh formatter", () => {
  const format = createFormatter();

  it("一般進球", () => {
    expect(format(goal())).toBe("⚽ 33' 進球！墨西哥 1-0 南非（球員A）");
  });

  it("頭球 / 12 碼 / 烏龍球 / PK 戰標記", () => {
    expect(format(goal({ typeText: "Goal - Header" }))).toContain("頭球");
    expect(format(goal({ penaltyKick: true }))).toContain("12 碼");
    expect(format(goal({ ownGoal: true }))).toContain("烏龍球");
    expect(format(goal({ penaltyKick: true, shootout: true }))).toContain("PK 戰");
  });

  it("撈不到得分者 → 掛得分隊名（比分仍正確）", () => {
    const noScorer = goal({ athlete: "", scoringTeamName: "墨西哥" });
    expect(format(noScorer)).toBe("⚽ 33' 進球！墨西哥 1-0 南非（墨西哥 得分）");
  });

  it("goalCancelled → 進球取消（VAR）含當下比分", () => {
    expect(format({ kind: "goalCancelled", match })).toBe("⚠️ 進球取消（VAR）墨西哥 1-0 南非");
  });

  it("黃牌與紅牌", () => {
    const card = goal({ kind: "card", yellowCard: true, scoringPlay: false, clockDisplay: "45'+3'" });
    expect(format(card)).toBe("🟨 黃牌 45'+3' 球員A｜墨西哥 vs 南非");
    expect(format({ ...card, yellowCard: false, redCard: true })).toContain("🟥 紅牌");
  });

  it("狀態轉換：開賽 / 中場 / 下半場 / 完場", () => {
    const status = (prevState, newState, prevName, newName) => ({
      kind: "status",
      prevState,
      newState,
      prevName,
      newName,
      match,
    });
    expect(format(status("pre", "in", "STATUS_SCHEDULED", "STATUS_FIRST_HALF"))).toBe(
      "🏟️ 開賽！墨西哥 vs 南非",
    );
    expect(format(status("in", "in", "STATUS_FIRST_HALF", "STATUS_HALFTIME"))).toBe(
      "⏸️ 中場 墨西哥 1-0 南非",
    );
    expect(format(status("in", "in", "STATUS_HALFTIME", "STATUS_SECOND_HALF"))).toBe(
      "▶️ 下半場開始 墨西哥 1-0 南非",
    );
    expect(format(status("in", "post", "STATUS_SECOND_HALF", "STATUS_FULL_TIME"))).toBe(
      "🏁 完場 墨西哥 1-0 南非",
    );
  });

  it("未知狀態轉換不播報", () => {
    const ev = {
      kind: "status",
      prevState: "in",
      newState: "in",
      prevName: "STATUS_FIRST_HALF",
      newName: "STATUS_DELAYED",
      match,
    };
    expect(createFormatter()(ev)).toBeNull();
  });

  it("events 清單過濾：只開 goal 時，card 與 status 回 null", () => {
    const onlyGoal = createFormatter({ events: ["goal"] });
    expect(onlyGoal(goal())).not.toBeNull();
    expect(onlyGoal(goal({ kind: "card", yellowCard: true }))).toBeNull();
    expect(
      onlyGoal({
        kind: "status",
        prevState: "pre",
        newState: "in",
        prevName: "",
        newName: "STATUS_FIRST_HALF",
        match,
      }),
    ).toBeNull();
  });
});
