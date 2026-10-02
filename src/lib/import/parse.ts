/**
 * 文本表格 → 二维数组。
 *
 * **只有这一条管线。** 另外两个来路——xlsx 在浏览器里解析完、粘的那段文本被模型
 * 切完——立刻变成同样的二维数组（customers/ImportDrawer.tsx 里的 `收表`），
 * 从这里往后不再区分来源。
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
  /*
    分隔符看前几行里最「像表」的那一行，不只看第一行：第一行常是一个大标题（「2026 客户名单」），
    里面一个制表符都没有，原来就被认成逗号、整张表塌成一列（第二轮 r2-data）
  */
  const 前几行 = s.split(/\r?\n/, 6).filter((l) => l.trim());
  const sep = 认分隔符(前几行.reduce((最长, l) => (l.length > 最长.length ? l : 最长), 前几行[0] ?? ""));
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
    /*
      引号只在一格的开头才算「开引号」（RFC 4180）。格子中间的一个英文双引号（「张总"老客户」）是普通字符——
      原来一律当开引号，后面所有人被吞进这一格的备注，预览只剩 1 条（第二轮 r2-data A）
    */
    if (c === '"' && cell === "") 引号里 = true;
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
export function 成表(原始: string[][]): { 表头: string[]; 数据: string[][]; 截断了?: { 行?: number; 列?: number } } {
  if (原始.length === 0) return { 表头: [], 数据: [] };
  /*
    表头不一定在第一行：很多名单第一行是合并的大标题（「2026 客户名单」），表头在第二、三行。
    原来按第一行定列数，标题只有一格，整张表只剩一列（第一轮 2-6、第二轮又见）。
    前 5 行里挑第一个「填了的格子不少于最宽那行一半、且至少 2 格」的当表头，上面的标题行丢掉
  */
  const 填了几格 = (r: string[]) => r.filter((x) => x.trim() !== "").length;
  const 最宽 = Math.max(...原始.slice(0, 20).map(填了几格));
  const 表头行 = 原始.slice(0, 5).findIndex((r) => 填了几格(r) >= Math.max(2, Math.ceil(最宽 / 2)));
  const rows = 表头行 > 0 ? 原始.slice(表头行) : 原始;
  // 列数取表头和数据里最宽的那一行：表头后面几格空着、数据却有值的，不该被截掉
  const 原列数 = Math.max(rows[0].length, ...rows.slice(1, 200).map((r) => r.length));
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

/**
 * CSV 的字节 → 文字。先按 UTF-8 严格解，解不通就按 GB18030（GBK 的超集）解。
 *
 * 中文 Windows 上 Excel / WPS「另存为 CSV」默认存的是 GBK，原来一律按 UTF-8 读，
 * 整张表是乱码，表头认不出来；人手动指出手机号列以后，乱码的姓名、公司照样进库（2026-10-02 排查）。
 * 严格模式下 GBK 的字节几乎不可能恰好是合法 UTF-8，所以这个判断够用；开头的 BOM 去掉。
 */
export function 解码CSV(bytes: Uint8Array): string {
  let s: string;
  // Excel「另存为 Unicode 文本」是 UTF-16（带 BOM、制表符分隔）：按 BOM 认（第二轮 r2-data）
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    s = new TextDecoder("gb18030").decode(bytes);
  }
  return s.replace(/^\uFEFF/, "");
}
