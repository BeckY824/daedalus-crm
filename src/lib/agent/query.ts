/**
 * 通用查询：受限规格 → Prisma 查询。
 *
 * **模型不写 SQL。** 它只吐一段 JSON（查哪张表、筛什么、排什么、取几条），
 * 由这里翻成 Prisma 调用。和 `lib/report-query.ts` 是同一条路子，理由也一样：
 * 模型永远碰不到数据库，最坏结果是「这个问题答不了」，不会是查错或注入。
 *
 * 那些常见的 SQL 护栏——只允许 SELECT、禁子查询、强制 LIMIT——在这儿
 * **不是拦住的，是表达不出来**：这个规格里压根没有「写」和「子查询」这两个概念，
 * `取` 有硬上限。少一个 SQL 解析器，也就少了它那一串出名的绕过法
 * （注释、UNION、CTE、ATTACH、load_extension）。
 *
 * 为什么要它：十一个专用工具各自只认自己那几个参数，答不了
 * 「联系人里几个是母亲」（联系人根本没有工具）、「哪条线索最久没动」（不能排序）、
 * 「9 月签约的学员里哪几个是小红老师带来的」（要跨一张表）。
 *
 * **它的失败模式和别的工具不同。** 别的工具答不出来就是答不出来；
 * 这个会「查错了还很自信地报个数」——更隐蔽。所以 `说人话()` 是配套，不是装饰：
 * 过程条上必须把它到底查了什么原样写出来，让人能核对。
 */
import { dayjs } from "../utils";
import {
  FOLLOW_STATUSES,
  DECISION_STATUSES,
  LEAD_STATUSES,
  OPP_STAGES,
  OPP_STATUSES,
  GRADES,
  FOLLOW_TYPES,
  FOLLOW_METHODS,
  FOLLOW_RECORD_STATUSES,
} from "../constants";

/* ---------- 字段白名单 ---------- */

export type 字段型 = "文本" | "数字" | "日期" | "枚举" | "真假";

export type 字段 = {
  /** Prisma 里的列名 */
  列: string;
  /** 给人和模型看的名字 */
  名: string;
  型: 字段型;
  /** 枚举的合法取值。填了的话，不在里面的值直接拒绝——拼错一个字不该悄悄查出 0 条 */
  取值?: readonly string[];
};

const 字段们 = <T extends Record<string, 字段>>(t: T) => t;

/**
 * 每张表开放哪些字段。**不在这儿的字段查不了**，也不该靠模型自觉。
 *
 * 刻意没开的：密码、token、各种 id 外键（id 对人没有意义，跨表走 `关联`）、
 * 以及 AI 对话那几张表（那是用户自己的思考过程，不是业务数据）。
 */
export const 表们 = {
  客户: {
    模型: "customer" as const,
    名: "客户",
    字段: 字段们({
      姓名: { 列: "name", 名: "姓名", 型: "文本" },
      电话: { 列: "phone", 名: "电话", 型: "文本" },
      学校: { 列: "school", 名: "学校", 型: "文本" },
      年级: { 列: "grade", 名: "年级", 型: "枚举", 取值: GRADES },
      专业: { 列: "major", 名: "专业", 型: "文本" },
      跟进状态: { 列: "followStatus", 名: "跟进状态", 型: "枚举", 取值: FOLLOW_STATUSES },
      决策状态: { 列: "decisionStatus", 名: "决策状态", 型: "枚举", 取值: DECISION_STATUSES },
      预计签约: { 列: "expectedSignAt", 名: "预计签约时间", 型: "日期" },
      最近跟进: { 列: "lastFollowAt", 名: "最近跟进时间", 型: "日期" },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  线索: {
    模型: "lead" as const,
    名: "线索",
    字段: 字段们({
      名称: { 列: "name", 名: "线索名称", 型: "文本" },
      联系人: { 列: "contact", 名: "联系人", 型: "文本" },
      电话: { 列: "phone", 名: "电话", 型: "文本" },
      邮箱: { 列: "email", 名: "邮箱", 型: "文本" },
      行业: { 列: "industry", 名: "行业", 型: "文本" },
      来源: { 列: "source", 名: "来源", 型: "文本" },
      状态: { 列: "status", 名: "状态", 型: "枚举", 取值: LEAD_STATUSES },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
      转化时间: { 列: "convertedAt", 名: "转化时间", 型: "日期" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  商机: {
    模型: "opportunity" as const,
    名: "商机",
    字段: 字段们({
      名称: { 列: "name", 名: "商机名称", 型: "文本" },
      金额: { 列: "amount", 名: "金额", 型: "数字" },
      阶段: { 列: "stage", 名: "阶段", 型: "枚举", 取值: OPP_STAGES },
      状态: { 列: "status", 名: "状态", 型: "枚举", 取值: OPP_STATUSES },
      成交概率: { 列: "probability", 名: "成交概率", 型: "数字" },
      预计成交: { 列: "expectedDealAt", 名: "预计成交时间", 型: "日期" },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  签约: {
    模型: "contract" as const,
    名: "签约记录",
    字段: 字段们({
      金额: { 列: "amount", 名: "签约金额", 型: "数字" },
      签约日: { 列: "signedAt", 名: "签约日期", 型: "日期" },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
    }),
  },
  联系人: {
    模型: "contact" as const,
    名: "联系人",
    字段: 字段们({
      姓名: { 列: "name", 名: "姓名", 型: "文本" },
      关系: { 列: "position", 名: "与学员的关系", 型: "文本" },
      电话: { 列: "phone", 名: "电话", 型: "文本" },
      邮箱: { 列: "email", 名: "邮箱", 型: "文本" },
      微信: { 列: "wechat", 名: "微信", 型: "文本" },
      关键联系人: { 列: "isPrimary", 名: "是否关键联系人", 型: "真假" },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  跟进记录: {
    模型: "followUp" as const,
    名: "跟进记录",
    字段: 字段们({
      类型: { 列: "type", 名: "类型", 型: "枚举", 取值: FOLLOW_TYPES.map((t) => t.value) },
      标题: { 列: "title", 名: "标题", 型: "文本" },
      内容: { 列: "content", 名: "内容", 型: "文本" },
      状态: { 列: "status", 名: "状态", 型: "枚举", 取值: FOLLOW_RECORD_STATUSES },
      时长秒: { 列: "duration", 名: "时长（秒）", 型: "数字" },
      发生时间: { 列: "occurredAt", 名: "发生时间", 型: "日期" },
    }),
  },
  跟进计划: {
    模型: "followPlan" as const,
    名: "跟进计划",
    字段: 字段们({
      主题: { 列: "subject", 名: "主题", 型: "文本" },
      计划时间: { 列: "plannedAt", 名: "计划时间", 型: "日期" },
      方式: { 列: "method", 名: "方式", 型: "枚举", 取值: FOLLOW_METHODS },
      已完成: { 列: "done", 名: "是否已完成", 型: "真假" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  任务: {
    模型: "task" as const,
    名: "任务",
    字段: 字段们({
      标题: { 列: "title", 名: "标题", 型: "文本" },
      截止时间: { 列: "dueAt", 名: "截止时间", 型: "日期" },
      已完成: { 列: "done", 名: "是否已完成", 型: "真假" },
      完成时间: { 列: "doneAt", 名: "完成时间", 型: "日期" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
  渠道: {
    模型: "channel" as const,
    名: "渠道",
    字段: 字段们({
      名称: { 列: "name", 名: "渠道名称", 型: "文本" },
      电话: { 列: "phone", 名: "电话", 型: "文本" },
      备注: { 列: "remark", 名: "备注", 型: "文本" },
      启用: { 列: "active", 名: "是否启用", 型: "真假" },
      建档时间: { 列: "createdAt", 名: "建档时间", 型: "日期" },
    }),
  },
} as const;

export type 表名 = keyof typeof 表们;

/**
 * 跨表：**只走这张表上的一跳**。
 *
 * 为什么不给任意层数：深层嵌套的性能和过程条可读性都会崩，
 * 而「查错了还很自信地报个数」恰恰最容易出在那儿——
 * 一句「小红老师带来的学员的商机的跟进记录」，人核对不动。
 * 一跳覆盖了绝大多数真实问法，而且每一跳都能写进过程条。
 */
export const 关联们: Record<string, { 从: 表名; 列: string; 到: 表名; 名: string }> = {
  "客户.来源渠道": { 从: "客户", 列: "channel", 到: "渠道", 名: "来源渠道" },
  "商机.客户": { 从: "商机", 列: "customer", 到: "客户", 名: "所属客户" },
  "签约.客户": { 从: "签约", 列: "customer", 到: "客户", 名: "所属客户" },
  "联系人.客户": { 从: "联系人", 列: "customer", 到: "客户", 名: "所属客户" },
  "跟进记录.客户": { 从: "跟进记录", 列: "customer", 到: "客户", 名: "所属客户" },
  "跟进计划.客户": { 从: "跟进计划", 列: "customer", 到: "客户", 名: "所属客户" },
  "任务.客户": { 从: "任务", 列: "customer", 到: "客户", 名: "所属客户" },
};

/* ---------- 规格 ---------- */

export const 运算符 = {
  包含: { 名: "包含", 适用: ["文本"] },
  等于: { 名: "是", 适用: ["文本", "枚举", "数字", "真假"] },
  不等于: { 名: "不是", 适用: ["文本", "枚举", "数字", "真假"] },
  属于: { 名: "属于", 适用: ["枚举", "文本"] },
  大于: { 名: "大于", 适用: ["数字"] },
  小于: { 名: "小于", 适用: ["数字"] },
  不早于: { 名: "不早于", 适用: ["日期"] },
  不晚于: { 名: "不晚于", 适用: ["日期"] },
  最近天数: { 名: "最近", 适用: ["日期"] },
  为空: { 名: "为空", 适用: ["文本", "日期", "数字", "枚举"] },
  非空: { 名: "不为空", 适用: ["文本", "日期", "数字", "枚举"] },
} as const;
export type 运算 = keyof typeof 运算符;

export type 条件 = { 字段: string; 运算: 运算; 值?: string | number | boolean | string[] };

export type 查询规格 = {
  表: 表名;
  条件: 条件[];
  /** 一跳关联上的筛选。key 是 关联们 里的路径名 */
  关联?: { 路径: string; 条件: 条件[] };
  排序?: { 字段: string; 降序: boolean };
  取: number;
  /** 只要个数，不要名单。问「有多少」时用它，省掉把一屏名字喂回模型 */
  只计数?: boolean;
  /** 按某字段分组计数（「按跟进状态分别有多少人」） */
  分组?: string;
};

/** 一次最多给多少行。模型给多少都收进这个上限——上下文是要按 token 付钱的 */
export const 取数上限 = 50;
const 分组上限 = 20;

/* ---------- 校验 ---------- */

class 查询错 extends Error {}
/** 给人看的中文错误。模型拿到它会重试，人在过程条上也看得懂为什么没查成 */
const 错 = (s: string) => new 查询错(s);

function 认表(v: unknown): 表名 {
  const s = typeof v === "string" ? v.trim() : "";
  if (s in 表们) return s as 表名;
  throw 错(`没有「${s || "(空)"}」这张表。能查的：${Object.keys(表们).join("、")}`);
}

function 认字段(表: 表名, v: unknown): 字段 {
  const s = typeof v === "string" ? v.trim() : "";
  const 表定义 = 表们[表];
  const f = (表定义.字段 as Record<string, 字段>)[s];
  if (!f) {
    throw 错(`「${表定义.名}」上没有「${s || "(空)"}」这个字段。能用的：${Object.keys(表定义.字段).join("、")}`);
  }
  return f;
}

function 认日期(v: unknown, 字段名: string): Date {
  const d = dayjs(typeof v === "string" || typeof v === "number" ? v : "");
  if (!d.isValid()) throw 错(`「${字段名}」要一个能认的日期（YYYY-MM-DD），给的是「${String(v)}」`);
  return d.toDate();
}

function 认条件(表: 表名, raw: unknown): 条件 {
  const r = (raw ?? {}) as Record<string, unknown>;
  const f = 认字段(表, r.字段);
  const op = typeof r.运算 === "string" ? (r.运算.trim() as 运算) : ("" as 运算);
  if (!(op in 运算符)) {
    throw 错(`不认识的运算「${String(r.运算)}」。能用的：${Object.keys(运算符).join("、")}`);
  }
  const 适用 = 运算符[op].适用 as readonly 字段型[];
  if (!适用.includes(f.型)) {
    throw 错(`「${f.名}」是${f.型}，不能用「${运算符[op].名}」。它能用：${Object.entries(运算符).filter(([, v]) => (v.适用 as readonly 字段型[]).includes(f.型)).map(([k]) => k).join("、")}`);
  }

  // 为空 / 非空不带值；其余必须带
  if (op === "为空" || op === "非空") return { 字段: String(r.字段), 运算: op };
  if (r.值 == null || r.值 === "") throw 错(`「${f.名} ${运算符[op].名}」少了一个值`);

  if (op === "属于") {
    const xs = Array.isArray(r.值) ? r.值.map((x) => String(x).trim()).filter(Boolean) : [String(r.值).trim()];
    if (!xs.length) throw 错(`「${f.名} 属于」要至少一个值`);
    if (f.取值) for (const x of xs) 校枚举(f, x);
    return { 字段: String(r.字段), 运算: op, 值: xs };
  }
  if (op === "最近天数") {
    const n = Number(r.值);
    if (!Number.isFinite(n) || n <= 0 || n > 3650) throw 错(`「最近多少天」要 1~3650 之间的数，给的是「${String(r.值)}」`);
    return { 字段: String(r.字段), 运算: op, 值: Math.round(n) };
  }
  if (f.型 === "数字") {
    const n = Number(r.值);
    if (!Number.isFinite(n)) throw 错(`「${f.名}」要一个数，给的是「${String(r.值)}」`);
    return { 字段: String(r.字段), 运算: op, 值: n };
  }
  if (f.型 === "真假") {
    const b = r.值 === true || r.值 === "true" || r.值 === "是" || r.值 === 1;
    return { 字段: String(r.字段), 运算: op, 值: b };
  }
  if (f.型 === "日期") {
    认日期(r.值, f.名); // 只校验，存原样字符串，编译时再转
    return { 字段: String(r.字段), 运算: op, 值: String(r.值) };
  }
  const s = String(r.值).trim().slice(0, 100);
  if (f.取值 && op !== "包含") 校枚举(f, s);
  return { 字段: String(r.字段), 运算: op, 值: s };
}

/**
 * 枚举值拼错了要**当场报错**，不能当成一个普通字符串查下去。
 * 查「跟进状态 = 意向高」（正确的是「意向较高」）会如实返回 0 条，
 * 而模型会照着 0 条答「一位都没有」——这正是「查错了还很自信地报个数」。
 */
function 校枚举(f: 字段, v: string) {
  if (f.取值 && !f.取值.includes(v)) {
    throw 错(`「${f.名}」没有「${v}」这个取值。只能是：${f.取值.join(" / ")}`);
  }
}

export function 校验规格(raw: unknown): 查询规格 {
  const r = (raw ?? {}) as Record<string, unknown>;
  const 表 = 认表(r.表);

  const 条件 = (Array.isArray(r.条件) ? r.条件 : []).slice(0, 8).map((c) => 认条件(表, c));

  let 关联: 查询规格["关联"];
  if (r.关联 && typeof r.关联 === "object") {
    const a = r.关联 as Record<string, unknown>;
    const 路径 = typeof a.路径 === "string" ? a.路径.trim() : "";
    const 定义 = 关联们[路径];
    if (!定义) {
      const 可用 = Object.keys(关联们).filter((k) => 关联们[k].从 === 表);
      throw 错(
        可用.length
          ? `「${表们[表].名}」上没有「${路径 || "(空)"}」这条关联。能走的：${可用.join("、")}`
          : `「${表们[表].名}」没有可以跨的表，去掉「关联」再查`,
      );
    }
    if (定义.从 !== 表) throw 错(`「${路径}」是从「${定义.从}」出发的，不是「${表}」`);
    const 子条件 = (Array.isArray(a.条件) ? a.条件 : []).slice(0, 4).map((c) => 认条件(定义.到, c));
    if (!子条件.length) throw 错(`走了「${路径}」却没给任何条件——那跟不跨表是一回事`);
    关联 = { 路径, 条件: 子条件 };
  }

  let 排序: 查询规格["排序"];
  if (r.排序 && typeof r.排序 === "object") {
    const s = r.排序 as Record<string, unknown>;
    认字段(表, s.字段); // 不在白名单里的字段不能当排序键
    排序 = { 字段: String(s.字段), 降序: s.降序 !== false };
  }

  let 分组: string | undefined;
  if (r.分组 != null && r.分组 !== "") {
    const f = 认字段(表, r.分组);
    if (f.型 === "日期") throw 错(`「${f.名}」是日期，按它分组会分出成百上千组。按月看走势用 query_metric`);
    分组 = String(r.分组);
  }

  const n = Number(r.取);
  const 取 = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 取数上限) : 20;

  return { 表, 条件, 关联, 排序, 取, 只计数: r.只计数 === true, 分组 };
}

/* ---------- 翻回人话（过程条要用） ---------- */

const 值成话 = (c: 条件, f: 字段): string => {
  if (c.运算 === "属于") return (c.值 as string[]).join(" 或 ");
  if (c.运算 === "最近天数") return `${c.值} 天`;
  if (f.型 === "真假") return c.值 ? "是" : "否";
  return String(c.值);
};

function 条件成话(表: 表名, c: 条件): string {
  const f = 认字段(表, c.字段);
  if (c.运算 === "为空" || c.运算 === "非空") return `${f.名}${运算符[c.运算].名}`;
  if (c.运算 === "最近天数") return `${f.名}在最近 ${c.值} 天内`;
  return `${f.名} ${运算符[c.运算].名} ${值成话(c, f)}`;
}

/**
 * 把规格写成一句人话，**原样摆在过程条上**。
 *
 * 这是这个工具的配套，不是装饰。它的失败模式是「查错了还很自信地报个数」——
 * 比「答不出来」隐蔽得多。人得能一眼核对「它到底查的是不是我问的那个东西」，
 * 否则一个算错口径的数会被当成事实用下去。
 */
export function 说人话(s: 查询规格): string {
  const 表定义 = 表们[s.表];
  const 段: string[] = [`在${表定义.名}里`];
  if (s.条件.length) 段.push(`找 ${s.条件.map((c) => 条件成话(s.表, c)).join("、且 ")}`);
  else 段.push("找全部");
  if (s.关联) {
    const 定义 = 关联们[s.关联.路径];
    段.push(`并且${定义.名} ${s.关联.条件.map((c) => 条件成话(定义.到, c)).join("、且 ")}`);
  }
  if (s.分组) 段.push(`按${认字段(s.表, s.分组).名}分组数个数`);
  else if (s.只计数) 段.push("只数个数");
  else {
    if (s.排序) 段.push(`按${认字段(s.表, s.排序.字段).名}${s.排序.降序 ? "从大到小" : "从小到大"}排`);
    段.push(`取 ${s.取} 条`);
  }
  return 段.join("，");
}

/* ---------- 编译成 Prisma ---------- */

function 条件成where(表: 表名, c: 条件): Record<string, unknown> {
  const f = 认字段(表, c.字段);
  const 列 = f.列;
  switch (c.运算) {
    case "包含":
      return { [列]: { contains: String(c.值) } };
    case "等于":
      return { [列]: c.值 };
    case "不等于":
      return { [列]: { not: c.值 } };
    case "属于":
      return { [列]: { in: c.值 as string[] } };
    case "大于":
      return { [列]: { gt: c.值 } };
    case "小于":
      return { [列]: { lt: c.值 } };
    case "不早于":
      return { [列]: { gte: dayjs(String(c.值)).startOf("day").toDate() } };
    case "不晚于":
      // 「到 9 月 30 日」含那一天，和别处的日期区间一个口径
      return { [列]: { lte: dayjs(String(c.值)).endOf("day").toDate() } };
    case "最近天数":
      return { [列]: { gte: dayjs().subtract(Number(c.值), "day").startOf("day").toDate() } };
    case "为空":
      return { [列]: null };
    case "非空":
      return { [列]: { not: null } };
  }
}

export function 编译(s: 查询规格): { where: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take: number } {
  const and = s.条件.map((c) => 条件成where(s.表, c));
  if (s.关联) {
    const 定义 = 关联们[s.关联.路径];
    and.push({ [定义.列]: { is: { AND: s.关联.条件.map((c) => 条件成where(定义.到, c)) } } });
  }
  return {
    where: and.length ? { AND: and } : {},
    orderBy: s.排序 ? { [认字段(s.表, s.排序.字段).列]: s.排序.降序 ? ("desc" as const) : ("asc" as const) } : undefined,
    take: s.取,
  };
}

export { 分组上限 };
