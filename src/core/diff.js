// snapshot diff → 播報事件。純函式：吃 (state, snapshot) 回 { events, warnings, nextState }，不做 IO。
//
// 核心規則：
// 1. 首次看到的比賽 → 全部事件進 seen 當基線，不播報（腳本開晚了寧漏播不洗版）
// 2. seen 是 append-only：播過的 key 永不重播（ESPN CDN 抖動時事件可能消失再出現）
// 3. 事件從快照消失（VAR 取消、資料抖動）→ 只記 warning，不播報
// 4. 比分變了卻沒有新進球事件 → warning（資料異常的訊號）

export function emptyState() {
  return { seenEventKeys: {}, matches: {} };
}

export function diffSnapshot(state, snapshot) {
  const events = [];
  const warnings = [];
  const nextState = {
    seenEventKeys: { ...state.seenEventKeys },
    matches: { ...state.matches },
  };

  for (const match of snapshot.matches) {
    const prev = state.matches[match.id];
    const matchInfo = {
      homeName: match.home.name,
      awayName: match.away.name,
      homeScore: match.home.score,
      awayScore: match.away.score,
      displayClock: match.displayClock,
    };

    if (!prev) {
      for (const ev of match.events) nextState.seenEventKeys[ev.key] = true;
      nextState.matches[match.id] = toMatchState(match);
      continue;
    }

    if (prev.statusName !== match.statusName) {
      events.push({
        kind: "status",
        prevState: prev.statusState,
        newState: match.statusState,
        prevName: prev.statusName,
        newName: match.statusName,
        match: matchInfo,
      });
    }

    let newGoals = 0;
    for (const ev of match.events) {
      if (nextState.seenEventKeys[ev.key]) continue;
      nextState.seenEventKeys[ev.key] = true;
      if (ev.scoringPlay) {
        newGoals++;
        events.push({ kind: "goal", ...ev, match: matchInfo });
      } else if (ev.yellowCard || ev.redCard) {
        events.push({ kind: "card", ...ev, match: matchInfo });
      }
      // 其他事件種類（換人等）目前不播報
    }

    const currentKeys = new Set(match.events.map((ev) => ev.key));
    for (const key of prev.lastEventKeys) {
      if (!currentKeys.has(key)) {
        warnings.push(`事件從快照消失（VAR 取消或資料抖動）：${key}`);
      }
    }

    const scoreChanged =
      prev.homeScore !== match.home.score || prev.awayScore !== match.away.score;
    if (scoreChanged && newGoals === 0) {
      warnings.push(
        `比分變化但無對應進球事件：${match.home.name} ${match.home.score}-${match.away.score} ${match.away.name}`,
      );
    }

    nextState.matches[match.id] = toMatchState(match);
  }

  return { events, warnings, nextState };
}

function toMatchState(match) {
  return {
    statusState: match.statusState,
    statusName: match.statusName,
    homeScore: match.home.score,
    awayScore: match.away.score,
    lastEventKeys: match.events.map((ev) => ev.key),
  };
}
