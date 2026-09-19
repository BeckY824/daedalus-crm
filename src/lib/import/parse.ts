/**
 * 文本表格 → 二维数组。
 *
 * **只有这一条管线。** xlsx 在浏览器里解析完立刻变成同样的二维数组
 * （components/ImportDrawer 里那几行），从这里往后不再区分来源。
 * 两条管线的下场是复核、预览、撤销各写两遍，其中一遍迟早落后。
 *
 * 自己写而不是拉一个 csv 库：要处理的就是 RFC 4180 那几条（引号、转义、
 * 字段里的换行），三十行的事，而这三十行要跑在浏览器里，能少一个依赖是一个。
 */

/** 一份表最多收多少行、多少列。再多就不是「把手上的名单导进来」了 */
export const 行数上限 = 10000;
export const 列数上限 = 50;

/**
 * 分隔符自己认：逗号、制表符、分号。
 *
 * 为什么要认：Excel 在中文 Windows 上「另存为 CSV」出来的**是分号分隔的**
 * （跟随系统的列表分隔符设置），而人完全不知道这件事——他只知道自己存的是 csv。
 * 认错的表现是「整张表只有一列」，而那一列的表头是一长串，看着像文件坏了。
 */
export function 认分隔符(第一行: string): string {
  const 候选 = [",", "\t", ";"];
  let 最多 = ",";
  let 数 = -1;
  for (const c of 候选) {
    // 只数引号外面的：字段里本来就可能有逗号
    let n = 0;
    let 引号里 = false;
    for (let i = 0; i < 第一行.length; i++) {
      const ch = 第一行[i];
      if (ch === '"') 引号里 = !引号里;
      else if (ch === c && !引号里) n++;
    }
    if (n > 数) {
      数 = n;
      最多 = c;
    }
  }
  return 最多;
}

/**
 * CSV 文本 → 二维数组。行尾的 \r 吃掉，BOM 吃掉（导出时我们自己加的那个）。
 * 不做类型推断：**一切都是字符串**，日期和数字的解析在 plan.ts 里，
 * 那里出了错人能看见是哪一格，在这里猜错则无声无息。
 */
export function 解析CSV(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  if (!s.trim()) return [];
  const sep = 认分隔符(s.split(/\r?\n/, 1)[0] ?? "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let 引号里 = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (引号里) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else 引号里 = false;
      } else cell += c;
      continue;
    }
    if (c === '"') 引号里 = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  // 最后一行没有换行结尾时补上；全空的尾行不要
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/**
 * 二维数组收成「表头 + 数据行」，顺带把两个上限夹住。
 *
 * **列数不齐是常态**（Excel 里后面几列是空的，存出来的 csv 行长短不一），
 * 所以一律按表头的列数补齐或截断，后面的代码可以假定每行长度一样。
 */
export function 成表(rows: string[][]): { 表头: string[]; 数据: string[][]; 截断了?: { 行?: number; 列?: number } } {
  if (rows.length === 0) return { 表头: [], 数据: [] };
  const 原列数 = rows[0].length;
  const 列数 = Math.min(原列数, 列数上限);
  const 表头 = rows[0].slice(0, 列数).map((h) => h.trim());
  const 全部数据 = rows.slice(1);
  const 数据 = 全部数据.slice(0, 行数上限).map((r) => {
    const out = r.slice(0, 列数).map((c) => c.trim());
    while (out.length < 列数) out.push("");
    return out;
  });
  const 截断了: { 行?: number; 列?: number } = {};
  if (全部数据.length > 行数上限) 截断了.行 = 全部数据.length;
  if (原列数 > 列数上限) 截断了.列 = 原列数;
  return { 表头, 数据, ...(截断了.行 || 截断了.列 ? { 截断了 } : {}) };
}
