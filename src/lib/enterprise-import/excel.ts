/**
 * Excel / CSV 兜底：飞书、钉钉导出的文件传上来，读成 原始记录，后面和接口同一条路。
 *
 * 读表复用大批导入那一套（parse.ts / xlsx.ts）：编码、表头不在第一行、1 万行上限、行号都照它的规矩。
 * 一张表一类数据（客户 / 联系人 / 线索 / 商机 / 跟进）；是哪一类先按文件名猜，猜不出看表头，人可以改。
 * 一个 xlsx 里几张表（飞书多维表格整份导出）就拆成几张，各认各的；客户表里带着联系人几列的（钉钉客户管理导出）
 * 另拆出一张联系人表——见 读文件们。
 *
 * 原系统 ID：映射里有一列对上了「原系统 ID」就用它；没有就按关键字段算一个稳定的——
 * 同一条记录在新导出的文件里还是同一个 ID，再传一次就是一次手动的增量同步。
 * 代价也说清楚：没有 ID 列时，关键字段（比如客户名、电话）改了，会被当成一条新记录。
 */
import { createHash } from "node:crypto";
import { 文件太大, 只导了前面的话, 读不出来的话, 解析CSV带行号, 成表, 解码CSV } from "../import/parse";
import { 读xlsx各表 } from "../import/xlsx";
import { 规整表头 } from "../import/fields";
import { 规整手机号 } from "../phone";
import type { 原始记录, 实体, 列映射 } from "./types";

export type 上传文件 = { 名: string; bytes: Uint8Array; 实体?: 实体 | null };

export type 读出的表 = {
  名: string;
  /** 猜的或人指定的；null = 猜不出，要人指 */
  实体: 实体 | null;
  表头: string[];
  行: string[][];
  行号: number[];
  /** 读的时候就该告诉人的话（只导了前 1 万行、列太多……） */
  提醒: string[];
};

/** 文件名里的词 → 哪一类。顺序要紧：「客户联系人」先认联系人，「商机跟进」先认跟进 */
const 名字线索: [实体, RegExp][] = [
  ["followup", /跟进|拜访|活动记录|沟通记录|follow|activit/i],
  ["contact", /联系人|contact/i],
  ["opportunity", /商机|机会|opportunit|deal/i],
  ["lead", /线索|lead/i],
  ["customer", /客户|公司|企业|account|customer|compan/i],
];

/** 表头里的词 → 哪一类（文件名猜不出时用）。只认很有把握的几种 */
const 表头线索: [实体, string[]][] = [
  ["followup", ["跟进内容", "跟进方式", "跟进时间", "沟通内容", "拜访时间", "活动内容"]],
  ["opportunity", ["商机名称", "商机阶段", "销售阶段", "预计成交日期", "预计成交金额", "赢率"]],
  ["lead", ["线索名称", "线索状态", "线索来源"]],
  ["contact", ["联系人姓名", "职务", "职位"]],
  ["customer", ["客户名称", "公司名称", "企业名称", "客户等级"]],
];

export function 猜实体(文件名: string, 表头: readonly string[], 次要名?: string): 实体 | null {
  const 名 = 文件名.replace(/\.[^.]+$/, "");
  for (const [e, re] of 名字线索) if (re.test(名)) return e;
  const 头 = new Set(表头.map(规整表头));
  for (const [e, 词] of 表头线索) if (词.some((w) => 头.has(规整表头(w)))) return e;
  return 次要名 ? 猜实体(次要名, []) : null;
}

/**
 * 读一个文件，只要第一张表（单表的文件、旧调用方）。读不出来抛 Error（话已经是给人看的）。
 */
export function 读文件(f: 上传文件): 读出的表 {
  return 读文件们(f)[0];
}

/**
 * 读一个文件里的每一张表。读不出来抛 Error（话已经是给人看的）。
 *
 * - CSV、只有一张表的 xlsx：表名就是文件名，和以前一样；
 * - 几张表的 xlsx：每张叫「文件名·表名」，类别先看表名、再看表头、最后看文件名；隐藏的表、空表不读；
 * - 客户表里有「联系人姓名 / 联系人手机……」几列（一行客户带一个联系人）：这几列拆成一张「（联系人）」表，
 *   带着客户名称（和客户 ID，有的话）挂回去；客户表里去掉这几列，一行重复导出的客户只留一行。
 *
 * 表头空着的列叫「第 N 列」，重名的列后面加（2）（3）——原始记录按列名存，同名会互相盖掉。
 */
export function 读文件们(f: 上传文件): 读出的表[] {
  const 大 = 文件太大(f.名, f.bytes.byteLength);
  if (大) throw new Error(大);
  let 原们: { 名: string; rows: string[][]; 行号: number[] }[];
  try {
    原们 = /\.xlsx$/i.test(f.名) ? 读xlsx各表(f.bytes) : [{ 名: "", ...解析CSV带行号(解码CSV(f.bytes)) }];
  } catch (e) {
    throw new Error(`${f.名}：${读不出来的话(e)}`);
  }
  if (!原们.length) throw new Error(`${f.名}：里面的表都是空的`);
  const 多表 = 原们.length > 1;
  return 原们.flatMap((原) => {
    const 名 = 多表 ? `${f.名}·${原.名}` : f.名;
    const t = 成读出的表(名, 原);
    t.实体 = (多表 ? null : f.实体) ?? (多表 ? 猜实体(原.名, t.表头, f.名) : 猜实体(f.名, t.表头));
    return 拆联系人(t);
  });
}

function 成读出的表(名: string, 原: { rows: string[][]; 行号: number[] }): 读出的表 {
  const t = 成表(原.rows, undefined, 原.行号);
  const 见过 = new Map<string, number>();
  const 表头 = t.表头.map((h, i) => {
    const base = h || `第 ${i + 1} 列`;
    const n = (见过.get(base) ?? 0) + 1;
    见过.set(base, n);
    return n === 1 ? base : `${base}（${n}）`;
  });
  // 整行空着的不算数据（导出文件末尾常带几行空行）
  const 行: string[][] = [];
  const 行号: number[] = [];
  t.数据.forEach((r, i) => {
    if (r.every((x) => x === "")) return;
    行.push(r);
    行号.push(t.行号?.[i] ?? i + 2);
  });
  const 提醒: string[] = [];
  const 截 = 只导了前面的话(t.截断了);
  if (截) 提醒.push(截);
  return { 名, 实体: null, 表头, 行, 行号, 提醒 };
}

/* ───────────── 客户表里带联系人：拆成两张 ───────────── */

/** 「联系人」开头、说的是这个人的列；「联系人数」「联系人数量」这种是客户自己的统计，留在客户表 */
function 是联系人列(h: string): boolean {
  const k = 规整表头(h);
  return k.startsWith(规整表头("联系人")) && !/^联系人(数|数量|个数|总数)$/.test(k);
}
const 联系人名列 = ["联系人", "联系人姓名", "联系人名称", "联系人名字"].map(规整表头);
const 客户名列 = ["客户名称", "公司名称", "企业名称", "客户名", "客户全称", "客户", "公司", "名称"].map(规整表头);
const 客户ID列 = ["客户ID", "客户编号", "记录ID", "ID", "编号", "数据ID", "唯一ID"].map(规整表头);

export function 拆联系人(t: 读出的表): 读出的表[] {
  if (t.实体 !== "customer") return [t];
  const 人列 = t.表头.flatMap((h, i) => (是联系人列(h) ? [i] : []));
  if (!人列.some((i) => 联系人名列.includes(规整表头(t.表头[i])))) return [t];
  const 找 = (候选: string[]) => {
    for (const k of 候选) {
      const i = t.表头.findIndex((h, j) => !人列.includes(j) && 规整表头(h) === k);
      if (i >= 0) return i;
    }
    return -1;
  };
  const 名i = 找(客户名列);
  if (名i < 0) return [t];
  const ID列 = 找(客户ID列);

  const 人头 = 人列.map((i) => {
    const 剩 = t.表头[i].replace(/^\s*联系人\s*/, "");
    return 剩 && !/^(名称|名字)$/.test(剩) ? 剩 : "姓名";
  });
  const 联系人: 读出的表 = {
    名: `${t.名}（联系人）`,
    实体: "contact",
    表头: [...(ID列 >= 0 ? ["所属客户ID"] : []), "所属客户", ...人头],
    行: [],
    行号: [],
    提醒: [],
  };
  const 见过人 = new Set<string>();
  const 客户: 读出的表 = { ...t, 表头: t.表头.filter((_, i) => !人列.includes(i)), 行: [], 行号: [], 提醒: [...t.提醒] };
  const 见过客户 = new Set<string>();
  let 重复客户 = 0;
  t.行.forEach((r, k) => {
    const 留 = r.filter((_, i) => !人列.includes(i));
    const 键 = JSON.stringify(留);
    if (见过客户.has(键)) 重复客户++;
    else {
      见过客户.add(键);
      客户.行.push(留);
      客户.行号.push(t.行号[k]);
    }
    const 人 = 人列.map((i) => r[i] ?? "");
    if (人.every((v) => !v.trim())) return;
    const 人键 = [r[ID列] ?? "", r[名i] ?? "", ...人].join("\u0001");
    if (见过人.has(人键)) return;
    见过人.add(人键);
    联系人.行.push([...(ID列 >= 0 ? [r[ID列] ?? ""] : []), r[名i] ?? "", ...人]);
    联系人.行号.push(t.行号[k]);
  });
  客户.提醒.push(`这张表里有联系人的几列（${人列.map((i) => t.表头[i]).join("、")}），已拆成「${联系人.名}」单独导`);
  if (重复客户) 客户.提醒.push(`同一家客户因为有几个联系人重复出现了 ${重复客户} 行，客户只留一行`);
  return 联系人.行.length ? [客户, 联系人] : [客户];
}

/** 没有 ID 列时，拿来算稳定 ID 的关键字段（标准字段名）。挑的是「换一次导出不会变」的那几格 */
const 关键字段: Record<实体, string[]> = {
  customer: ["name", "phone"],
  contact: ["customerRef", "customerName", "name", "phone", "email"],
  lead: ["name", "phone", "email"],
  opportunity: ["customerRef", "customerName", "name"],
  followup: ["customerRef", "customerName", "occurredAt", "type", "title", "content"],
};

function 规整关键值(字段: string, v: string): string {
  const s = v.replace(/[\s　]+/g, " ").trim();
  if (字段 === "phone") return 规整手机号(s);
  return s.toLowerCase();
}

export function 算稳定ID(e: 实体, 标准值: Record<string, string>): string {
  const 料 = 关键字段[e].map((k) => `${k}=${规整关键值(k, 标准值[k] ?? "")}`).join("\u0001");
  return "h:" + createHash("sha1").update(`${e}\u0001${料}`).digest("hex").slice(0, 20);
}

/**
 * 读出的表 + 这一类的列映射 → 原始记录。
 * 字段按原列名存（和接口来的一样，映射在清洗时才用），外部 ID 按上面的规矩定。
 */
export function 成记录(t: 读出的表, e: 实体, 列: 列映射): 原始记录[] {
  const ID列 = t.表头.findIndex((h) => 列[h] === "id");
  return t.行.map((r, i) => {
    const 字段: Record<string, string> = {};
    const 标准值: Record<string, string> = {};
    t.表头.forEach((h, j) => {
      const v = r[j] ?? "";
      字段[h] = v;
      const std = 列[h];
      if (std && v && !标准值[std]) 标准值[std] = v;
    });
    const 原ID = ID列 >= 0 ? (r[ID列] ?? "").trim() : "";
    return { 实体: e, 外部ID: 原ID || 算稳定ID(e, 标准值), 字段, 行号: t.行号[i], 出处: t.名 };
  });
}
