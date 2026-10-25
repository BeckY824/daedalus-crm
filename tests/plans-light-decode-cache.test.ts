/**
 * 解轻 记住上一次解的那份（lib/plans-light.ts）。钉的是：
 * - 内容一样（过一遍 JSON 的新对象）：直接给上一次的结果，和现解的一字不差
 * - 键、时、单位、人、负责人任何一处差一点：重新解，和原来的解法对拍
 * - 解完调用方改了传进来的 紧：下一次照改过的解，不被记住的那份骗
 * - 两份来回换、空的
 */
import { describe, it, expect } from "vitest";
import { 压轻, 解轻, type 紧轻 } from "@/lib/plans-light";
import type { 轻行 } from "@/lib/plans-page";

/** 改之前的 解轻，原样抄来当裁判 */
function 原解轻(紧: 紧轻): { key: string; 时间: string | null; ownerId: string }[] {
  const 还原前缀: Record<string, string> = { p: "plan:", t: "task:" };
  if (紧.人.length === 0) return [];
  const 键 = 紧.键.split(",");
  let 上一个 = 0;
  return 键.map((k, i) => {
    const t = 紧.时[i];
    let 时间: string | null;
    if (typeof t === "number") {
      上一个 += t * 紧.单位;
      时间 = new Date(上一个).toISOString();
    } else 时间 = t;
    return { key: 还原前缀[k[0]] + k.slice(1), 时间, ownerId: 紧.负责人[紧.人[i]] };
  });
}

function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按时间排好的一份：分钟精度为主，夹着只有日期的、没时间的、有秒的 */
function 造(种子: number, 条数 = 3000): 紧轻 {
  const r = 随机(种子);
  const 负责人 = Array.from({ length: 12 }, (_, i) => `u${种子}-${i}`);
  const 基准 = Date.UTC(2026, 9, 25);
  const 轻: 轻行[] = Array.from({ length: 条数 }, (_, i) => {
    const 类 = r();
    const 时间 = 类 < 0.1 ? null : 类 < 0.2 ? "2026-10-2" + Math.floor(r() * 10) : new Date(基准 + Math.floor((r() - 0.4) * 1e6) * (类 < 0.25 ? 1000 : 60_000)).toISOString();
    return [`${r() < 0.6 ? "plan" : "task"}:c${种子}x${i}`, 时间, Math.floor(r() * 负责人.length)];
  });
  return 压轻(轻, 负责人)!;
}
const 拷 = (紧: 紧轻): 紧轻 => JSON.parse(JSON.stringify(紧));

describe("解轻 记住上一次", () => {
  it("内容一样的新对象：给上一次那份，和现解一字不差", () => {
    const 紧 = 造(1);
    const 第一次 = 解轻(紧);
    expect(第一次).toEqual(原解轻(紧));
    const 第二次 = 解轻(拷(紧));
    expect(第二次).toBe(第一次);
    expect(第二次).toEqual(原解轻(紧));
  });

  const 改法: [string, (紧: 紧轻) => void][] = [
    ["键里改一个字", (紧) => { 紧.键 = 紧.键.replace("x7,", "y7,"); }],
    ["键里换一条的计划/待办", (紧) => { const 键 = 紧.键.split(","); 键[9] = (键[9][0] === "p" ? "t" : "p") + 键[9].slice(1); 紧.键 = 键.join(","); }],
    ["时里一条多一分钟", (紧) => { const i = 紧.时.findIndex((t, j) => j > 100 && typeof t === "number"); 紧.时[i] = (紧.时[i] as number) + 1; }],
    ["时里一条日期串换一天", (紧) => { const i = 紧.时.findIndex((t) => typeof t === "string"); 紧.时[i] = 紧.时[i] === "2026-10-20" ? "2026-10-21" : "2026-10-20"; }],
    ["时里一条空换成日期", (紧) => { const i = 紧.时.findIndex((t) => t === null); 紧.时[i] = "2026-10-25"; }],
    ["最后一条的时间", (紧) => { const i = 紧.时.length - 1; 紧.时[i] = typeof 紧.时[i] === "number" ? (紧.时[i] as number) + 3 : 5; }],
    ["单位", (紧) => { 紧.单位 = 紧.单位 === 1000 ? 60_000 : 1000; }],
    ["人里一条换负责人", (紧) => { 紧.人[1234] = (紧.人[1234] + 1) % 紧.负责人.length; }],
    ["负责人改名", (紧) => { 紧.负责人[紧.人[0]] += "-改"; }],
  ];
  for (const [名, 改] of 改法) {
    it(`差一处（${名}）：重新解`, () => {
      const 原 = 造(2);
      const 第一次 = 解轻(原);
      const 新 = 拷(原);
      改(新);
      expect(新).not.toEqual(原);
      const 第二次 = 解轻(新);
      expect(第二次).not.toBe(第一次);
      expect(第二次).toEqual(原解轻(新));
      expect(第二次).not.toEqual(第一次);
      // 换回原来那份也对
      expect(解轻(拷(原))).toEqual(原解轻(原));
    });
  }

  it("解完调用方改了传进来的那份：下一次照改过的解", () => {
    const 紧 = 造(3);
    const 第一次 = 解轻(紧);
    const 留底 = 原解轻(紧);
    const i = 紧.时.findIndex((t, j) => j > 10 && typeof t === "number");
    紧.时[i] = (紧.时[i] as number) + 7;
    紧.人[5] = (紧.人[5] + 1) % 紧.负责人.length;
    紧.负责人[0] += "-改";
    const 第二次 = 解轻(紧);
    expect(第二次).toEqual(原解轻(紧));
    expect(第二次).not.toEqual(留底);
    expect(第一次).toEqual(留底);
  });

  it("两份来回换、空的、只有一条", () => {
    const A = 造(4), B = 造(5, 500);
    const 空 = 压轻([], [])!;
    const 一条 = 压轻([["plan:only", "2026-10-25T09:00:00.000Z", 0]], ["u"])!;
    for (const 紧 of [A, B, A, 空, A, 一条, B, B, 空, 空, 一条]) expect(解轻(拷(紧))).toEqual(原解轻(紧));
  });
});
