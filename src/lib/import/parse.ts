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
import { 字段表, 规整表头 } from "./fields";
import { DEFAULT_BUSINESS } from "../business-config";

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
  return 解析CSV带行号(text).rows;
}

/**
 * 同上，外加每一行在原文里是第几行（从 1 数）——用 Excel 打开这个 csv 时人看到的那个行号。
 * 空行丢掉了、表头上面的标题行丢掉了，报错时还得说得出「第 N 行」是 Excel 里的哪一行（2026-10-04 J-058）。
 * 引号里的换行不算新的一行：Excel 里它还在同一格。
 */
export function 解析CSV带行号(text: string): { rows: string[][]; 行号: number[] } {
  const s = text.replace(/^﻿/, "");
  if (!s.trim()) return { rows: [], 行号: [] };
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
    /*
      开引号前面只有空白也算开头：「张三, "北京, 海淀"」逗号后带一个空格再开引号，手写的、别的系统导出的常见。
      原来只认 cell === ""，引号成了普通字符，「北京」「海淀」被拆成两格、后面整行错位（2026-10-04 J-056）。
      前导空白丢掉——引号里的才是这一格
    */
    if (c === '"' && cell.trim() === "") {
      引号里 = true;
      cell = "";
    }
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
  const 留 = rows.flatMap((r, i) => (r.some((x) => x.trim() !== "") ? [i] : []));
  return { rows: 留.map((i) => rows[i]), 行号: 留.map((i) => i + 1) };
}

/**
 * 二维数组收成「表头 + 数据行」，顺带把两个上限夹住。
 *
 * **列数不齐是常态**（Excel 里后面几列是空的，存出来的 csv 行长短不一），
 * 所以一律按表头的列数补齐或截断，后面的代码可以假定每行长度一样。
 */
/** 默认的列名表：默认业务配置下导入认得的那些叫法（姓名、手机号、公司……）。导入抽屉会传当前业务的那份 */
let 默认列名: Set<string> | null = null;
function 默认认列名(h: string): boolean {
  if (!默认列名) 默认列名 = new Set(字段表(DEFAULT_BUSINESS).flatMap((f) => f.别名.map(规整表头)).filter(Boolean));
  return 默认列名.has(规整表头(h));
}

export function 成表(
  原始: string[][],
  认列名: (h: string) => boolean = 默认认列名,
  /** 每一行在原表里的行号（解析CSV带行号 / 读xlsx带行号 给的）。给了就跟着切，出来是每条数据的行号 */
  原行号?: number[],
): { 表头: string[]; 数据: string[][]; 截断了?: { 行?: number; 列?: number }; 行号?: number[] } {
  if (原始.length === 0) return { 表头: [], 数据: [], ...(原行号 ? { 行号: [] } : {}) };
  /*
    表头不一定在第一行：很多名单第一行是合并的大标题（「2026 客户名单」），表头在第二、三行。
    原来按第一行定列数，标题只有一格，整张表只剩一列（第一轮 2-6、第二轮又见）。
    前 5 行里挑第一个「填了的格子不少于最宽那行一半、且至少 2 格」的当表头，上面的标题行丢掉
  */
  const 填了几格 = (r: string[]) => r.filter((x) => x.trim() !== "").length;
  const 最宽 = Math.max(...原始.slice(0, 20).map(填了几格));
  /*
    表头里不会有一串号码；数据行几乎都有（手机号）。不挑带长串数字的行，
    否则表头只起了两列名、数据每行五格时，第一位客户因为「更宽」被认成表头（第三轮 A2）。
    够宽的表头没有，就退一步：第一个至少 2 格、不带长串数字的行
  */
  /*
    只看「整格就是一个号码」的格子（第四轮 B6）：表头里写「手机号（例：13800001111）」、拿日期「20260901」当列名的都放过
  */
  const 号码格 = (x: string) => {
    const t = x.trim();
    if (!/^[+\d\s\-()（）]+$/.test(t) || (t.match(/\d/g)?.length ?? 0) < 7) return false;
    return !/^(19|20)\d{2}[-/.]?(0?[1-9]|1[0-2])[-/.]?(0?[1-9]|[12]\d|3[01])$/.test(t);
  };
  const 像表头 = (r: string[]) => !r.some(号码格);
  const 前几行 = 原始.slice(0, 5);
  /*
    先找「认得出列名」的那一行（第五轮 A2）：有一格是姓名、手机号、公司这类我们本来就认的叫法，它就是表头。
    大标题、数据行都认不出任何列名；号码写成什么样（带分机、带字、.0 尾巴）、第一位有没有留号码都不影响。
    前两次都是拿「格子像不像号码」去猜，堵上一头漏另一头。
    一个都认不出（英文表头、自己起的叫法）才退回老办法：够宽、不带号码格的那一行
  */
  let 表头行 = 前几行.findIndex((r) => 填了几格(r) >= 2 && r.some((x) => x.trim() !== "" && 认列名(x)));
  if (表头行 < 0) 表头行 = 前几行.findIndex((r) => 填了几格(r) >= Math.max(2, Math.ceil(最宽 / 2)) && 像表头(r));
  if (表头行 < 0) 表头行 = 前几行.findIndex((r) => 填了几格(r) >= 2 && 像表头(r));
  const rows = 表头行 > 0 ? 原始.slice(表头行) : 原始;
  // 列数取表头和数据里最宽的那一行：表头后面几格空着、数据却有值的，不该被截掉
  const 原列数 = Math.max(rows[0].length, ...rows.slice(1, 200).map((r) => r.length));
  const 列数 = Math.min(原列数, 列数上限);
  /*
    表头也补齐到列数：表头只写 2 列、数据 5 格时，原来表头就是 2 格，映射跟着只有 2 格，
    后 3 列连「没对上的列」都算不上，原文一个字不进备注（2026-10-04 J-056）。补的是空名，出处在 plan.ts 里按「第 N 列」写
  */
  /*
    零宽字符（\u200b 一类）去掉：小满的模板地址里就夹着一串，看不见、搜不到，进了备注还会让「同一句不再添」认不出是同一句（B.7）
  */
  const 清 = (c: string) => c.replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim();
  const 表头 = rows[0].slice(0, 列数).map(清);
  while (表头.length < 列数) 表头.push("");
  const 全部数据 = rows.slice(1);
  const 数据 = 全部数据.slice(0, 行数上限).map((r) => {
    const out = r.slice(0, 列数).map(清);
    while (out.length < 列数) out.push("");
    return out;
  });
  const 截断了: { 行?: number; 列?: number } = {};
  if (全部数据.length > 行数上限) 截断了.行 = 全部数据.length;
  if (原列数 > 列数上限) 截断了.列 = 原列数;
  const 行号 = 原行号 ? 原行号.slice(Math.max(表头行, 0) + 1, Math.max(表头行, 0) + 1 + 数据.length) : undefined;
  return { 表头, 数据, ...(截断了.行 || 截断了.列 ? { 截断了 } : {}), ...(行号 ? { 行号 } : {}) };
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
