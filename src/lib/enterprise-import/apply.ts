/**
 * 企业版导入 · 正式写入：试跑存下的待写（批次的 plan）→ 客户 / 线索 / 联系人 / 商机 / 跟进 + 对照表。
 * 首次全量和之后的增量同步走这一个；写的就是报告里看到的那一份，不重新清洗。
 *
 * 分段、可续：一次调用最多写 段长（默认 20 秒，ENT_IMPORT_SEGMENT_MS），写到哪记在批次的 cursor 上，再调一次接着写。
 * 每 每趟条数 条一个小事务（查完再写），游标和计数跟着同一个事务走：断在半路，重来不会多写一份。
 * 一趟里有一条出错就退回一条一条写，把出错那条记成「没写进去」，别的照写。
 * 两个地方同时续同一批（双击、两个窗口）：游标对不上的那边让出来，不重复写。
 *
 * 每一条怎么落：
 *   - 对照表里有（以前导过）→ 三方比对：原系统新值 / 我们这边现值 / 上次写进去的。
 *     原系统没改的格子不动；我们这边没改过的照原系统改；两边都改了、改得不一样 → 不覆盖，记一笔冲突等人定。
 *     我们这边已经删了 → 也记一笔冲突（本地已删），不重建
 *   - 本批同号的后一条（并入）→ 不另建，只记一条对照指向前一条写出来的那位
 *   - 没导过、我们这边有同号客户 → 连上它，只补空着的格子（备注、外贸档案），负责人和跟进状态不动
 *   - 否则新建；赢单 / 输单带上结单日期（看板按它算月份），跟进写完给客户补「最近跟进」
 * 负责人对不上在职的业务员（离职、被改成管理员）：退回上次的负责人 → 默认负责人 → 导入的人
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { recordAudit, type Actor } from "../audit";
import { 查完再写 } from "../check-then-write";
import { 写外贸档案 } from "../customer-extra-db";
import { 同号条件, 分机留存起 } from "../phone-dedupe";
import { 看全部 } from "../team-scope";
import { 客户附加列 } from "./clean";
import { 来源名, type 来源, type 实体, type 映射, type 待写 } from "./types";

type Tx = Prisma.TransactionClient;
export type 标量 = string | number | boolean | null;
export type 值表 = Record<string, 标量>;
type 结果 = "新建" | "更新" | "跳过" | "冲突";

/** 每类拿来比对、记进对照表的格子（落库的列名；客户的外贸几格、商机的结单日期在附表里） */
export const 比对字段: Record<实体, readonly string[]> = {
  customer: ["name", "phone", "salesOwnerId", "followStatus", "remark", ...客户附加列],
  lead: ["name", "contact", "phone", "email", "industry", "source", "status", "ownerId", "remark"],
  contact: ["name", "position", "phone", "email", "wechat", "isPrimary", "remark", "customerId"],
  opportunity: ["name", "amount", "stage", "status", "probability", "expectedDealAt", "closedAt", "ownerId", "remark", "customerId"],
  followup: ["type", "title", "content", "status", "occurredAt", "ownerId", "customerId", "opportunityId"],
};
const 负责人列: Record<实体, string> = { customer: "salesOwnerId", lead: "ownerId", contact: "", opportunity: "ownerId", followup: "ownerId" };
/** 同号连上已有客户时只补这几格 */
const 补空格 = ["remark", ...客户附加列] as const;

const 段长 = () => Number(process.env.ENT_IMPORT_SEGMENT_MS) || 20_000;
const 每趟条数 = 25;
/** note 里最多留多少条「没写进去」的明细 */
const 失败上限 = 200;

export type 失败明细 = { 实体: 实体; 外部ID: string; 行号?: number; 出处?: string; 原因: string };
export type 写入结果 = {
  状态: string;
  完了: boolean;
  总数: number;
  写到: number;
  新建: number;
  更新: number;
  跳过: number;
  冲突: number;
  失败: number;
};

/** 这一条写不进去（给人看的原因） */
export class 写不进 extends Error {}
/** 别的地方正在写这一批：游标被挪过了 */
class 让位 extends Error {}

export type 现场 = {
  批次Id: string;
  源: 来源;
  m: 映射;
  /** 在职、不是管理员的成员 */
  可任: Set<string>;
  兜底负责人: string;
  分机起: Date | null;
  现在: string;
};

const J = (v: unknown) => JSON.stringify(v);
function 解<T>(s: string | null | undefined, 缺: T): T {
  if (!s) return 缺;
  try {
    return JSON.parse(s) as T;
  } catch {
    return 缺;
  }
}

/** 比对前规整："" / undefined → null，日期 → ISO */
export function 规(v: unknown): 标量 {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  return v as 标量;
}
const 同 = (a: 标量, b: 标量) => a === b;
const 空 = (v: unknown) => 规(v) === null;
const 日 = (v: 标量): Date | null => (v ? new Date(String(v)) : null);
const 串 = (v: 标量): string | null => (v === null ? null : String(v));

function 计数(): Record<结果, number> {
  return { 新建: 0, 更新: 0, 跳过: 0, 冲突: 0 };
}

/* ───────────────────────── 读现值 / 写 ───────────────────────── */

/** 我们这边这条记录现在的样子（比对字段那几格）；删了 = null */
export async function 读现值(tx: Tx, e: 实体, id: string): Promise<值表 | null> {
  if (e === "customer") {
    const c = await tx.customer.findUnique({
      where: { id },
      select: { name: true, phone: true, salesOwnerId: true, followStatus: true, remark: true, extra: true },
    });
    if (!c) return null;
    const { extra, ...主 } = c;
    return 规整({ ...主, ...Object.fromEntries(客户附加列.map((k) => [k, extra?.[k] ?? null])) });
  }
  if (e === "lead") {
    const l = await tx.lead.findUnique({
      where: { id },
      select: { name: true, contact: true, phone: true, email: true, industry: true, source: true, status: true, ownerId: true, remark: true },
    });
    return l ? 规整(l) : null;
  }
  if (e === "contact") {
    const c = await tx.contact.findUnique({
      where: { id },
      select: { name: true, position: true, phone: true, email: true, wechat: true, isPrimary: true, remark: true, customerId: true },
    });
    return c ? 规整(c) : null;
  }
  if (e === "opportunity") {
    const o = await tx.opportunity.findUnique({
      where: { id },
      select: {
        name: true,
        amount: true,
        stage: true,
        status: true,
        probability: true,
        expectedDealAt: true,
        ownerId: true,
        remark: true,
        customerId: true,
        closed: { select: { closedAt: true } },
      },
    });
    if (!o) return null;
    const { closed, ...主 } = o;
    return 规整({ ...主, closedAt: o.status === "OPEN" ? null : (closed?.closedAt ?? null) });
  }
  const f = await tx.followUp.findUnique({
    where: { id },
    select: { type: true, title: true, content: true, status: true, occurredAt: true, ownerId: true, customerId: true, opportunityId: true },
  });
  return f ? 规整(f) : null;
}

function 规整(o: Record<string, unknown>): 值表 {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, 规(v)]));
}

function 拣(v: 值表, 键: readonly string[]): 值表 {
  return Object.fromEntries(键.filter((k) => k in v).map((k) => [k, v[k]]));
}

/** 新建一条，返回 id。值已经过 落值（负责人认过、父记录换成我们的 id、日期是 ISO） */
export async function 建(tx: Tx, e: 实体, v: 值表, 现在: string): Promise<string> {
  if (e === "customer") {
    const c = await tx.customer.create({
      data: {
        name: String(v.name),
        phone: 串(v.phone) ?? "",
        salesOwnerId: String(v.salesOwnerId),
        followStatus: 串(v.followStatus) ?? "待跟进",
        remark: 串(v.remark),
      },
      select: { id: true },
    });
    // 刚建出来的不用推版本（同大批导入）
    await 写外贸档案(tx, c.id, Object.fromEntries(客户附加列.filter((k) => !空(v[k])).map((k) => [k, String(v[k])])), false);
    return c.id;
  }
  if (e === "lead") {
    const l = await tx.lead.create({
      data: {
        name: String(v.name),
        contact: 串(v.contact),
        phone: 串(v.phone),
        email: 串(v.email),
        industry: 串(v.industry),
        source: 串(v.source) ?? "其他",
        status: 串(v.status) ?? "待跟进",
        ownerId: 串(v.ownerId),
        remark: 串(v.remark),
      },
      select: { id: true },
    });
    return l.id;
  }
  if (e === "contact") {
    const c = await tx.contact.create({
      data: {
        name: String(v.name),
        position: 串(v.position),
        phone: 串(v.phone),
        email: 串(v.email),
        wechat: 串(v.wechat),
        isPrimary: v.isPrimary === true,
        remark: 串(v.remark),
        customerId: String(v.customerId),
      },
      select: { id: true },
    });
    return c.id;
  }
  if (e === "opportunity") {
    const status = 串(v.status) ?? "OPEN";
    const o = await tx.opportunity.create({
      data: {
        name: String(v.name),
        amount: Number(v.amount ?? 0),
        stage: String(v.stage),
        status,
        probability: Number(v.probability ?? 0),
        expectedDealAt: 日(v.expectedDealAt),
        remark: 串(v.remark),
        customerId: String(v.customerId),
        ownerId: String(v.ownerId),
        activityAt: new Date(现在),
      },
      select: { id: true },
    });
    // 结单日期用原系统的（看板「本月赢单」按它算），不是导入这一天
    if (status !== "OPEN") await tx.opportunityClose.create({ data: { opportunityId: o.id, closedAt: 日(v.closedAt) ?? new Date(现在) } });
    return o.id;
  }
  const f = await tx.followUp.create({
    data: {
      type: String(v.type),
      title: String(v.title),
      content: String(v.content ?? ""),
      status: 串(v.status) ?? "已完成",
      occurredAt: 日(v.occurredAt) ?? new Date(现在),
      ownerId: String(v.ownerId),
      customerId: String(v.customerId),
      opportunityId: 串(v.opportunityId),
    },
    select: { id: true },
  });
  return f.id;
}

/** 改已有记录的这几格。现值 = 改之前读到的（商机结单要看原来的状态） */
export async function 改(tx: Tx, e: 实体, id: string, 改动: 值表, 现值: 值表, 现在: string): Promise<void> {
  const 有 = (k: string) => k in 改动;
  if (e === "customer") {
    const data: Prisma.CustomerUncheckedUpdateInput = {};
    if (有("name")) data.name = String(改动.name);
    if (有("phone")) data.phone = 串(改动.phone) ?? "";
    if (有("salesOwnerId")) data.salesOwnerId = String(改动.salesOwnerId);
    if (有("followStatus")) data.followStatus = 串(改动.followStatus) ?? "待跟进";
    if (有("remark")) data.remark = 串(改动.remark);
    const 主改 = Object.keys(data).length > 0;
    if (主改) await tx.customer.update({ where: { id }, data });
    const 档案 = Object.fromEntries(客户附加列.filter(有).map((k) => [k, 串(改动[k])]));
    // 主表改过了 updatedAt 已经往前走；只改档案时让它推一下版本（撤销靠 updatedAt 认人改过没有）
    await 写外贸档案(tx, id, 档案, !主改);
    return;
  }
  if (e === "lead") {
    const data: Prisma.LeadUncheckedUpdateInput = {};
    for (const k of ["name", "source", "status"] as const) if (有(k)) data[k] = String(改动[k]);
    for (const k of ["contact", "phone", "email", "industry", "ownerId", "remark"] as const) if (有(k)) data[k] = 串(改动[k]);
    await tx.lead.update({ where: { id }, data });
    return;
  }
  if (e === "contact") {
    const data: Prisma.ContactUncheckedUpdateInput = {};
    for (const k of ["name", "customerId"] as const) if (有(k)) data[k] = String(改动[k]);
    for (const k of ["position", "phone", "email", "wechat", "remark"] as const) if (有(k)) data[k] = 串(改动[k]);
    if (有("isPrimary")) data.isPrimary = 改动.isPrimary === true;
    await tx.contact.update({ where: { id }, data });
    return;
  }
  if (e === "opportunity") {
    const data: Prisma.OpportunityUncheckedUpdateInput = {};
    for (const k of ["name", "stage", "status", "ownerId", "customerId"] as const) if (有(k)) data[k] = String(改动[k]);
    if (有("amount")) data.amount = Number(改动.amount ?? 0);
    if (有("probability")) data.probability = Number(改动.probability ?? 0);
    if (有("expectedDealAt")) data.expectedDealAt = 日(改动.expectedDealAt);
    if (有("remark")) data.remark = 串(改动.remark);
    if (Object.keys(data).length) await tx.opportunity.update({ where: { id }, data });
    // 结单那张附表照商机页 记结单 的规矩走
    const 原状态 = 串(现值.status) ?? "OPEN";
    const 新状态 = 有("status") ? (串(改动.status) ?? "OPEN") : 原状态;
    if (原状态 === "WON" && 新状态 !== "WON") await tx.contractWin.deleteMany({ where: { opportunityId: id } });
    if (新状态 === "OPEN") {
      if (原状态 !== "OPEN") await tx.opportunityClose.deleteMany({ where: { opportunityId: id } });
    } else if (新状态 !== 原状态 || 有("closedAt")) {
      const closedAt = 日(有("closedAt") ? 改动.closedAt : 现值.closedAt) ?? new Date(现在);
      await tx.opportunityClose.upsert({ where: { opportunityId: id }, create: { opportunityId: id, closedAt }, update: { closedAt } });
    }
    return;
  }
  const data: Prisma.FollowUpUncheckedUpdateInput = {};
  for (const k of ["type", "title", "content", "status", "ownerId", "customerId"] as const) if (有(k)) data[k] = String(改动[k] ?? "");
  if (有("occurredAt")) data.occurredAt = 日(改动.occurredAt) ?? new Date(现在);
  if (有("opportunityId")) data.opportunityId = 串(改动.opportunityId);
  await tx.followUp.update({ where: { id }, data });
}

/* ───────────────────────── 一条 ───────────────────────── */

export const 引用键 = (源: 来源, entity: string, externalId: string) => ({ source_entity_externalId: { source: 源, entity, externalId } });

/** 父记录：本批的外部 ID → 对照表；我们这边的 id → 还在不在 */
async function 认父(tx: Tx, 源: 来源, e: "customer" | "opportunity", 父: { 外部ID: string } | { 本地ID: string }): Promise<string | null> {
  const id = "本地ID" in 父 ? 父.本地ID : (await tx.entExternalRef.findUnique({ where: 引用键(源, e, 父.外部ID), select: { targetId: true } }))?.targetId;
  if (!id) return null;
  const 在 =
    e === "customer"
      ? await tx.customer.findUnique({ where: { id }, select: { id: true } })
      : await tx.opportunity.findUnique({ where: { id }, select: { customerId: true } });
  return 在 ? id : null;
}

/**
 * 待写 → 这次要落的值（比对字段那几格，规整过）。
 * 上次 / 现值 用来补原系统没给的：负责人对不上退回上次的；结单日期、跟进时间没给就沿用，免得每次同步都改成「今天」
 */
export async function 落值(tx: Tx, 现: 现场, w: 待写, 上次: 值表 | null, 现值: 值表 | null): Promise<值表> {
  const v: 值表 = { ...w.值 };
  const 主 = 负责人列[w.实体];
  if (主 && !现.可任.has(String(v[主] ?? ""))) {
    const 退 = [上次?.[主], 现.m.默认负责人Id].find((x): x is string => typeof x === "string" && 现.可任.has(x));
    v[主] = 退 ?? 现.兜底负责人;
  }
  if (w.父客户) {
    const id = await 认父(tx, 现.源, "customer", w.父客户);
    if (!id) throw new 写不进("所属客户不在了（没写进去，或我们这边已删）");
    v.customerId = id;
  }
  if (w.实体 === "followup") {
    // 商机找不到不算错：清洗时已经提醒过，跟进照挂在客户下面
    let oid = w.父商机 ? await 认父(tx, 现.源, "opportunity", w.父商机) : null;
    if (oid) {
      const o = await tx.opportunity.findUnique({ where: { id: oid }, select: { customerId: true } });
      if (o?.customerId !== v.customerId) oid = null;
    }
    v.opportunityId = oid;
    if (空(v.occurredAt)) v.occurredAt = 上次?.occurredAt ?? 现值?.occurredAt ?? 现.现在;
  }
  if (w.实体 === "opportunity") {
    if (v.status === "OPEN") v.closedAt = null;
    else if (空(v.closedAt)) v.closedAt = 上次?.closedAt ?? 现值?.closedAt ?? 现.现在;
  }
  if (w.实体 === "customer" && 空(v.phone)) v.phone = "";
  return 规整(拣(v, 比对字段[w.实体]));
}

async function 写一条(tx: Tx, 现: 现场, w: 待写): Promise<结果> {
  const ref = await tx.entExternalRef.findUnique({ where: 引用键(现.源, w.实体, w.外部ID) });
  if (w.并入) {
    const 主 = await tx.entExternalRef.findUnique({ where: 引用键(现.源, w.实体, w.并入), select: { targetId: true } });
    if (!主) throw new 写不进(`要并进的「${w.并入}」没写进去`);
    if (!ref) return 并入(tx, 现, w, 主.targetId);
    if (ref.targetId === 主.targetId) {
      await tx.entExternalRef.update({ where: { id: ref.id }, data: { fingerprint: w.指纹, raw: J(w.原始) } });
      return "跳过";
    }
  }
  if (ref) return 对照(tx, 现, w, ref);
  if (w.实体 === "customer") {
    const 定 = w.目标?.方式 === "同号" && (await tx.customer.findUnique({ where: { id: w.目标.本地ID }, select: { id: true } }));
    const 目标 = 定 ? w.目标!.本地ID : await 再认同号(tx, 现, String(w.值.phone ?? ""));
    if (目标) return 补空(tx, 现, w, 目标);
  }
  return 新建(tx, 现, w);
}

/** 试跑之后、或别的窗口刚建了这个号：写之前在事务里再认一次。只认唯一的那位，多位同号照新建（试跑报告里提醒过人工合并） */
async function 再认同号(tx: Tx, 现: 现场, phone: string): Promise<string | null> {
  if (!phone) return null;
  const 有 = await tx.customer.findMany({ where: await 同号条件(tx, phone, 现.分机起), select: { id: true }, take: 2 });
  return 有.length === 1 ? 有[0].id : null;
}

async function 新建(tx: Tx, 现: 现场, w: 待写): Promise<结果> {
  const v = await 落值(tx, 现, w, null, null);
  const id = await 建(tx, w.实体, v, 现.现在);
  await tx.entExternalRef.create({
    data: { source: 现.源, entity: w.实体, externalId: w.外部ID, targetId: id, fingerprint: w.指纹, written: J(v), raw: J(w.原始), batchId: 现.批次Id },
  });
  await tx.entImportRow.create({ data: { batchId: 现.批次Id, entity: w.实体, externalId: w.外部ID, targetId: id, kind: "create", written: J(v) } });
  return "新建";
}

/** 连上我们这边早就有的同号客户：只补空着的格子；对照表记原系统这次的值，之后同步照三方比对 */
async function 补空(tx: Tx, 现: 现场, w: 待写, 目标: string): Promise<结果> {
  const 现值 = (await 读现值(tx, "customer", 目标))!;
  const v = await 落值(tx, 现, w, null, 现值);
  const 补: 值表 = {};
  const before: 值表 = {};
  for (const k of 补空格) {
    if (空(现值[k]) && !空(v[k])) {
      补[k] = v[k];
      before[k] = 现值[k];
    }
  }
  if (Object.keys(补).length) await 改(tx, "customer", 目标, 补, 现值, 现.现在);
  await tx.entExternalRef.create({
    data: { source: 现.源, entity: w.实体, externalId: w.外部ID, targetId: 目标, fingerprint: w.指纹, written: J(v), raw: J(w.原始), batchId: 现.批次Id },
  });
  await tx.entImportRow.create({
    data: { batchId: 现.批次Id, entity: w.实体, externalId: w.外部ID, targetId: 目标, kind: "update", before: J(before), written: J(补) },
  });
  return Object.keys(补).length ? "更新" : "跳过";
}

/**
 * 本批同号的后一条：不写记录，只记一条对照指向前一条那位，子记录挂它也能挂上。
 * 对照里记它自己这次的值：之后它在原系统里改了，和那位的现值三方比对，不一样就记冲突，不会和前一条来回覆盖
 */
async function 并入(tx: Tx, 现: 现场, w: 待写, 目标: string): Promise<结果> {
  const v = await 落值(tx, 现, w, null, await 读现值(tx, w.实体, 目标));
  await tx.entExternalRef.create({
    data: { source: 现.源, entity: w.实体, externalId: w.外部ID, targetId: 目标, fingerprint: w.指纹, written: J(v), raw: J(w.原始), batchId: 现.批次Id },
  });
  await tx.entImportRow.create({ data: { batchId: 现.批次Id, entity: w.实体, externalId: w.外部ID, targetId: 目标, kind: "update", before: J({}), written: J({}) } });
  return "跳过";
}

type 引用行 = Prisma.EntExternalRefGetPayload<object>;

/** 以前导过：三方比对，只改原系统改了、我们这边没动过的格子；两边都改了记冲突 */
async function 对照(tx: Tx, 现: 现场, w: 待写, ref: 引用行): Promise<结果> {
  if (ref.fingerprint === w.指纹) return "跳过";
  const 上次 = 解<值表>(ref.written, {});
  const 现值 = await 读现值(tx, w.实体, ref.targetId);
  const 记对照 = (written: 值表) =>
    tx.entExternalRef.update({ where: { id: ref.id }, data: { fingerprint: w.指纹, written: J(written), raw: J(w.原始), batchId: 现.批次Id } });
  const 记一行 = (before: 值表, written: 值表) =>
    tx.entImportRow.create({
      data: { batchId: 现.批次Id, entity: w.实体, externalId: w.外部ID, targetId: ref.targetId, kind: "update", before: J(before), written: J(written), refBefore: J(ref) },
    });

  if (!现值) {
    await 记冲突(tx, 现, w, ref.targetId, {}, true);
    await 记对照(上次);
    await 记一行({}, {});
    return "冲突";
  }

  const v = await 落值(tx, 现, w, 上次, 现值);
  const 改动: 值表 = {};
  const before: 值表 = {};
  const 冲: Record<string, { 原系统: 标量; 我们: 标量; 上次: 标量 }> = {};
  const 新上次: 值表 = { ...上次 };
  for (const k of 比对字段[w.实体]) {
    const n = 规(v[k]);
    const l = 规(上次[k]);
    const c = 规(现值[k]);
    if (同(n, l)) continue; // 原系统没改
    if (同(c, l)) {
      // 我们这边没动过：照原系统改
      改动[k] = n;
      before[k] = c;
      新上次[k] = n;
    } else if (同(c, n)) 新上次[k] = n; // 两边改成一样的了
    else 冲[k] = { 原系统: n, 我们: c, 上次: l };
  }
  if (Object.keys(改动).length) await 改(tx, w.实体, ref.targetId, 改动, 现值, 现.现在);
  const 有冲突 = Object.keys(冲).length > 0;
  if (有冲突) await 记冲突(tx, 现, w, ref.targetId, 冲, false);
  await 记对照(新上次);
  await 记一行(before, 改动);
  return 有冲突 ? "冲突" : Object.keys(改动).length ? "更新" : "跳过";
}

/** 一条原系统记录最多一笔待定的冲突：已有就换成这次的，不越记越多 */
async function 记冲突(tx: Tx, 现: 现场, w: 待写, targetId: string, fields: object, localDeleted: boolean): Promise<void> {
  const data = { targetId, batchId: 现.批次Id, fields: J(fields), incoming: J(w), localDeleted };
  const 有 = await tx.entConflict.findFirst({ where: { source: 现.源, entity: w.实体, externalId: w.外部ID, status: "待定" }, select: { id: true } });
  if (有) await tx.entConflict.update({ where: { id: 有.id }, data });
  else await tx.entConflict.create({ data: { source: 现.源, entity: w.实体, externalId: w.外部ID, ...data } });
}

/* ───────────────────────── 一批 ───────────────────────── */

const 计数列: Record<结果, "created" | "updated" | "skipped" | "conflicts"> = { 新建: "created", 更新: "updated", 跳过: "skipped", 冲突: "conflicts" };

/** 写之前备好的：谁能当负责人、负责人都对不上时给谁 */
export async function 开现场(批次Id: string, 源: 来源, m: 映射, 用户: Actor): Promise<现场> {
  const 成员 = await prisma.user.findMany({ where: { active: true, role: { not: "ADMIN" } }, select: { id: true } });
  const 可任 = new Set(成员.map((u) => u.id));
  return {
    批次Id,
    源,
    m,
    可任,
    兜底负责人: 可任.has(用户.id) ? 用户.id : (成员[0]?.id ?? 用户.id),
    分机起: await 分机留存起(),
    现在: new Date().toISOString(),
  };
}

/**
 * 把一批写进去（或接着写）。preview / applying 才写；写完一趟时间到了就返回，完了 = false 时再调一次。
 * 用户 = 点「正式导入」的人（同步时是开同步的那位），记进操作日志
 */
export async function 写一批(批次Id: string, 用户: Actor, opts: { 段长毫秒?: number } = {}): Promise<写入结果> {
  const 开始 = Date.now();
  const 批 = await prisma.entImportBatch.findUnique({ where: { id: 批次Id } });
  if (!批) throw new Error("找不到这一批");
  if (批.status === "preview") await prisma.entImportBatch.updateMany({ where: { id: 批次Id, status: "preview" }, data: { status: "applying" } });
  else if (批.status !== "applying") return 结果(批次Id);

  const 计划 = 解<待写[]>(批.plan, []);
  const m = 解<映射 | null>(批.mapping, null);
  if (!m) throw new Error("这一批没有字段映射，请重新试跑");
  const 现 = await 开现场(批次Id, 批.source as 来源, m, 用户);
  const 失败们 = 解<失败明细[]>(批.note, []);

  // 每次调用至少写一趟，再看时间：段长再短也不会原地踏步
  const 截止 = 开始 + (opts.段长毫秒 ?? 段长());
  let 游标 = 批.cursor;
  try {
    while (游标 < 计划.length && (游标 === 批.cursor || Date.now() < 截止)) {
      const 段 = 计划.slice(游标, 游标 + 每趟条数);
      try {
        await 一趟(现, 段, 游标);
      } catch (e) {
        if (e instanceof 让位) throw e;
        // 这一趟有一条出错：退回一条一条写，出错的那条记下来，别的照写
        for (let i = 0; i < 段.length; i++) {
          try {
            await 一趟(现, [段[i]], 游标 + i);
          } catch (e1) {
            if (e1 instanceof 让位) throw e1;
            const w = 段[i];
            if (失败们.length < 失败上限) 失败们.push({ 实体: w.实体, 外部ID: w.外部ID, 行号: w.行号, 出处: w.出处, 原因: 原因(e1) });
            const n = await prisma.entImportBatch.updateMany({
              where: { id: 批次Id, cursor: 游标 + i, status: "applying" },
              data: { cursor: { increment: 1 }, failed: { increment: 1 }, note: J(失败们) },
            });
            if (n.count !== 1) throw new 让位();
          }
        }
      }
      游标 += 段.length;
    }
  } catch (e) {
    if (!(e instanceof 让位)) throw e;
    return 结果(批次Id);
  }

  if (游标 >= 计划.length) await 收尾(批次Id, 用户);
  return 结果(批次Id);
}

/** 一个小事务写几条：游标和计数一起进，对不上（别处在写、或已撤回）就整趟让出来 */
async function 一趟(现: 现场, 段: 待写[], 起: number): Promise<void> {
  await 查完再写((tx) =>
    看全部(async () => {
      const 数 = 计数();
      for (const w of 段) 数[await 写一条(tx, 现, w)]++;
      const data: Prisma.EntImportBatchUpdateManyMutationInput = { cursor: { increment: 段.length } };
      for (const k of Object.keys(数) as 结果[]) if (数[k]) data[计数列[k]] = { increment: 数[k] };
      const n = await tx.entImportBatch.updateMany({ where: { id: 现.批次Id, cursor: 起, status: "applying" }, data });
      if (n.count !== 1) throw new 让位();
    }),
  );
}

function 原因(e: unknown): string {
  if (e instanceof 写不进) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  // Prisma 的报错很长，留最后一行就够认出是什么
  return `写库出错：${msg.trim().split("\n").pop()?.slice(0, 200) ?? ""}`;
}

/** 写完：给碰过的客户补「最近跟进」，批次记 done，记操作日志 */
async function 收尾(批次Id: string, 用户: Actor): Promise<void> {
  const 跟进 = await prisma.entImportRow.findMany({ where: { batchId: 批次Id, entity: "followup" }, select: { targetId: true } });
  const ids = [...new Set(跟进.map((r) => r.targetId))];
  await 看全部(async () => {
    for (let i = 0; i < ids.length; i += 500) {
      const 组 = await prisma.followUp.groupBy({ by: ["customerId"], where: { id: { in: ids.slice(i, i + 500) } }, _max: { occurredAt: true } });
      for (const g of 组) {
        const at = g._max.occurredAt;
        if (!at) continue;
        await prisma.customer.updateMany({ where: { id: g.customerId, OR: [{ lastFollowAt: null }, { lastFollowAt: { lt: at } }] }, data: { lastFollowAt: at } });
      }
    }
  });
  const n = await prisma.entImportBatch.updateMany({ where: { id: 批次Id, status: "applying" }, data: { status: "done", finishedAt: new Date() } });
  if (n.count !== 1) return; // 别处已经收过尾
  const 批 = (await prisma.entImportBatch.findUnique({ where: { id: 批次Id } }))!;
  const 叫法 = 批.kind === "sync" ? "同步" : "导入";
  await recordAudit({
    user: 用户,
    action: 批.kind === "sync" ? "ent-sync" : "ent-import",
    entity: "EntImportBatch",
    entityId: 批次Id,
    summary: `从${来源名[批.source as 来源] ?? 批.source}${叫法}：新建 ${批.created} 条，更新 ${批.updated} 条，跳过 ${批.skipped} 条，${批.conflicts} 条冲突待定，${批.failed} 条没写进去`,
    detail: { batchId: 批次Id, source: 批.source, kind: 批.kind, created: 批.created, updated: 批.updated, skipped: 批.skipped, conflicts: 批.conflicts, failed: 批.failed },
  });
  for (const p of ["/customers", "/leads", "/opportunities", "/dashboard"]) revalidatePath(p);
}

async function 结果(批次Id: string): Promise<写入结果> {
  const b = (await prisma.entImportBatch.findUnique({ where: { id: 批次Id } }))!;
  return {
    状态: b.status,
    完了: b.status === "done",
    总数: b.total,
    写到: b.cursor,
    新建: b.created,
    更新: b.updated,
    跳过: b.skipped,
    冲突: b.conflicts,
    失败: b.failed,
  };
}
