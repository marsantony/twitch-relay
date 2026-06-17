// 比賽事件 → 中文播報訊息。回 null 表示此事件不在播報清單或無對應模板。

const STATUS_TEXT = {
  kickoff: (m) => `🏟️ 開賽！${m.homeName} vs ${m.awayName}`,
  halftime: (m) => `⏸️ 中場 ${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}`,
  secondhalf: (m) => `▶️ 下半場開始 ${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}`,
  fulltime: (m) => `🏁 完場 ${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}`,
};

const DEFAULT_EVENTS = ["goal", "card", "kickoff", "halftime", "secondhalf", "fulltime"];

// 狀態轉換 → 播報類型。半場相關用 statusName 判斷（state 維持 in 不變），
// 開賽/完場用 state 轉換判斷（涵蓋延長賽等未驗證的 statusName）。
function statusEventType(ev) {
  if (ev.newName === "STATUS_HALFTIME") return "halftime";
  if (ev.newName === "STATUS_SECOND_HALF" && ev.prevName === "STATUS_HALFTIME") return "secondhalf";
  if (ev.prevState === "pre" && ev.newState === "in") return "kickoff";
  if (ev.prevState === "in" && ev.newState === "post") return "fulltime";
  return null;
}

function formatGoal(ev) {
  const m = ev.match;
  // 只報比分 + 得分隊（不掛得分者，名字不可靠不如不放；比分才是重點）
  const suffix = ev.scoringTeamName ? `（${ev.scoringTeamName} 得分）` : "";
  return `⚽ ${ev.clockDisplay} 進球！${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}${suffix}`;
}

function formatGoalCancelled(ev) {
  const m = ev.match;
  return `⚠️ 進球取消（VAR）${m.homeName} ${m.homeScore}-${m.awayScore} ${m.awayName}`;
}

function formatCard(ev) {
  const icon = ev.redCard ? "🟥 紅牌" : "🟨 黃牌";
  const m = ev.match;
  return `${icon} ${ev.clockDisplay} ${ev.athlete || "（球員不明）"}｜${m.homeName} vs ${m.awayName}`;
}

export function createFormatter({ events = DEFAULT_EVENTS } = {}) {
  const enabled = new Set(events);
  return function formatEvent(ev) {
    if (ev.kind === "goal") return enabled.has("goal") ? formatGoal(ev) : null;
    if (ev.kind === "goalCancelled") return enabled.has("goal") ? formatGoalCancelled(ev) : null;
    if (ev.kind === "card") return enabled.has("card") ? formatCard(ev) : null;
    if (ev.kind === "status") {
      const type = statusEventType(ev);
      if (!type || !enabled.has(type)) return null;
      return STATUS_TEXT[type](ev.match);
    }
    return null;
  };
}
