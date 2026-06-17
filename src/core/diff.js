// snapshot diff → 播報事件。純函式：吃 (state, snapshot) 回 { events, nextState }，不做 IO。
//
// 核心規則：
// 1. 首次看到的比賽 → 全部事件進 seen、比分入基線，不播報（開晚了寧漏播不洗版）
// 2. 進球用「官方比分變化」觸發（不是事件 key）：比分絕對準、單調遞增天生免疫重播。
//    只報比分 + 得分隊，不掛得分者（事件晚到/順序亂時名字會配錯，比分才是重點）。
// 3. 只採用「自洽」的 poll：進球事件數 == 比分總和。擋掉 ESPN 把比分瞬間歸零的壞值，與持續時間無關。
// 4. 比分下降只認「單側、剛好 -1」= 真 VAR 取消 → 播 goalCancelled；其餘下降視為壞值不採用。
// 5. 紅黃牌用穩定事件 key 觸發、append-only 去重（ESPN 抖動/重分類不重播）

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

    // 進球：以官方比分變化觸發，但只採用「自洽」的 poll
    //（進球事件數 == 比分總和）。擋掉 ESPN 把比分瞬間歸零的壞值，與抖動持續時間無關。
    const total = match.home.score + match.away.score;
    const goalCount = match.events.filter((e) => e.scoringPlay).length;
    let acceptedHome = prev.homeScore;
    let acceptedAway = prev.awayScore;

    if (total === goalCount) {
      const dh = match.home.score - prev.homeScore;
      const da = match.away.score - prev.awayScore;
      if (dh > 0) {
        emitGoals(events, dh, "home", match, matchInfo);
        acceptedHome = match.home.score;
      }
      if (da > 0) {
        emitGoals(events, da, "away", match, matchInfo);
        acceptedAway = match.away.score;
      }
      // 下降只認「單側、剛好少一球」= 真 VAR 取消的形狀；
      // 兩隊歸 0 / 降多球（即使湊巧自洽）視為壞值，不採用、沿用 confirmed。
      const drop = prev.homeScore - match.home.score + (prev.awayScore - match.away.score);
      if (drop === 1 && dh < 0 !== da < 0) {
        const side = dh < 0 ? "home" : "away";
        events.push({ kind: "goalCancelled", side, match: matchInfo });
        if (side === "home") acceptedHome = match.home.score;
        else acceptedAway = match.away.score;
      }
    }
    // 不自洽 → acceptedHome/Away 維持 prev（沿用上次確認的比分），不播任何進球/取消

    // 紅黃牌：穩定 key 觸發（與比分自洽性無關，照常處理）。進球事件略過。
    for (const ev of match.events) {
      if (seen[ev.key] || ev.scoringPlay) continue;
      seen[ev.key] = true;
      if (ev.yellowCard || ev.redCard) {
        events.push({ kind: "card", ...ev, match: matchInfo });
      }
      // 其他事件種類（換人等）目前不播報
    }

    nextState.matches[match.id] = {
      statusState: match.statusState,
      statusName: match.statusName,
      homeScore: acceptedHome,
      awayScore: acceptedAway,
    };
  }

  return { events, nextState };
}

// 某隊比分增加 count 球 → 播 count 則進球（只報比分+得分隊，不掛得分者/flavor）。
function emitGoals(events, count, side, match, matchInfo) {
  const teamName = side === "home" ? match.home.name : match.away.name;
  for (let i = 0; i < count; i++) {
    events.push({
      kind: "goal",
      side,
      scoringTeamName: teamName,
      clockDisplay: match.displayClock || "",
      match: matchInfo,
    });
  }
}

function toMatchState(match) {
  return {
    statusState: match.statusState,
    statusName: match.statusName,
    homeScore: match.home.score,
    awayScore: match.away.score,
  };
}
