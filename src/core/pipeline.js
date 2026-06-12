// poll loop：source → diff → format → sink → state 落地。
// source 失敗 exponential backoff（上限 5 分鐘）；sink 失敗計入統計並醒目輸出，
// 完場時印統計——長跑無人盯 console 時至少有一個總結可回查。
import { diffSnapshot } from "./diff.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_BACKOFF_SEC = 300;

export function createPipeline({
  source,
  formatEvent,
  sink,
  statePath,
  loadState,
  saveState,
  logger,
  pollIntervalSec = 20,
  sleepImpl = sleep,
}) {
  const stats = { polls: 0, pollErrors: 0, sent: 0, dropped: 0, failed: 0 };

  /** 單次 poll。回 { state, error? }，error 表示 source 失敗（state 不變）。 */
  async function tick(state) {
    const snap = await source.fetchSnapshot();
    if (!snap.ok) {
      stats.pollErrors++;
      return { state, error: snap.error };
    }
    stats.polls++;

    const { events, warnings, nextState } = diffSnapshot(state, snap.value);
    for (const w of warnings) logger.warn(w);

    let anyFulltime = false;
    for (const ev of events) {
      if (ev.kind === "status" && ev.prevState === "in" && ev.newState === "post") {
        anyFulltime = true;
      }
      const message = formatEvent(ev);
      if (!message) continue;
      const result = await sink.send(message);
      if (result.status === "sent") {
        stats.sent++;
        logger.info(`已播報：${message}`);
      } else if (result.status === "dropped") {
        stats.dropped++;
        logger.warn(`訊息被擋（${result.reason}）：${message}`);
      } else {
        stats.failed++;
        logger.error(`發話失敗（${result.error}）：${message}`);
      }
    }

    if (anyFulltime) {
      logger.info(
        `完場統計：已播報 ${stats.sent} 則、被擋 ${stats.dropped} 則、失敗 ${stats.failed} 則`,
      );
    }

    const w = await saveState(nextState, statePath);
    if (!w.ok) logger.error(`state 寫入失敗：${w.error}`); // 不中斷，但必須可見
    return { state: nextState };
  }

  async function run({ signal } = {}) {
    const r = await loadState(statePath);
    if (!r.ok) throw new Error(`state 檔損壞：${r.error}`);
    let state = r.value;
    let backoffSec = pollIntervalSec;

    while (!signal?.aborted) {
      const t = await tick(state);
      state = t.state;
      if (t.error) {
        logger.warn(`poll 失敗：${t.error}，${backoffSec} 秒後重試`);
        await sleepImpl(backoffSec * 1000);
        backoffSec = Math.min(backoffSec * 2, MAX_BACKOFF_SEC);
      } else {
        backoffSec = pollIntervalSec;
        await sleepImpl(pollIntervalSec * 1000);
      }
    }
    return stats;
  }

  return { tick, run, stats };
}
