import { describe, it, expect } from "vitest";
import { createPipeline } from "../src/core/pipeline.js";
import { emptyState } from "../src/core/diff.js";
import { createFormatter } from "../src/format/soccer-zh.js";

function makeMatch({ home = 0, events = [], state = "in", name = "STATUS_FIRST_HALF" } = {}) {
  return {
    id: "m1",
    statusState: state,
    statusName: name,
    displayClock: "10'",
    home: { id: "h", name: "主隊", score: home },
    away: { id: "a", name: "客隊", score: 0 },
    events,
  };
}

const GOAL = {
  key: "k1",
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
};

function fakeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

function fakeWorld({ snapshots, sendResults }) {
  const sentMessages = [];
  let saved = null;
  return {
    sentMessages,
    getSaved: () => saved,
    source: { fetchSnapshot: async () => snapshots.shift() },
    sink: {
      init: async () => ({ login: "mars", channels: ["ch"] }),
      send: async (message) => {
        sentMessages.push(message);
        // 預設單頻道 sent；sendResults 給 per-channel 結果陣列
        const results = sendResults?.shift() ?? [{ channel: "ch", status: "sent" }];
        return { results };
      },
    },
    saveState: async (state) => {
      saved = state;
      return { ok: true };
    },
    loadState: async () => ({ ok: true, value: emptyState() }),
    logger: fakeLogger(),
  };
}

describe("pipeline tick", () => {
  it("基線 poll 不發話，第二次 poll 的新進球發到 sink，state 有落地", async () => {
    const world = fakeWorld({
      snapshots: [
        { ok: true, value: { matches: [makeMatch()] } },
        { ok: true, value: { matches: [makeMatch({ home: 1, events: [GOAL] })] } },
      ],
    });
    const pipeline = createPipeline({
      ...world,
      formatEvent: createFormatter(),
      statePath: "/fake/state.json",
    });

    const t1 = await pipeline.tick(emptyState());
    expect(world.sentMessages).toEqual([]);

    const t2 = await pipeline.tick(t1.state);
    expect(world.sentMessages).toHaveLength(1);
    expect(world.sentMessages[0]).toContain("進球");
    expect(t2.error).toBeUndefined();
    expect(world.getSaved().matches.m1.homeScore).toBe(1); // 比分已確認落地
    expect(pipeline.stats.sent).toBe(1);
  });

  it("source 失敗 → 回 error、state 不變、計入 pollErrors", async () => {
    const world = fakeWorld({ snapshots: [{ ok: false, error: "ESPN 回應 503" }] });
    const pipeline = createPipeline({
      ...world,
      formatEvent: createFormatter(),
      statePath: "/fake/state.json",
    });
    const state = emptyState();
    const t = await pipeline.tick(state);
    expect(t.error).toContain("503");
    expect(t.state).toBe(state);
    expect(pipeline.stats.pollErrors).toBe(1);
    expect(world.sentMessages).toEqual([]);
  });

  it("dropped / failed 分開計數並醒目輸出", async () => {
    const world = fakeWorld({
      snapshots: [
        { ok: true, value: { matches: [makeMatch()] } },
        {
          ok: true,
          value: {
            matches: [makeMatch({ home: 2, events: [GOAL, { ...GOAL, key: "k2", athlete: "球員B" }] })],
          },
        },
      ],
      sendResults: [
        [{ channel: "ch", status: "dropped", reason: "重複訊息" }],
        [{ channel: "ch", status: "failed", error: "500" }],
      ],
    });
    const pipeline = createPipeline({
      ...world,
      formatEvent: createFormatter(),
      statePath: "/fake/state.json",
    });
    const t1 = await pipeline.tick(emptyState());
    await pipeline.tick(t1.state);
    expect(pipeline.stats.dropped).toBe(1);
    expect(pipeline.stats.failed).toBe(1);
    expect(world.logger.lines.warn.some((l) => l.includes("被擋"))).toBe(true);
    expect(world.logger.lines.error.some((l) => l.includes("發話失敗"))).toBe(true);
  });

  it("完場 → 印統計", async () => {
    const world = fakeWorld({
      snapshots: [
        { ok: true, value: { matches: [makeMatch()] } },
        { ok: true, value: { matches: [makeMatch({ state: "post", name: "STATUS_FULL_TIME" })] } },
      ],
    });
    const pipeline = createPipeline({
      ...world,
      formatEvent: createFormatter(),
      statePath: "/fake/state.json",
    });
    const t1 = await pipeline.tick(emptyState());
    await pipeline.tick(t1.state);
    expect(world.logger.lines.info.some((l) => l.includes("完場統計"))).toBe(true);
  });
});

describe("pipeline tick anyLive", () => {
  it("有進行中比賽 → anyLive true；全部非進行中 → false", async () => {
    const live = fakeWorld({ snapshots: [{ ok: true, value: { matches: [makeMatch({ state: "in" })] } }] });
    const p1 = createPipeline({ ...live, formatEvent: createFormatter(), statePath: "/f" });
    expect((await p1.tick(emptyState())).anyLive).toBe(true);

    const idle = fakeWorld({
      snapshots: [{ ok: true, value: { matches: [makeMatch({ state: "post" })] } }],
    });
    const p2 = createPipeline({ ...idle, formatEvent: createFormatter(), statePath: "/f" });
    expect((await p2.tick(emptyState())).anyLive).toBe(false);
  });
});

describe("pipeline run", () => {
  it("loadState 損壞 → fail loud，不靜默清空", async () => {
    const world = fakeWorld({ snapshots: [] });
    world.loadState = async () => ({ ok: false, error: "state.json 不是合法 JSON" });
    const pipeline = createPipeline({
      ...world,
      formatEvent: createFormatter(),
      statePath: "/fake/state.json",
    });
    await expect(pipeline.run({})).rejects.toThrow(/state 檔損壞/);
  });

  it("有 live 比賽用 livePollIntervalSec、無 live 用 pollIntervalSec", async () => {
    const runOnce = async (state) => {
      const sleeps = [];
      const signal = { aborted: false };
      const world = fakeWorld({
        snapshots: [{ ok: true, value: { matches: [makeMatch({ state })] } }],
      });
      const pipeline = createPipeline({
        ...world,
        formatEvent: createFormatter(),
        statePath: "/f",
        pollIntervalSec: 30,
        livePollIntervalSec: 10,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          signal.aborted = true; // 跑一輪就停
        },
      });
      await pipeline.run({ signal });
      return sleeps[0];
    };
    expect(await runOnce("in")).toBe(10000); // live → 10s
    expect(await runOnce("post")).toBe(30000); // idle → 30s
  });
});
