// snapshot diff → 播報事件。純函式：吃 (state, snapshot) 回 { events, nextState }，不做 IO。
//
// 核心規則：
// 1. 首次看到的比賽 → 全部事件進 seen、比分入基線，不播報（開晚了寧漏播不洗版）
// 2. 進球用「官方比分變化」觸發（不是事件 key）：比分絕對準、單調遞增天生免疫重播。
//    得分者名字從事件清單盡力撈（撈不到只報比分，因為比分才是重點）。
// 3. 紅黃牌用穩定事件 key 觸發、append-only 去重（ESPN 抖動/重分類不重播）
// 4. 比分減少（VAR 取消）→ 播 goalCancelled，讓比分始終如實

export function emptyState() {
  return { seenEventKeys: {}, matches: {} };
}

export function diffSnapshot(state, snapshot) {
  const events = [];
  const nextState = {
    seenEventKeys: { ...state.seenEventKeys },
    matches: { ...state.matches },
  };
  const seen = nextState.seenEventKeys;

  for (const match of snapshot.matches) {
    const prev = state.matches[match.id];
    const matchInfo = {
      homeName: match.home.name,
      awayName: match.away.name,
      homeScore: match.home.score,
      awayScore: match.away.score,
      displayClock: match.displayClock,
    };

    // 基線：首見的比賽記下全部事件與比分，不播報
    if (!prev) {
      for (const ev of match.events) seen[ev.key] = true;
      nextState.matches[match.id] = toMatchState(match);
      continue;
    }

    // 狀態轉換（開賽/中場/下半場/完場）
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

    // 進球：比分變化觸發
    emitGoalsForSide(events, match, prev, seen, "home", matchInfo);
    emitGoalsForSide(events, match, prev, seen, "away", matchInfo);

    // 紅黃牌：穩定 key 觸發。進球事件不在此處理（留給比分觸發時當得分者撈），但也不在此標記，
    // 以免 event-before-score 時被提前標記、之後比分追上卻撈不到得分者。
    for (const ev of match.events) {
      if (seen[ev.key] || ev.scoringPlay) continue;
      seen[ev.key] = true;
      if (ev.yellowCard || ev.redCard) {
        events.push({ kind: "card", ...ev, match: matchInfo });
      }
      // 其他事件種類（換人等）目前不播報
    }

    nextState.matches[match.id] = toMatchState(match);
  }

  return { events, nextState };
}

// 某隊比分增加 → 為每個增量播一則進球；減少 → 播進球取消（VAR）。
function emitGoalsForSide(events, match, prev, seen, side, matchInfo) {
  const cur = side === "home" ? match.home.score : match.away.score;
  const before = side === "home" ? prev.homeScore : prev.awayScore;

  if (cur < before) {
    events.push({ kind: "goalCancelled", side, match: matchInfo });
    return;
  }
  const teamName = side === "home" ? match.home.name : match.away.name;
  for (let i = 0; i < cur - before; i++) {
    const ev = pickScorer(match, side, seen);
    if (ev) seen[ev.key] = true; // 標記為已命名，避免重複撈
    events.push({
      kind: "goal",
      side,
      scoringTeamName: teamName,
      clockDisplay: ev?.clockDisplay || match.displayClock || "",
      typeText: ev?.typeText ?? "",
      athlete: ev?.athlete ?? "",
      penaltyKick: ev?.penaltyKick ?? false,
      ownGoal: ev?.ownGoal ?? false,
      shootout: ev?.shootout ?? false,
      match: matchInfo, // 比分用官方當下值（正確）
    });
  }
}

// 盡力找這次進球的得分者事件：先找該隊未命名的正常進球，退而求其次任何未命名的進球事件
//（涵蓋烏龍球、ESPN teamId 慣例不確定的情況）。找不到回 null（只報比分、不掛得分者）。
function pickScorer(match, side, seen) {
  const sideId = side === "home" ? match.home.id : match.away.id;
  return (
    match.events.find(
      (e) => e.scoringPlay && !seen[e.key] && !e.ownGoal && e.teamId === sideId,
    ) ||
    match.events.find((e) => e.scoringPlay && !seen[e.key]) ||
    null
  );
}

function toMatchState(match) {
  return {
    statusState: match.statusState,
    statusName: match.statusName,
    homeScore: match.home.score,
    awayScore: match.away.score,
  };
}
