/**
 * 试跑：读进来的表（或接口给的原始记录）→ 猜映射 → 清洗 → 出一份报告，存成一个「preview」批次。
 * 一条都不写进客户 / 联系人这些表——人看过报告、改好映射，正式导入（apply.ts）再照批次里存的那份 plan 写。
 *
 * 报告里有：每类多少条（新建 / 连上已有的 / 并入 / 跳过 / 要看一眼）、每个问题在哪个文件第几行、
 * 每列落到了哪个字段（规则 / AI / 手动认的）、阶段这些值怎么换的、负责人怎么对的、每类几条样例，
 * 还有一条公海提醒：开了「N 天没跟进掉公海」时，按原系统的跟进时间算，导进来马上会掉多少个客户。
 *
 * 改映射重新试跑（重新试跑）：从批次里取上次读出的表，不用再传一次文件；人改的标成「手动」，上次 AI 认的照留，
 * 不再问一次 AI（不重复花客户的钱）。
 */
import { prisma } from "@/lib/prisma";
import { getBusiness } from "@/lib/business";
import { 负责人候选, 唯一负责人 } from "@/lib/owners";
import { 看全部 } from "@/lib/team-scope";
import { 号键 } from "@/lib/phone";
import { 不掉公海的状态, 公海截止 } from "@/lib/pool";
import { AI补清洗, 去掉AI清洗, 格式说明键, 同一家说明键, type 清洗器 } from "./ai-clean";
import { 预演, type 预演计数 } from "./apply";
import { 清洗, 数一数, 名键, type 本地索引, type 清洗结果 } from "./clean";
import { 成记录, 拆联系人, 拆出的客户ID列, type 读出的表 } from "./excel";
import { 猜映射, 说明键, 值对照, 值说法, 进备注, type 建议器, type 成员, type 表概要 } from "./mapping";
import { 实体顺序, 字段中文, 实体名, 格式类们, type 格式类, type 来源, type 实体, type 映射, type 原始记录, type 问题, type 待写, type 值对照名, type 列映射 } from "./types";

/** 报告里最多列多少条问题（存进库的那份）；总数另记，界面上说「还有 N 条没列出」 */
const 问题上限 = 5000;
/** 每类给几条样例 */
const 样例数 = 5;
/** 接口来的记录没有「表」，拿前多少条当样例给猜映射看 */
const 概要行数 = 200;

type 说明 = "规则" | "AI" | "手动";

export type 报告列 = { 表头: string; 字段: string; 字段名: string; 说明?: 说明; 样例: string[] };

export type 试跑报告 = {
  来源: 来源;
  生成于: string;
  /** Excel 才有：每个文件读出了什么；实体 null = 认不出是哪一类，要人选（这个文件这次没算进来） */
  文件: { 名: string; 实体: 实体 | null; 行数: number; 提醒: string[]; 拆自?: string }[];
  /** 整批要告诉人的话：读文件的、猜映射的（AI 没成功、必填列没认出……）、公海的 */
  提醒: string[];
  合计: { 记录: number; 待写: number; 跳过: number; 提醒: number };
  按类: ReturnType<typeof 数一数>;
  问题: 问题[];
  问题总数: number;
  问题分类: { 实体: 实体; 级别: 问题["级别"]; 类别: 问题["类别"]; 数: number }[];
  映射: {
    列: Partial<Record<实体, 报告列[]>>;
    值: { 名: 值对照名; 叫法: string; 原值: string; 我们的值: string; 说明?: 说明 }[];
    负责人: { 写法: string; 成员Id: string; 成员名: string; 说明?: 说明 }[];
    默认负责人: { id: string; 名: string };
  };
  /** AI 清洗补认的（和人在报告里改的）：格式 = 规则认不出的格子认成了什么；同一家 = 名字很像的两家是不是同一家 */
  清洗?: {
    /** 认作 空 = 不认，原值照样进备注 */
    格式: { 类: 格式类; 原值: string; 认作: string; 说明?: 说明 }[];
    同一家: { 键: string; 前: string; 后: string; 是: boolean; 说明?: 说明 }[];
  };
  样例: Partial<Record<实体, Omit<待写, "原始" | "指纹">[]>>;
  /** 开了自动掉公海才有 */
  公海: { 天数: number; 会掉: number } | null;
  /**
   * 按正式导入的写法真写一遍再回滚数出来的：正式导入写完的数就是这个（合计.跳过 已含清洗时跳过的）。
   * 计划太大、增量同步、或没跑成时为 null
   */
  预演: { 按类: Partial<Record<实体, 预演计数>>; 合计: 预演计数 } | null;
};

/* ───────────────────────── 我们这边已有的 ───────────────────────── */

/**
 * 清洗要的本地索引。客户要看全部（团队版业务员也得认出同事的客户，不另建一份），和大批导入一个口径。
 * 电话按号键整串比；带分机认主号那种细的，正式写入时 查完再写 里再认一次
 */
export async function 读本地索引(源: 来源): Promise<本地索引> {
  const [客户们, 商机们, 对照们] = await 看全部(async () =>
    Promise.all([
      prisma.customer.findMany({ select: { id: true, name: true, phone: true } }),
      prisma.opportunity.findMany({ select: { id: true, customerId: true, name: true } }),
      prisma.entExternalRef.findMany({ where: { source: 源 }, select: { entity: true, externalId: true, targetId: true, fingerprint: true } }),
    ]),
  );
  const 索引: 本地索引 = { 引用: new Map(), 指纹: new Map(), 客户名: new Map(), 客户号: new Map(), 商机名: new Map() };
  const 加 = (m: Map<string, string[]>, k: string, id: string) => {
    if (!k) return;
    const a = m.get(k);
    if (a) a.push(id);
    else m.set(k, [id]);
  };
  for (const c of 客户们) {
    加(索引.客户名, 名键(c.name), c.id);
    if (c.phone) 加(索引.客户号, 号键(c.phone), c.id);
  }
  for (const o of 商机们) 加(索引.商机名, `${o.customerId}|${名键(o.name)}`, o.id);
  for (const r of 对照们) {
    索引.引用.set(`${r.entity}|${r.externalId}`, r.targetId);
    索引.指纹!.set(`${r.entity}|${r.externalId}`, r.fingerprint);
  }
  return 索引;
}

/* ───────────────────────── 试跑 ───────────────────────── */

export type 试跑参数 = {
  来源: 来源;
  用户Id: string;
  /** Excel 兜底：读出来的表 */
  表?: 读出的表[];
  /** 接口来的：原始记录（外部 ID 是原系统的） */
  记录?: 原始记录[];
  /** 不传 = 按环境和 Key 自己选；null = 不用 AI */
  建议器?: 建议器 | null;
  已有映射?: 映射 | null;
  留AI?: boolean;
  /** AI 清洗：不传 = 按环境和 Key 自己选；null = 这次不问（重新试跑，上次认的照用） */
  清洗器?: 清洗器 | null;
  /** 重新试跑：覆盖这个批次，不另开 */
  批次Id?: string;
  /** 首次全量（默认）还是增量同步（sync.ts 照已认的映射拉一次变化） */
  类型?: "full" | "sync";
};

export type 试跑结果 = { 批次Id: string; 报告: 试跑报告 };

export async function 试跑(p: 试跑参数): Promise<试跑结果> {
  // 客户表里带的联系人在这里才拆：类别这时已经定了（上传时人选的、重新试跑时人改的）。
  // 批次里存没拆的，人再改类别时照新的重拆（以前存过拆好的也没事，再拆一次不变）
  const 原表们 = p.表 ?? [];
  const 表们 = 原表们.flatMap(拆联系人);
  const 能用的表 = 表们.filter((t): t is 读出的表 & { 实体: 实体 } => !!t.实体);
  const 提醒: string[] = [];
  for (const t of 表们) {
    for (const s of t.提醒) 提醒.push(`${t.名}：${s}`);
    if (!t.实体) 提醒.push(`「${t.名}」认不出是客户、联系人、线索、商机还是跟进记录，这次没算进来，请选一下再试跑`);
  }

  // 1) 猜映射：Excel 先按表头拿一份「没 ID」的记录收原值（阶段、负责人这些），外部 ID 这时用不上
  const 概要: 表概要[] = 能用的表.length ? 能用的表.map((t) => ({ 实体: t.实体, 表头: t.表头, 行: t.行 })) : 记录成概要(p.记录 ?? []);
  const 粗记录 = 能用的表.length ? 能用的表.flatMap((t) => 成记录(t, t.实体, {})) : (p.记录 ?? []);
  const 候选: 成员[] = await 负责人候选();
  // 默认负责人要是能当负责人的人：管理员 / 停用的写的时候会被换掉，报告上就得先换好，免得报告说给 A、实际落到 B
  const 能任 = (id?: string | null) => !!id && 候选.some((c) => c.id === id);
  const 默认负责人Id = [p.已有映射?.默认负责人Id, await 唯一负责人(), p.用户Id, 候选[0]?.id].find(能任) ?? p.用户Id;
  const 猜 = await 猜映射({
    表: 概要,
    记录: 粗记录,
    候选,
    默认负责人Id,
    业务: await getBusiness(),
    建议器: p.建议器,
    已有: p.已有映射,
    留AI: p.留AI,
  });
  提醒.push(...猜.提醒);
  const m = 猜.映射;

  // 2) 定下映射后再成记录：有「原系统 ID」列的这时才用上
  const 记录 = 能用的表.length
    ? 去掉拆出的重复联系人(能用的表.flatMap((t) => 成记录(挂客户的表(t, m, 提醒), t.实体, m.列[t.实体] ?? {})), 能用的表, m, 提醒)
    : (p.记录 ?? []);

  // 3) 清洗：规则认不出的格子先问一次 AI（补认的落进 m.格式 / m.同一家，按规则再认一遍才用），再按映射洗
  // 没说用哪个清洗器、又明说了不用 AI 猜映射（每小时增量同步、测试）：也不问 AI 清洗
  const 补 = await AI补清洗(记录, m, p.清洗器 !== undefined ? p.清洗器 : p.建议器 === null ? null : undefined);
  提醒.push(...补.提醒);
  const 结果 = 清洗(记录, m, await 读本地索引(p.来源));

  // 4) 公海
  const b = await getBusiness();
  const 公海 = b.poolDays ? { 天数: b.poolDays, 会掉: 会掉公海(结果, b.poolDays) } : null;
  if (公海?.会掉) {
    提醒.push(
      `业务设置里开了「${公海.天数} 天没跟进放进公海」：按原系统的跟进时间算，有 ${公海.会掉} 个新导入的客户已经超过 ${公海.天数} 天没跟进，导入后会在下一次扫描时放进公海`,
    );
  }

  const 报告 = 成报告({ 来源: p.来源, 表们, 概要, 记录数: 记录.length, 结果, m, 候选, 提醒, 公海 });
  const 计划 = JSON.stringify(结果.待写);
  // 增量同步拉完马上就写，不用先演一遍
  if ((p.类型 ?? "full") === "full") {
    try {
      // 用存进批次的那份（过一遍 JSON），和正式导入读到的一模一样
      const 按类 = await 预演(p.来源, m, JSON.parse(计划), { id: p.用户Id, name: "" });
      if (按类) {
        const 合计: 预演计数 = { 新建: 0, 更新: 0, 跳过: 报告.合计.跳过, 冲突: 0, 失败: 0 };
        for (const c of Object.values(按类)) for (const k of Object.keys(合计) as (keyof 预演计数)[]) 合计[k] += c[k];
        报告.预演 = { 按类, 合计 };
      } else 报告.提醒.push(`这次要写 ${结果.待写.length} 条，太多了没先演一遍：下面的新建 / 更新是按清洗分的，写的时候有的会变成冲突或跳过`);
    } catch (e) {
      报告.提醒.push(`没能先演一遍（${e instanceof Error ? e.message.split("\n").pop() : String(e)}）：下面的新建 / 更新是按清洗分的，写的时候有的会变成冲突或跳过`);
    }
  }

  const 存 = {
    source: p.来源,
    kind: p.类型 ?? "full",
    status: "preview",
    userId: p.用户Id,
    report: JSON.stringify(报告),
    // 留原样给「改映射重新试跑」：Excel 存表；接口来的首次导入存原始记录（同步那批直接写，不留）
    raw: 原表们.length ? JSON.stringify(原表们) : p.记录?.length && (p.类型 ?? "full") === "full" ? JSON.stringify({ 记录: p.记录 }) : null,
    mapping: JSON.stringify(m),
    plan: 计划,
    total: 结果.待写.length,
    skipped: 报告.合计.跳过,
  };
  const 批次 = p.批次Id
    ? await prisma.entImportBatch.update({ where: { id: p.批次Id }, data: 存, select: { id: true } })
    : await prisma.entImportBatch.create({ data: 存, select: { id: true } });
  return { 批次Id: 批次.id, 报告 };
}

/**
 * 客户表里拆出来的联系人，「所属客户ID」抄的是客户表那一列的原值。那一列这次没当「原系统 ID」用的话，
 * 本批客户的外部 ID 是按字段算的，这个原值认不出本批的客户，拿去库里找还可能撞上以前导过的别的客户——清掉，按客户名称挂
 */
function 挂客户的表(t: 读出的表, m: 映射, 提醒: string[]): 读出的表 {
  if (!t.拆自ID列 || m.列.customer?.[t.拆自ID列] === "id") return t;
  const j = t.表头.indexOf(拆出的客户ID列);
  if (j < 0 || t.行.every((r) => !(r[j] ?? "").trim())) return t;
  提醒.push(`「${t.名}」的${拆出的客户ID列}抄自客户表的「${t.拆自ID列}」，这一列这次没当「原系统 ID」用，联系人按客户名称挂`);
  return { ...t, 行: t.行.map((r) => r.map((v, i) => (i === j ? "" : v))) };
}

/**
 * 一份导出里既有带联系人几列的客户表、又有单独的联系人表：同一个人两边都有，外部 ID 对不上，会导成两个。
 * 拆出来的那条，联系人表里有同名、挂同一家客户（客户 ID 或客户名称对得上）的，就不要了，按联系人表那条导
 */
function 去掉拆出的重复联系人(记录: 原始记录[], 表们: 读出的表[], m: 映射, 提醒: string[]): 原始记录[] {
  const 拆出的 = new Set(表们.filter((t) => t.拆自 && t.实体 === "contact").map((t) => t.名));
  if (!拆出的.size) return 记录;
  const 取 = (r: 原始记录, f: string) => {
    const 列 = m.列[r.实体] ?? {};
    for (const [h, v] of Object.entries(r.字段)) if (列[h] === f && v.trim()) return v.trim();
    return "";
  };
  const 客户名 = new Map(记录.filter((r) => r.实体 === "customer").map((r) => [r.外部ID, 取(r, "name")]));
  /** 这个联系人挂的客户：客户 ID、客户名称都算（只写了 ID 的按本批客户表查出名称） */
  const 人键们 = (r: 原始记录) => {
    const 人 = 名键(取(r, "name"));
    if (!人) return [];
    const ref = 取(r, "customerRef");
    const 名 = 取(r, "customerName") || (ref ? (客户名.get(ref) ?? "") : "");
    return [ref && `ID|${ref}|${人}`, 名 && `名|${名键(名)}|${人}`].filter((k): k is string => !!k);
  };
  const 联系人表有 = new Set(记录.filter((r) => r.实体 === "contact" && !拆出的.has(r.出处 ?? "")).flatMap(人键们));
  if (!联系人表有.size) return 记录;
  const 去掉 = new Map<string, number>();
  const 留 = 记录.filter((r) => {
    if (r.实体 !== "contact" || !r.出处 || !拆出的.has(r.出处) || !人键们(r).some((k) => 联系人表有.has(k))) return true;
    去掉.set(r.出处, (去掉.get(r.出处) ?? 0) + 1);
    return false;
  });
  for (const [名, n] of 去掉) 提醒.push(`「${名}」里有 ${n} 个联系人单独的联系人表里也有（同名、同一家客户），按联系人表那条导，不另导一个`);
  return 留;
}

/** 人在报告上改的：列落到哪个字段、值换成什么、负责人对谁、默认负责人、哪个文件是哪一类 */
export type 映射改动 = {
  列?: Partial<Record<实体, 列映射>>;
  值?: Partial<Record<值对照名, Record<string, string>>>;
  负责人?: Record<string, string>;
  默认负责人Id?: string;
  /** 文件名 → 哪一类 */
  文件实体?: Record<string, 实体>;
  /** 格子认作什么：类 → 原值 → 认作（空串 = 不认，照规则进备注） */
  格式?: Partial<Record<格式类, Record<string, string>>>;
  /** 两家是不是同一家：键 `前一家名键|后一家名键` */
  同一家?: Record<string, boolean>;
  /** 整块不采用 AI 清洗：AI 补的拿掉，人改过的留着 */
  不采用AI清洗?: boolean;
};

/** 改映射后重新试跑：只能改还在 preview 的批次 */
export async function 重新试跑(批次Id: string, 改: 映射改动, 用户Id: string): Promise<试跑结果> {
  const 批 = await prisma.entImportBatch.findUnique({ where: { id: 批次Id } });
  if (!批) throw new Error("找不到这次试跑，请重新上传");
  if (批.status !== "preview") throw new Error("这一批已经开始导入了，不能再改映射");
  const 原样 = (批.raw ? JSON.parse(批.raw) : null) as 读出的表[] | { 记录: 原始记录[] } | null;
  const 表们 = Array.isArray(原样) ? 原样 : [];
  const 记录 = !Array.isArray(原样) && 原样?.记录?.length ? 原样.记录 : undefined;
  if (!表们.length && !记录) throw new Error("这一批没存原表，请重新上传");
  for (const t of 表们) {
    const e = 改.文件实体?.[t.名];
    if (e) t.实体 = e;
  }
  const m = 合并改动(JSON.parse(批.mapping ?? "null"), 改);
  const out = await 试跑({
    来源: 批.source as 来源,
    用户Id,
    ...(记录 ? { 记录 } : { 表: 表们 }),
    建议器: null,
    已有映射: m,
    留AI: true,
    清洗器: null,
    批次Id,
    类型: 批.kind === "sync" ? "sync" : "full",
  });
  // 「没用 AI，只按规则认」这句在重新试跑时会误导：AI 上次认的都还在，只是这次没再问
  const 话 = out.报告.提醒;
  const i = 话.indexOf("没用 AI，只按规则认");
  if (i >= 0) 话.splice(i, 1, "改了映射重新试跑：人改的和上次 AI 认的都留着，这次没再问 AI");
  await prisma.entImportBatch.update({ where: { id: out.批次Id }, data: { report: JSON.stringify(out.报告) } });
  return out;
}

/** 人改的落进映射，标成「手动」；之后猜映射、重新试跑都不再动它们 */
export function 合并改动(已有: 映射 | null, 改: 映射改动): 映射 | null {
  if (!已有) return null;
  const m: 映射 = structuredClone(已有);
  m.说明 ??= {};
  for (const [e, 列] of Object.entries(改.列 ?? {}) as [实体, 列映射][]) {
    const 原 = (m.列[e] ??= {});
    for (const [h, f] of Object.entries(列)) {
      原[h] = f;
      m.说明[说明键.列(e, h)] = "手动";
    }
  }
  for (const [k, 对] of Object.entries(改.值 ?? {}) as [值对照名, Record<string, string>][]) {
    for (const [v, to] of Object.entries(对)) {
      m.值[k][v] = to;
      m.说明[说明键.值(k, v)] = "手动";
    }
  }
  for (const [w, id] of Object.entries(改.负责人 ?? {})) {
    m.负责人[w] = id;
    m.说明[说明键.人(w)] = "手动";
  }
  if (改.默认负责人Id) m.默认负责人Id = 改.默认负责人Id;
  if (改.不采用AI清洗) 去掉AI清洗(m);
  for (const 类 of 格式类们) {
    for (const [v, to] of Object.entries(改.格式?.[类] ?? {})) {
      ((m.格式 ??= {})[类] ??= {})[v] = to.trim() || null;
      m.说明[格式说明键(类, v)] = "手动";
    }
  }
  for (const [k, 是] of Object.entries(改.同一家 ?? {})) {
    (m.同一家 ??= {})[k] = 是;
    m.说明[同一家说明键(k)] = "手动";
  }
  return m;
}

/* ───────────────────────── 拼报告 ───────────────────────── */

/** 接口来的记录拼成「表」给猜映射看：表头 = 这一类所有字段名，行 = 前 200 条 */
function 记录成概要(记录: readonly 原始记录[]): 表概要[] {
  const out: 表概要[] = [];
  for (const e of 实体顺序) {
    const 这类 = 记录.filter((r) => r.实体 === e);
    if (!这类.length) continue;
    const 表头 = [...new Set(这类.flatMap((r) => Object.keys(r.字段)))];
    out.push({ 实体: e, 表头, 行: 这类.slice(0, 概要行数).map((r) => 表头.map((h) => r.字段[h] ?? "")) });
  }
  return out;
}

/**
 * 新建的客户里，按导进来的跟进记录算最后一次跟进已经早于公海截止的有几个（跟进状态是已签约 / 已流失的不算）。
 * 没有跟进记录的不算：导进来那天就是创建时间，要 N 天后才轮得到。连上已有客户的也不算：
 * 正式导入只会把最近跟进往后推，不会往前拉，那些客户掉不掉和这次导入无关
 */
function 会掉公海(结果: 清洗结果, 天数: number): number {
  const 截止 = 公海截止(天数).getTime();
  const 最近 = new Map<string, number>();
  for (const w of 结果.待写) {
    if (w.实体 !== "followup" || !w.父客户 || !("外部ID" in w.父客户) || typeof w.值.occurredAt !== "string") continue;
    const t = Date.parse(w.值.occurredAt);
    if (Number.isFinite(t) && t > (最近.get(w.父客户.外部ID) ?? -Infinity)) 最近.set(w.父客户.外部ID, t);
  }
  let n = 0;
  for (const w of 结果.待写) {
    if (w.实体 !== "customer" || w.并入 || w.目标) continue;
    if (不掉公海的状态.includes(String(w.值.followStatus ?? ""))) continue;
    const t = 最近.get(w.外部ID);
    if (t !== undefined && t < 截止) n++;
  }
  return n;
}

function 成报告(p: {
  来源: 来源;
  表们: 读出的表[];
  概要: 表概要[];
  记录数: number;
  结果: 清洗结果;
  m: 映射;
  候选: 成员[];
  提醒: string[];
  公海: 试跑报告["公海"];
}): 试跑报告 {
  const { 结果, m } = p;
  const 按类 = 数一数(结果);
  const 说 = m.说明 ?? {};

  const 分类 = new Map<string, 试跑报告["问题分类"][number]>();
  for (const q of 结果.问题) {
    const k = `${q.实体}|${q.级别}|${q.类别}`;
    const c = 分类.get(k);
    if (c) c.数++;
    else 分类.set(k, { 实体: q.实体, 级别: q.级别, 类别: q.类别, 数: 1 });
  }
  // 跳过的排前面（这些不会导进来），同级按多少排
  const 问题分类 = [...分类.values()].sort((a, b) => (a.级别 === b.级别 ? b.数 - a.数 : a.级别 === "跳过" ? -1 : 1));
  const 问题 = [...结果.问题].sort((a, b) => (a.级别 === b.级别 ? 0 : a.级别 === "跳过" ? -1 : 1)).slice(0, 问题上限);

  const 列: 试跑报告["映射"]["列"] = {};
  for (const t of p.概要) {
    const 这类 = (列[t.实体] ??= []);
    const 映 = m.列[t.实体] ?? {};
    for (const [j, h] of t.表头.entries()) {
      if (这类.some((c) => c.表头 === h)) continue;
      const f = 映[h] ?? "";
      这类.push({
        表头: h,
        字段: f,
        字段名: f === 进备注 ? (t.实体 === "followup" ? "拼进内容" : "拼进备注") : f ? (字段中文[f] ?? f) : "不用",
        说明: 说[说明键.列(t.实体, h)],
        样例: [...new Set(t.行.map((r) => (r[j] ?? "").trim()).filter(Boolean))].slice(0, 3),
      });
    }
  }

  const 值: 试跑报告["映射"]["值"] = [];
  for (const k of Object.keys(值对照) as 值对照名[]) {
    for (const [v, to] of Object.entries(m.值[k])) {
      值.push({ 名: k, 叫法: 值对照[k].叫法, 原值: v, 我们的值: to ? 值说法(k, to) : "", 说明: 说[说明键.值(k, v)] });
    }
  }
  const 名字 = new Map(p.候选.map((u) => [u.id, u.name]));
  const 负责人 = Object.entries(m.负责人).map(([w, id]) => ({ 写法: w, 成员Id: id, 成员名: id ? (名字.get(id) ?? "") : "", 说明: 说[说明键.人(w)] }));

  const 清洗: NonNullable<试跑报告["清洗"]> = { 格式: [], 同一家: [] };
  for (const 类 of 格式类们) {
    for (const [v, to] of Object.entries(m.格式?.[类] ?? {})) {
      // null = 人定了不认（照原样进备注），也列出来，好改回去
      清洗.格式.push({ 类, 原值: v, 认作: to ?? "", 说明: 说[格式说明键(类, v)] });
    }
  }
  // 名键 → 原来的写法（报告给人看的是原名）
  const 原名 = new Map<string, string>();
  for (const w of 结果.待写) if (w.实体 === "customer") 原名.set(名键(String(w.值.name ?? "")), String(w.值.name ?? ""));
  for (const [k, 是] of Object.entries(m.同一家 ?? {})) {
    const i = k.indexOf("|");
    const [a, b] = [k.slice(0, i), k.slice(i + 1)];
    清洗.同一家.push({ 键: k, 前: 原名.get(a) ?? a, 后: 原名.get(b) ?? b, 是, 说明: 说[同一家说明键(k)] });
  }

  const 样例: 试跑报告["样例"] = {};
  for (const w of 结果.待写) {
    const a = (样例[w.实体] ??= []);
    if (a.length >= 样例数) continue;
    const { 原始: _原始, 指纹: _指纹, ...rest } = w;
    a.push(rest);
  }

  const 合计 = { 记录: p.记录数, 待写: 结果.待写.length, 跳过: 0, 提醒: 0 };
  for (const e of 实体顺序) {
    合计.跳过 += 按类[e].跳过;
    合计.提醒 += 按类[e].提醒;
  }

  return {
    来源: p.来源,
    生成于: new Date().toISOString(),
    文件: p.表们.map((t) => ({ 名: t.名, 实体: t.实体, 行数: t.行.length, 提醒: t.提醒, ...(t.拆自 ? { 拆自: t.拆自 } : {}) })),
    提醒: p.提醒,
    合计,
    按类,
    问题,
    问题总数: 结果.问题.length,
    问题分类,
    映射: { 列, 值, 负责人, 默认负责人: { id: m.默认负责人Id, 名: 名字.get(m.默认负责人Id) ?? "" } },
    清洗,
    样例,
    公海: p.公海,
    预演: null,
  };
}

/** 报告里一类数据的中文名（界面用） */
export { 实体名 };
