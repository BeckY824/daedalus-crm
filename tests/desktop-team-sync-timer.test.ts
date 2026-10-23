/**
 * 壳里的团队同步定时器（desktop/sync.js）。
 *
 * 2026-10-23 团队版用户报「上次同步」停在一个时刻一个多小时：钉住两件事——
 * 出错、超时、本地服务不回话都不退避，下一轮照常 8 秒后来；切回应用 / 睡醒 / 解锁（刷新）马上一轮，之后从这一刻重新排。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const 同步器 = require_("../desktop/sync.js");

type 一次 = { 在: number; signal: AbortSignal };

function 起(fetch: (url: string, opts: { signal: AbortSignal }) => Promise<unknown>, 限时?: number) {
  return 同步器.开始({ 取端口: () => 3999, 取令牌: () => "t", 前台: () => true, fetch, ...(限时 ? { 限时 } : {}) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("团队同步定时器", () => {
  it("出错、本地服务挂住都不退避：挂住的那一轮到限时放开，下一轮照常 8 秒后", async () => {
    const 次: 一次[] = [];
    let 放开在 = -1;
    const fetch = vi.fn(async (_url: string, { signal }: { signal: AbortSignal }) => {
      次.push({ 在: Date.now(), signal });
      if (次.length === 1) throw new Error("ECONNREFUSED");
      if (次.length === 2) {
        return new Promise((_成, 败) => signal.addEventListener("abort", () => { 放开在 = Date.now(); 败(new Error("aborted")); }));
      }
      return { json: async () => ({ ok: true, 拉: 0 }) };
    });
    const s = 起(fetch, 1000);
    try {
      await vi.advanceTimersByTimeAsync(36_000);
      expect(次.map((x) => x.在)).toEqual([10_000, 18_000, 27_000, 35_000]);
      expect(放开在).toBe(19_000);
    } finally {
      s.停();
    }
  });

  it("刷新：马上一轮，下一轮从这一刻起算 8 秒（睡眠拖过的计时器不算数）", async () => {
    const 在: number[] = [];
    const fetch = vi.fn(async () => {
      在.push(Date.now());
      return { json: async () => ({ ok: true, 拉: 0 }) };
    });
    const s = 起(fetch);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(在).toEqual([10_000]);
      s.刷新();
      await vi.advanceTimersByTimeAsync(0);
      expect(在).toEqual([10_000, 15_000]);
      await vi.advanceTimersByTimeAsync(8_500);
      expect(在).toEqual([10_000, 15_000, 23_000]);
    } finally {
      s.停();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(在).toHaveLength(3);
  });

  it("一轮正跑着时刷新：不叠出第二条定时，之后还是一条 8 秒一轮", async () => {
    const 在: number[] = [];
    let 回话!: () => void;
    const fetch = vi.fn(async () => {
      在.push(Date.now());
      if (在.length === 1) await new Promise<void>((r) => (回话 = r));
      return { json: async () => ({ ok: true, 拉: 0 }) };
    });
    const s = 起(fetch);
    try {
      await vi.advanceTimersByTimeAsync(11_000); // 第一轮 10 秒开始、还没回话
      s.刷新();
      await vi.advanceTimersByTimeAsync(0); // 正在跑：这一下不重复发
      expect(在).toEqual([10_000]);
      回话();
      await vi.advanceTimersByTimeAsync(40_000);
      // 11 秒刷新那下排了 19 秒一轮；第一轮回话后又排一次，盖掉前一条：只剩一条，8 秒一轮
      expect(在).toEqual([10_000, 19_000, 27_000, 35_000, 43_000, 51_000]);
    } finally {
      s.停();
    }
  });

  it("断网恢复：从断到通马上一轮，不等下一个 30 秒；一直通着不多发", async () => {
    const 在: number[] = [];
    let 通 = true;
    const fetch = vi.fn(async () => {
      在.push(Date.now());
      return { json: async () => ({ ok: true, 拉: 0 }) };
    });
    const s = 同步器.开始({ 取端口: () => 3999, 取令牌: () => "t", 前台: () => false, fetch, 在线: () => 通 });
    try {
      await vi.advanceTimersByTimeAsync(11_000);
      expect(在).toEqual([10_000]); // 一直通着：只有定时那一轮
      通 = false;
      await vi.advanceTimersByTimeAsync(10_000); // 21 秒，断着
      通 = true;
      await vi.advanceTimersByTimeAsync(2_000); // 22 秒那次看网发现通了（setTimeout 0 算 1 毫秒）
      expect(在).toEqual([10_000, 22_001]);
      await vi.advanceTimersByTimeAsync(30_500);
      expect(在).toEqual([10_000, 22_001, 52_001]); // 之后从恢复那一刻起照常 30 秒
    } finally {
      s.停();
    }
  });
});
