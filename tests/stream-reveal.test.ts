/**
 * 流式回答的出字（lib/stream-reveal.ts + components/StreamMarkdown.tsx）。
 *
 * 钉三件事：
 * 1. 切块渲染和整段渲染**逐字相同**——切错一处，列表断成两截、表格少一行，没人会立刻发现
 * 2. 放字节奏：不比模型慢（流一结束全放完）、有积压时两次放字至少隔 28ms、积压不会越拖越远
 * 3. 性能：3000 字分 600 块到达，解析的字数和渲染次数比「每个 token 整段重渲」少一个数量级
 *
 * 不引 jsdom：renderToStaticMarkup 在 .ts 里就跑得起来；memo 那一层用和组件同一个比较函数模拟。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { MdBlock } from "@/components/Markdown";
import type { BriefRecord } from "@/lib/ai-draft";
import {
  起出字,
  收到,
  走一拍,
  放完,
  还在动,
  放几块,
  切块,
  块们,
  块属性相等,
  切淡片,
  放字间隔,
  淡入窗口,
  type 出字状态,
  type 块属性,
} from "@/lib/stream-reveal";

const byN = new Map<number, BriefRecord>();
const 整段 = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));
const 分块 = (t: string, 淡: readonly number[] = []) =>
  renderToStaticMarkup(
    createElement(
      "div",
      { className: "md" },
      块们(t, 淡).map((b) => createElement(MdBlock, { key: b.起, ...b, byN })),
    ),
  );
const 去淡 = (h: string) => h.replace(/<span class="md-in">([^<]*)<\/span>/g, "$1");

/** 一段像样的回答：标题、段落、加粗、引用、行内代码、有序/无序列表（中间被打断再续）、表格、分隔线、空行 */
const 样本 = [
  "## 本周要跟的三位客户",
  "",
  "先说结论：**王建国**和李梅这周都该联系[1]，老周可以再放一放。",
  "1. 王建国：上次说月底定预算[2]，现在是第三周",
  "2. 李梅：试用到期 `2026-10-01`",
  "- 顺带问一下发票抬头",
  "3. 老周：暂缓",
  "",
  "| 客户 | 状态 | 下次跟进 |",
  "|---|:--:|---|",
  "| 王建国 | 谈判中 | 周三 |",
  "| 李梅 | 试用 [3] | 周五 |",
  "---",
  "* 要点一",
  "* **要点二**带引用[12]",
  "最后一段，   ",
  "   缩进的段落。",
].join("\n");

describe("切块：和整段渲染逐字相同", () => {
  it("每一个前缀都相同（流式时每一刻看到的都得对）", () => {
    for (let i = 0; i <= 样本.length; i++) {
      const t = 样本.slice(0, i);
      expect(分块(t), `前 ${i} 个字`).toBe(整段(t));
    }
  });

  it("带淡入切点时，去掉 .md-in 那层也和整段相同——淡入只包字，不改结构", () => {
    for (let i = 1; i <= 样本.length; i += 3) {
      const t = 样本.slice(0, i);
      // 最近三截：从 i-40、i-20、i-7 开始
      const 淡 = [i - 40, i - 20, i - 7].filter((x) => x >= 0);
      expect(去淡(分块(t, 淡)), `前 ${i} 个字`).toBe(整段(t));
    }
  });

  it("列表和表格整组一块，段落一行一块，空行不占块", () => {
    const 块 = 切块(样本).map((b) => b.文.split("\n")[0]);
    expect(块).toContain("1. 王建国：上次说月底定预算[2]，现在是第三周");
    const 表 = 切块(样本).find((b) => b.文.startsWith("| 客户"))!;
    expect(表.文.split("\n")).toHaveLength(4);
    expect(切块(样本).some((b) => b.文 === "")).toBe(false);
  });

  it("没写完的那一行像列表时并进前面的列表，不像时自己一块", () => {
    expect(切块("- a\n- b\n- c").map((b) => b.文)).toEqual(["- a\n- b\n- c"]);
    expect(切块("- a\n- b\n-").map((b) => b.文)).toEqual(["- a\n- b", "-"]);
  });

  it("块的起点就是它在全文里的偏移（拿它当 key，文本长了起点不变）", () => {
    for (const b of 切块(样本)) expect(样本.slice(b.起, b.起 + b.文.length)).toBe(b.文);
    const 前 = 切块(样本.slice(0, 120)).slice(0, -1);
    const 后 = 切块(样本);
    for (const b of 前) expect(后.find((x) => x.起 === b.起)?.文).toBe(b.文);
  });
});

describe("淡入切片", () => {
  it("旧的部分一整片，之后每截一片；拼起来是原来那段", () => {
    expect(切淡片(10, 20, [15, 22])).toEqual([
      { 起: 10, 止: 15, 新: false },
      { 起: 15, 止: 22, 新: true },
      { 起: 22, 止: 30, 新: true },
    ]);
    expect(切淡片(10, 5, [])).toEqual([{ 起: 10, 止: 15, 新: false }]);
    // 整段都在最早那截之后：一整片新的
    expect(切淡片(10, 5, [3])).toEqual([{ 起: 10, 止: 15, 新: true }]);
  });

  it("文本长了，已有的片起点不变（同一个 span，淡入不重演）", () => {
    const 前 = 切淡片(0, 20, [5, 12]);
    const 后 = 切淡片(0, 28, [5, 12, 20]);
    expect(后.slice(0, 2)).toEqual(前.slice(0, 2));
  });

  it("块外的切点不影响这一块；整块都旧就是空数组（memo 靠它挡住重渲）", () => {
    const bs = 块们("第一段\n第二段\n第三段", [9]);
    expect(bs[0].淡).toEqual([]);
    expect(bs[1].淡).toEqual([]);
    // 第三段从 8 开始，切点 9 落在它里面：8–9 是旧的，9 往后是新的
    expect(bs[2].淡).toEqual([9]);
    expect(块们("第一段\n第二段\n第三段", [1])[2].淡).toEqual([8]);
    expect(块们("第一段\n第二段", [2])[1].淡).toEqual([4]);
  });
});

/** 按帧模拟：arrivals = [时刻, 这时的全文]，每 16.7ms 一帧 */
function 模拟(arrivals: [number, string][], 结束于: number) {
  let s = 起出字("", true);
  const 放字时刻: number[] = [];
  let 最大积压 = 0;
  let ai = 0;
  let 结束 = false;
  for (let t = 0; t < 结束于 + 2000; t += 1000 / 60) {
    while (ai < arrivals.length && arrivals[ai][0] <= t) s = 收到(s, arrivals[ai++][1]);
    if (!结束 && t >= 结束于) {
      s = 放完(s, t);
      结束 = true;
      放字时刻.push(t);
    }
    const 前 = s.显示长;
    s = 走一拍(s, t);
    if (s.显示长 !== 前) 放字时刻.push(t);
    expect(s.目标.startsWith(s.目标.slice(0, s.显示长))).toBe(true);
    最大积压 = Math.max(最大积压, s.待放.length);
    if (结束 && !还在动(s)) break;
  }
  return { s, 放字时刻, 最大积压 };
}

describe("放字节奏", () => {
  it("流一结束剩下的一次放完：不比模型慢", () => {
    const 全文 = "一二三四五六七八九十".repeat(20);
    const arr: [number, string][] = [];
    for (let i = 1; i <= 100; i++) arr.push([i * 2, 全文.slice(0, i * 2)]); // 2ms 一块，远快于 28ms
    const { s } = 模拟(arr, 201);
    expect(s.显示长).toBe(全文.length);
    expect(还在动(s)).toBe(false);
  });

  it("有积压时两次放字至少隔 28ms，而且积压追得上（不越拖越远）", () => {
    const 全文 = "字".repeat(2000);
    const arr: [number, string][] = [];
    for (let i = 1; i <= 400; i++) arr.push([i * 8, 全文.slice(0, i * 5)]); // 8ms 一块，3.2 秒
    const { 放字时刻, 最大积压 } = 模拟(arr, 99999);
    const 流中 = 放字时刻.filter((t) => t < 400 * 8);
    for (let i = 1; i < 流中.length; i++) expect(流中[i] - 流中[i - 1]).toBeGreaterThanOrEqual(放字间隔 - 1e-9);
    // 每拍到 3.5 块，按三分之一追，稳态积压在十几块以内，也就是落后 ~100ms
    expect(最大积压).toBeLessThanOrEqual(15);
  });

  it("没有积压时来一块放一块，不等 28ms", () => {
    let s = 起出字("", true);
    s = 收到(s, "你好");
    s = 走一拍(s, 1000);
    expect(s.显示长).toBe(2);
    s = 收到(s, "你好，王总");
    s = 走一拍(s, 1500);
    expect(s.显示长).toBe(5);
  });

  it("积压一多一拍放好几块", () => {
    expect([0, 1, 3, 4, 9, 30].map(放几块)).toEqual([0, 1, 1, 2, 3, 10]);
  });

  it("服务端 reset（整段抹掉重答）：已放出的立刻收回", () => {
    let s = 起出字("", true);
    s = 收到(s, "call_tool(");
    s = 走一拍(s, 100);
    expect(s.显示长).toBe(10);
    s = 收到(s, "");
    expect(s.显示长).toBe(0);
    expect(s.最近).toEqual([]);
    s = 收到(s, "王建国这周该联系");
    s = 走一拍(s, 200);
    expect(s.目标.slice(0, s.显示长)).toBe("王建国这周该联系");
  });

  it("淡入截过了窗口就摘掉，摘完不再走帧", () => {
    let s = 起出字("", true);
    s = 收到(s, "abc");
    s = 走一拍(s, 0);
    expect(s.最近).toHaveLength(1);
    expect(还在动(s)).toBe(true);
    s = 走一拍(s, 淡入窗口 + 1);
    expect(s.最近).toHaveLength(0);
    expect(还在动(s)).toBe(false);
    expect(走一拍(s, 淡入窗口 + 50)).toBe(s);
  });

  it("不在流（翻出来的历史）：直接全显示，不演", () => {
    const s = 起出字("早就答完的一段", false);
    expect(s.显示长).toBe(7);
    expect(还在动(s)).toBe(false);
  });
});

describe("性能：3000 字分 600 块到达", () => {
  // 拼一段 3000 字的回答
  let 长文 = "";
  for (let k = 0; 长文.length < 3000; k++) 长文 += 样本.replace(/王建国/g, `客户${k}`) + "\n\n";
  长文 = 长文.slice(0, 3000);
  const 块长 = 5;
  const arrivals: [number, string][] = [];
  for (let i = 1; i <= 600; i++) arrivals.push([i * 25, 长文.slice(0, i * 块长)]); // 25ms 一块，15 秒

  it("解析的字数、块渲染次数都显著下降，最后显示的和整段渲染相同", () => {
    // 原来：每来一个 token，整段重新解析渲染一遍
    let 旧字数 = 0;
    const t旧 = performance.now();
    for (const [, t] of arrivals) {
      旧字数 += t.length;
      整段(t);
    }
    const 旧毫秒 = performance.now() - t旧;

    // 现在：每帧走一拍；快照变了才重渲，而且只重渲属性变了的块（和 MdBlock 的 memo 用同一个比较）
    let s: 出字状态 = 起出字("", true);
    let 上一版 = new Map<number, 块属性>();
    let 新字数 = 0;
    let 块渲染 = 0;
    let 重渲次数 = 0;
    let ai = 0;
    let 结束 = false;
    const t新 = performance.now();
    for (let t = 0; t < 20000; t += 1000 / 60) {
      while (ai < arrivals.length && arrivals[ai][0] <= t) s = 收到(s, arrivals[ai++][1]);
      const 前 = s;
      if (!结束 && ai === arrivals.length) {
        s = 放完(s, t);
        结束 = true;
      }
      s = 走一拍(s, t);
      if (s === 前) {
        if (结束 && !还在动(s)) break;
        continue;
      }
      重渲次数++;
      const 这一版 = new Map<number, 块属性>();
      for (const b of 块们(s.目标.slice(0, s.显示长), s.最近.map((c) => c.起))) {
        这一版.set(b.起, b);
        const 旧 = 上一版.get(b.起);
        if (旧 && 块属性相等({ ...旧, byN }, { ...b, byN })) continue;
        块渲染++;
        新字数 += b.文.length;
        renderToStaticMarkup(createElement(MdBlock, { ...b, byN }));
      }
      上一版 = 这一版;
    }
    const 新毫秒 = performance.now() - t新;

    expect(s.显示长).toBe(长文.length);
    expect(分块(长文)).toBe(整段(长文));

    console.log(
      `[出字基准] 3000 字 / 600 块：\n` +
        `  原来 整段重渲 ${arrivals.length} 次，解析 ${旧字数} 字，${旧毫秒.toFixed(0)}ms\n` +
        `  现在 快照变化 ${重渲次数} 次，块渲染 ${块渲染} 次，解析 ${新字数} 字，${新毫秒.toFixed(0)}ms\n` +
        `  解析字数降到 ${((新字数 / 旧字数) * 100).toFixed(1)}%`,
    );
    expect(新字数).toBeLessThan(旧字数 / 10);
    expect(重渲次数).toBeLessThanOrEqual(arrivals.length);
  });
});
