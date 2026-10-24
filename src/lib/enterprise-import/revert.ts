/**
 * 企业版导入 · 整批撤回（软删）和撤回后再恢复。
 *
 * 撤回：照这一批记下的每一行（EntImportRow）倒着退——先跟进、再商机、联系人、线索，最后客户；同一类后写的先退。
 *   - 这一批新建的：删之前整条存进回收区（EntTrash，客户带外贸档案，商机带结单日期），连对照行一起删
 *   - 这一批改过的（同号补空、并入、同步改格子）：把那几格改回写之前的样子，对照行退回写之前那一份
 *   - 动不得的留下不动，原因记在批次的 revertNote：
 *       导入之后有人改过（比对字段和当时写进去的不一样；或院校、渠道、决策状态这类导入不碰的格子不再是空的）、
 *       名下挂着这一批以外的记录（手记的跟进、任务、合同……）、之后的同步或冲突处理又改过它（先撤那一批）
 *   - 这一批记下的待定冲突改成「已撤回」，跟进删了的客户重算「最近跟进」
 *   - 冲突处理那一批（kind = resolve）：照样退格子、退对照行（本地已删时建回来的那条删掉），定下的冲突回到待定
 * 恢复：回收区里的照原 id 建回去、对照行建回去；改过的格子再改回导入后的样子。撤回之后又导进来、又改过的跳过。
 *
 * 和写一批一样分段、可续：每 每趟条数 行一个小事务，处理到哪记在行上（undo / restoredAt），断了再调一次接着来；
 * 两个地方同时撤同一批，晚到的那边让出来。
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma";
import { prisma } from "../prisma";
import { recordAudit, type Actor } from "../audit";
import { 查完再写 } from "../check-then-write";
import { 看全部 } from "../team-scope";
import { 外贸键 } from "../customer-extra";
import { 读现值, 改, 规, 引用键, type 值表 } from "./apply";
import { 来源名, 实体名, 实体顺序, type 来源, type 实体 } from "./types";

type Tx = Prisma.TransactionClient;
type 引用行 = Prisma.EntExternalRefGetPayload<object>;
type 记的行 = Prisma.EntImportRowGetPayload<object>;

const 段长 = () => Number(process.env.ENT_IMPORT_SEGMENT_MS) || 20_000;
const 每趟条数 = 25;
/** revertNote 里最多留多少条「留下」的明细 */
const 明细上限 = 200;

export type 留下明细 = { 实体: 实体; 外部ID: string; 名称: string; 原因: string };
/** 存在批次 revertNote 里的账 */
type 账 = { 动作: "撤回" | "恢复"; 删掉: number; 还原: number; 恢复: number; 留下数: number; 留下: 留下明细[] };
export type 撤回结果 = { 状态: string; 完了: boolean } & Omit<账, "动作">;

/** 别的地方正在处理这一行 / 这一批 */
class 让位 extends Error {}
/** 这一条不动（给人看的原因） */
class 不动 extends Error {}

const J = (v: unknown) => JSON.stringify(v);
function 解<T>(s: string | null | undefined, 缺: T): T {
  if (!s) return 缺;
  try {
    return JSON.parse(s) as T;
  } catch {
    return 缺;
  }
}
const 空账 = (动作: 账["动作"]): 账 => ({ 动作, 删掉: 0, 还原: 0, 恢复: 0, 留下数: 0, 留下: [] });

/** 现值在 期望 的每一格上都一样 */
function 一致(现值: 值表, 期望: 值表): boolean {
  return Object.keys(期望).every((k) => 规(现值[k]) === 规(期望[k]));
}
function 拣(v: 值表, 键: string[]): 值表 {
  return Object.fromEntries(键.filter((k) => k in v).map((k) => [k, v[k]]));
}

/* ───────────────────────── 动不得的 ───────────────────────── */

/**
 * 这一批新建的这条还能不能删：名下挂着别的记录、导入不碰的格子被人填过 → 不能，返回原因。
 * 这一批自己建的子记录这时已经先退掉了（倒着退），还挂着的就是外面的、或留下没撤的
 */
async function 还挂着(tx: Tx, e: 实体, id: string, 自己的对照: string | null): Promise<string | null> {
  const 别的对照 = await tx.entExternalRef.count({ where: { entity: e, targetId: id, ...(自己的对照 ? { id: { not: 自己的对照 } } : {}) } });
  if (别的对照) return "原系统还有别的记录连着它（同号并入，或之后的同步连上的），先撤回那几条";

  if (e === "customer") {
    const c = await tx.customer.findUnique({
      where: { id },
      select: {
        school: true,
        grade: true,
        major: true,
        channelId: true,
        channelOwnerId: true,
        referrerCustomerId: true,
        attributionChannelId: true,
        attributionCustomerId: true,
        decisionStatus: true,
        expectedSignAt: true,
        expectedSignOn: true,
        lead: { select: { id: true } },
        claim: { select: { customerId: true } },
        _count: {
          select: {
            contacts: true,
            followUps: true,
            tasks: true,
            plans: true,
            opportunities: true,
            contracts: true,
            tradeOrders: true,
            projects: true,
            referrals: true,
            attributedCustomers: true,
          },
        },
      },
    });
    if (!c) return null;
    const { referrals, attributedCustomers, ...挂件 } = c._count;
    if (referrals || attributedCustomers) return "他是别的客户的推荐人或业绩归属，删了那几位的归属会断";
    if (Object.values(挂件).some((n) => n > 0)) return "名下已经有这一批以外的跟进、联系人、商机、任务或合同";
    if (c.lead) return "有线索转成了这位客户";
    if (c.claim) return "有人从公海领过他";
    const 填过 =
      [c.school, c.grade, c.major, c.channelId, c.channelOwnerId, c.referrerCustomerId, c.attributionChannelId, c.attributionCustomerId, c.expectedSignAt, c.expectedSignOn].some(
        (v) => v !== null,
      ) || c.decisionStatus !== "了解中";
    return 填过 ? "导入之后又补过档案（院校、渠道、推荐人、决策状态等）" : null;
  }
  if (e === "lead") {
    const l = await tx.lead.findUnique({ where: { id }, select: { customerId: true, convertedAt: true } });
    return l && (l.customerId || l.convertedAt) ? "这条线索已经转成客户了" : null;
  }
  if (e === "contact") {
    const c = await tx.contact.findUnique({ where: { id }, select: { _count: { select: { followUps: true, projects: true } } } });
    return c && (c._count.followUps || c._count.projects) ? "有这一批以外的跟进或项目挂在这位联系人上" : null;
  }
  if (e === "opportunity") {
    const o = await tx.opportunity.findUnique({
      where: { id },
      select: {
        money: { select: { opportunityId: true } },
        contractWin: { select: { opportunityId: true } },
        _count: { select: { followUps: true, quotes: true, tradeOrders: true, supplierQuotes: true } },
      },
    });
    if (!o) return null;
    if (o.contractWin) return "这个商机是签合同时赢下来的";
    if (Object.values(o._count).some((n) => n > 0)) return "名下已经有这一批以外的跟进、报价或订单";
    return o.money ? "导入之后又设过币种" : null;
  }
  const f = await tx.followUp.findUnique({
    where: { id },
    select: {
      duration: true,
      dueAt: true,
      dueOn: true,
      dueHasTime: true,
      participants: true,
      contactId: true,
      source: { select: { followUpId: true } },
      orderNode: { select: { followUpId: true } },
      projectNode: { select: { followUpId: true } },
    },
  });
  if (!f) return null;
  if (f.orderNode || f.projectNode) return "这条跟进挂到了订单或项目的节点上";
  if (f.source) return "这条跟进有 AI 整理的原文";
  return [f.duration, f.dueAt, f.dueOn, f.dueHasTime, f.participants, f.contactId].some((v) => v !== null) ? "导入之后又补过这条跟进（时长、提醒、联系人等）" : null;
}

/** 删之前整条存下来：客户带外贸档案、录入人、公海那一格；商机带结单日期 */
async function 快照(tx: Tx, e: 实体, id: string): Promise<object | null> {
  if (e === "customer") return tx.customer.findUnique({ where: { id }, include: { extra: true, creator: true, pool: true } });
  if (e === "lead") return tx.lead.findUnique({ where: { id } });
  if (e === "contact") return tx.contact.findUnique({ where: { id } });
  if (e === "opportunity") return tx.opportunity.findUnique({ where: { id }, include: { closed: true } });
  return tx.followUp.findUnique({ where: { id } });
}

async function 删(tx: Tx, e: 实体, id: string): Promise<void> {
  if (e === "customer") await tx.customer.delete({ where: { id } });
  else if (e === "lead") await tx.lead.delete({ where: { id } });
  else if (e === "contact") await tx.contact.delete({ where: { id } });
  else if (e === "opportunity") await tx.opportunity.delete({ where: { id } });
  else await tx.followUp.delete({ where: { id } });
}

/** 补空时新建的外贸档案，格子退回空之后整行删掉：库里不留一条全空的行（全空的行和没有这行在页面上一样） */
async function 删空档案(tx: Tx, customerId: string): Promise<void> {
  const 档 = await tx.customerExtra.findUnique({ where: { customerId } });
  if (档 && 外贸键.every((k) => 档[k] == null)) await tx.customerExtra.delete({ where: { customerId } });
}

/** 快照照原 id 建回去 */
async function 建回(tx: Tx, e: 实体, data: Record<string, unknown>): Promise<void> {
  if (e === "customer") {
    const { extra, creator, pool, ...主 } = data;
    await tx.customer.create({ data: 主 as Prisma.CustomerUncheckedCreateInput });
    if (extra) await tx.customerExtra.create({ data: extra as Prisma.CustomerExtraUncheckedCreateInput });
    if (creator) await tx.customerCreator.create({ data: creator as Prisma.CustomerCreatorUncheckedCreateInput });
    if (pool) await tx.customerPool.create({ data: pool as Prisma.CustomerPoolUncheckedCreateInput });
  } else if (e === "lead") await tx.lead.create({ data: data as Prisma.LeadUncheckedCreateInput });
  else if (e === "contact") await tx.contact.create({ data: data as Prisma.ContactUncheckedCreateInput });
  else if (e === "opportunity") {
    const { closed, ...主 } = data;
    await tx.opportunity.create({ data: 主 as Prisma.OpportunityUncheckedCreateInput });
    if (closed) await tx.opportunityClose.create({ data: closed as Prisma.OpportunityCloseUncheckedCreateInput });
  } else await tx.followUp.create({ data: data as Prisma.FollowUpUncheckedCreateInput });
}

async function 还在(tx: Tx, e: 实体, id: string): Promise<boolean> {
  if (e === "customer") return !!(await tx.customer.findUnique({ where: { id }, select: { id: true } }));
  if (e === "lead") return !!(await tx.lead.findUnique({ where: { id }, select: { id: true } }));
  if (e === "contact") return !!(await tx.contact.findUnique({ where: { id }, select: { id: true } }));
  if (e === "opportunity") return !!(await tx.opportunity.findUnique({ where: { id }, select: { id: true } }));
  return !!(await tx.followUp.findUnique({ where: { id }, select: { id: true } }));
}

/** 给人看的名字：撤不动时报得出是哪一条 */
async function 名称(tx: Tx, e: 实体, id: string, written: 值表): Promise<string> {
  const 现 = await 读现值(tx, e, id);
  const v = 现 ?? written;
  return String((e === "followup" ? v.title : v.name) ?? "") || id;
}

/** 跟进删了 / 建回来了：客户的「最近跟进」按剩下的重算（同合并客户） */
export async function 重算最近跟进(tx: Tx, 客户们: Set<string>): Promise<void> {
  for (const id of 客户们) {
    await tx.$executeRawUnsafe('UPDATE "Customer" SET lastFollowAt = (SELECT MAX(occurredAt) FROM "FollowUp" WHERE customerId = ?) WHERE id = ?', id, id);
  }
}

const 对照数据 = (r: 引用行) => ({ targetId: r.targetId, fingerprint: r.fingerprint, written: r.written, raw: r.raw, batchId: r.batchId });

/** 恢复前：对照行还是撤回时退回去的那一份（撤回之后没再同步、没再处理冲突）；当时没有的现在也得没有 */
function 对照没动(现: 引用行 | null, 原: 引用行 | null): boolean {
  if (!原) return !现;
  return !!现 && 现.fingerprint === 原.fingerprint && 现.batchId === 原.batchId && 现.targetId === 原.targetId;
}

/** 撤回时对照行退回去：写之前有的退回那一份，没有的删掉 */
async function 退对照(tx: Tx, ref: 引用行, 原对照: 引用行 | null): Promise<void> {
  if (原对照) await tx.entExternalRef.update({ where: { id: ref.id }, data: 对照数据(原对照) });
  else await tx.entExternalRef.delete({ where: { id: ref.id } });
}

const 叫法 = (kind: string) => (kind === "sync" ? "同步" : kind === "resolve" ? "冲突处理" : "导入");

/* ───────────────────────── 撤一行 ───────────────────────── */

type 一行结果 = "删掉" | "还原" | "无";

async function 撤一行(tx: Tx, 源: 来源, 批次Id: string, row: 记的行, 碰过: Set<string>): Promise<一行结果> {
  const e = row.entity as 实体;
  const ref = await tx.entExternalRef.findUnique({ where: 引用键(源, e, row.externalId) });
  const 写过 = 解<值表>(row.written, {});
  if (ref && ref.batchId !== 批次Id) throw new 不动("之后的同步或冲突处理又改过它，先撤回那一批");
  const 原对照 = 解<引用行 | null>(row.refBefore, null);

  if (row.kind === "create") {
    // 原对照：冲突处理时本地已删、照原系统建回来的那条；撤回就是对照行指回原来那条（已删的）
    const 连着 = ref && ref.targetId === row.targetId ? ref : null;
    const 现值 = await 读现值(tx, e, row.targetId);
    if (!现值) {
      // 我们这边已经删了：撤回的目的达到了，对照行一起退掉
      if (连着) await 退对照(tx, 连着, 原对照);
      return "无";
    }
    if (!一致(现值, 写过)) throw new 不动("导入之后又改过");
    const 拦 = await 还挂着(tx, e, row.targetId, 连着?.id ?? null);
    if (拦) throw new 不动(拦);
    await tx.entTrash.create({
      data: { batchId: 批次Id, entity: e, targetId: row.targetId, data: J(await 快照(tx, e, row.targetId)), ref: 连着 ? J(连着) : null, rowId: row.id },
    });
    if (连着) await 退对照(tx, 连着, 原对照);
    await 删(tx, e, row.targetId);
    if (e === "followup" && 现值.customerId) 碰过.add(String(现值.customerId));
    return "删掉";
  }

  // update：改过的格子改回去，对照行退回写之前那一份（之前没有的就删掉）
  const 原 = 解<值表>(row.before, {});
  const 键 = Object.keys(写过);
  const 现值 = 键.length ? await 读现值(tx, e, row.targetId) : null;
  const 还原了 = !!现值;
  if (现值) {
    if (!一致(现值, 写过)) throw new 不动("导入之后又改过");
    await 改(tx, e, row.targetId, 拣(原, 键), 现值, new Date().toISOString());
    if (e === "customer") await 删空档案(tx, row.targetId);
    if (e === "followup") {
      碰过.add(String(现值.customerId));
      if ("customerId" in 原 && 原.customerId) 碰过.add(String(原.customerId));
    }
  }
  if (ref) await 退对照(tx, ref, 原对照);
  await tx.entTrash.create({
    data: { batchId: 批次Id, entity: e, targetId: row.targetId, data: J({ 还原: 还原了 ? 拣(原, 键) : {} }), ref: ref ? J(ref) : null, rowId: row.id },
  });
  return 还原了 ? "还原" : "无";
}

/* ───────────────────────── 恢复一条 ───────────────────────── */

type 回收行 = Prisma.EntTrashGetPayload<object>;

async function 恢复一条(tx: Tx, t: 回收行, row: 记的行 | null, 碰过: Set<string>): Promise<boolean> {
  if (!row) throw new 不动("对应的导入记录不在了");
  const e = t.entity as 实体;
  const 存的对照 = 解<引用行 | null>(t.ref, null);
  const 现对照 = 存的对照 ? await tx.entExternalRef.findUnique({ where: 引用键(存的对照.source as 来源, e, 存的对照.externalId) }) : null;
  const 原对照 = 解<引用行 | null>(row.refBefore, null);

  if (row.kind === "create") {
    if (!对照没动(现对照, 原对照)) throw new 不动(原对照 ? "撤回之后原系统这条又同步过" : "撤回之后原系统这条又导进来了");
    if (await 还在(tx, e, t.targetId)) throw new 不动("这条记录已经在了");
    const data = 解<Record<string, unknown> | null>(t.data, null);
    if (!data) throw new 不动("回收区里这条读不出来了");
    if (e !== "customer" && e !== "lead" && !(await 还在(tx, "customer", String(data.customerId)))) throw new 不动("所属客户不在了");
    if (e === "followup" && data.opportunityId && !(await 还在(tx, "opportunity", String(data.opportunityId)))) data.opportunityId = null;
    await 建回(tx, e, data);
    if (存的对照) {
      if (现对照) await tx.entExternalRef.update({ where: { id: 现对照.id }, data: 对照数据(存的对照) });
      else await tx.entExternalRef.create({ data: { source: 存的对照.source, entity: e, externalId: 存的对照.externalId, ...对照数据(存的对照) } });
    }
    if (e === "followup") 碰过.add(String(data.customerId));
    return true;
  }

  // update：撤回时改回去的那几格没人再动过，就再改成导入后的样子
  if (!对照没动(现对照, 原对照)) throw new 不动("撤回之后原系统这条又同步过");
  const 改回 = 解<{ 还原?: 值表 }>(t.data, {}).还原 ?? {};
  const 键 = Object.keys(改回);
  let 恢复了 = false;
  if (键.length) {
    const 现值 = await 读现值(tx, e, t.targetId);
    if (现值) {
      if (!一致(现值, 改回)) throw new 不动("撤回之后又改过");
      await 改(tx, e, t.targetId, 拣(解<值表>(row.written, {}), 键), 现值, new Date().toISOString());
      if (e === "followup") 碰过.add(String(现值.customerId));
      恢复了 = true;
    }
  }
  if (存的对照) {
    if (现对照) await tx.entExternalRef.update({ where: { id: 现对照.id }, data: 对照数据(存的对照) });
    else await tx.entExternalRef.create({ data: { source: 存的对照.source, entity: e, externalId: 存的对照.externalId, ...对照数据(存的对照) } });
  }
  return 恢复了;
}

/* ───────────────────────── 一批 ───────────────────────── */

function 原因(e: unknown): string {
  if (e instanceof 不动) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return `出错：${msg.trim().split("\n").pop()?.slice(0, 200) ?? ""}`;
}

function 记账(a: 账, 加: Partial<Record<"删掉" | "还原" | "恢复", number>>, 留: 留下明细[]): 账 {
  const b = { ...a, 留下: [...a.留下] };
  for (const [k, n] of Object.entries(加) as ["删掉" | "还原" | "恢复", number][]) b[k] += n;
  b.留下数 += 留.length;
  for (const x of 留) if (b.留下.length < 明细上限) b.留下.push(x);
  return b;
}

/** 批次还在这个状态才往下走，顺手把这一趟的账记上 */
async function 入账(tx: Tx, 批次Id: string, 状态: string, 动作: 账["动作"], 加: Partial<Record<"删掉" | "还原" | "恢复", number>>, 留: 留下明细[]) {
  const b = await tx.entImportBatch.findUnique({ where: { id: 批次Id }, select: { status: true, revertNote: true } });
  if (b?.status !== 状态) throw new 让位();
  const 旧 = 解<账 | null>(b.revertNote, null);
  const a = 记账(旧?.动作 === 动作 ? 旧 : 空账(动作), 加, 留);
  await tx.entImportBatch.update({ where: { id: 批次Id }, data: { revertNote: J(a) } });
}

/**
 * 分段跑一类：每趟一个事务；这一趟出错就退回一条一条来，出错那条记成留下。
 * 这一次调用至少跑一趟（跑过记在 跑过.有），之后时间到了、还有没处理的就返回 false；取到不满一趟 = 这一类处理完了
 */
async function 分段跑<T extends { id: string }>(
  截止: number,
  跑过: { 有: boolean },
  取: () => Promise<T[]>,
  一趟: (段: T[]) => Promise<void>,
  单条出错: (x: T, e: unknown) => Promise<void>,
): Promise<boolean> {
  for (;;) {
    const 段 = await 取();
    if (!段.length) return true;
    if (跑过.有 && Date.now() >= 截止) return false;
    跑过.有 = true;
    try {
      await 一趟(段);
    } catch (e) {
      if (e instanceof 让位) throw e;
      for (const x of 段) {
        try {
          await 一趟([x]);
        } catch (e1) {
          if (e1 instanceof 让位) throw e1;
          await 单条出错(x, e1);
        }
      }
    }
    if (段.length < 每趟条数) return true;
  }
}

export async function 别的在写(source: string, 批次Id: string): Promise<boolean> {
  return (await prisma.entImportBatch.count({ where: { source, id: { not: 批次Id }, status: { in: ["applying", "reverting", "restoring"] } } })) > 0;
}

/**
 * 整批撤回（或接着撤）。done / reverting 才撤；时间到了就返回，完了 = false 时再调一次。
 * 同一来源别的批次正在写 / 撤，先不动（之后的同步一边写一边撤会对不上）
 */
export async function 撤回一批(批次Id: string, 用户: Actor, opts: { 段长毫秒?: number } = {}): Promise<撤回结果> {
  const 开始 = Date.now();
  const 批 = await prisma.entImportBatch.findUnique({ where: { id: 批次Id } });
  if (!批) throw new Error("找不到这一批");
  if (批.status === "done") {
    if (await 别的在写(批.source, 批次Id)) throw new Error("同一来源还有一批正在写入或撤回，等它完了再撤");
    await prisma.entImportBatch.updateMany({ where: { id: 批次Id, status: "done" }, data: { status: "reverting", revertNote: J(空账("撤回")) } });
  } else if (批.status === "preview" || 批.status === "applying") throw new Error("这一批还没导完，不能撤回");
  else if (批.status !== "reverting") return 结果(批次Id);
  const 源 = 批.source as 来源;
  const 截止 = 开始 + (opts.段长毫秒 ?? 段长());

  const 一趟 = (段: 记的行[]) =>
    查完再写((tx) =>
      看全部(async () => {
        const 碰过 = new Set<string>();
        const 加 = { 删掉: 0, 还原: 0 };
        const 留: 留下明细[] = [];
        for (const row of 段) {
          // 先占住这一行：两个地方同时撤，晚到的那边让出来
          const n = await tx.entImportRow.updateMany({ where: { id: row.id, undo: null }, data: { undo: "撤了" } });
          if (n.count !== 1) throw new 让位();
          try {
            const r = await 撤一行(tx, 源, 批次Id, row, 碰过);
            if (r !== "无") 加[r]++;
          } catch (e) {
            if (!(e instanceof 不动)) throw e;
            await tx.entImportRow.update({ where: { id: row.id }, data: { undo: "留下" } });
            留.push({ 实体: row.entity as 实体, 外部ID: row.externalId, 名称: await 名称(tx, row.entity as 实体, row.targetId, 解(row.written, {})), 原因: e.message });
          }
        }
        await 重算最近跟进(tx, 碰过);
        await 入账(tx, 批次Id, "reverting", "撤回", 加, 留);
      }),
    );
  const 出错留下 = (row: 记的行, e: unknown) =>
    查完再写(async (tx) => {
      const n = await tx.entImportRow.updateMany({ where: { id: row.id, undo: null }, data: { undo: "留下" } });
      if (n.count !== 1) throw new 让位();
      await 入账(tx, 批次Id, "reverting", "撤回", {}, [{ 实体: row.entity as 实体, 外部ID: row.externalId, 名称: row.targetId, 原因: 原因(e) }]);
    });

  const 跑过 = { 有: false };
  try {
    for (const e of [...实体顺序].reverse()) {
      // 同一类里先退改过的（同号并入的对照行连着本批新建的那条），再删新建的
      const 取 = () =>
        prisma.entImportRow.findMany({
          where: { batchId: 批次Id, entity: e, undo: null },
          orderBy: [{ kind: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 每趟条数,
        });
      if (!(await 分段跑(截止, 跑过, 取, 一趟, 出错留下))) return 结果(批次Id);
    }
  } catch (e) {
    if (!(e instanceof 让位)) throw e;
    return 结果(批次Id);
  }

  const n = await prisma.$transaction(async (tx) => {
    const n = await tx.entImportBatch.updateMany({ where: { id: 批次Id, status: "reverting" }, data: { status: "reverted", revertedAt: new Date() } });
    if (n.count !== 1) return n;
    await tx.entConflict.updateMany({ where: { batchId: 批次Id, status: "待定" }, data: { status: "已撤回" } });
    if (批.kind === "resolve") await 定的冲突回待定(tx, 批次Id);
    return n;
  });
  if (n.count === 1) {
    const r = await 结果(批次Id);
    await recordAudit({
      user: 用户,
      action: "ent-revert",
      entity: "EntImportBatch",
      entityId: 批次Id,
      summary: `撤回从${来源名[源] ?? 源}${叫法(批.kind)}的那一批：删掉 ${r.删掉} 条，还原 ${r.还原} 条${r.留下数 ? `，${r.留下数} 条导入后被动过、留下没动` : ""}`,
      detail: { batchId: 批次Id, 删掉: r.删掉, 还原: r.还原, 留下数: r.留下数 },
    });
    for (const p of ["/customers", "/leads", "/opportunities", "/dashboard"]) revalidatePath(p);
  }
  return 结果(批次Id);
}

/**
 * 撤回之后再恢复（或接着恢复）：回收区里的照原 id 建回去，改回去的格子再改成导入后的样子。
 * 撤回之后原系统那条又导进来 / 又同步过、或又被人改过的，跳过不动，记进 revertNote；那几行仍算撤着
 */
export async function 恢复一批(批次Id: string, 用户: Actor, opts: { 段长毫秒?: number } = {}): Promise<撤回结果> {
  const 开始 = Date.now();
  const 批 = await prisma.entImportBatch.findUnique({ where: { id: 批次Id } });
  if (!批) throw new Error("找不到这一批");
  if (批.status === "reverted") {
    if (await 别的在写(批.source, 批次Id)) throw new Error("同一来源还有一批正在写入或撤回，等它完了再恢复");
    await prisma.entImportBatch.updateMany({ where: { id: 批次Id, status: "reverted" }, data: { status: "restoring", revertNote: J(空账("恢复")) } });
  } else if (批.status === "done" && 解<账 | null>(批.revertNote, null)?.动作 === "恢复") return 结果(批次Id); // 已经恢复完了（两边同时点）
  else if (批.status !== "restoring") throw new Error("这一批没有撤回，不用恢复");
  const 截止 = 开始 + (opts.段长毫秒 ?? 段长());

  const 一趟 = (段: 回收行[]) =>
    查完再写((tx) =>
      看全部(async () => {
        const 碰过 = new Set<string>();
        let 恢复 = 0;
        const 留: 留下明细[] = [];
        for (const t of 段) {
          const n = await tx.entTrash.updateMany({ where: { id: t.id, restoredAt: null }, data: { restoredAt: new Date() } });
          if (n.count !== 1) throw new 让位();
          const row = t.rowId ? await tx.entImportRow.findUnique({ where: { id: t.rowId } }) : null;
          try {
            if (await 恢复一条(tx, t, row, 碰过)) 恢复++;
            if (row) await tx.entImportRow.update({ where: { id: row.id }, data: { undo: null } });
          } catch (e) {
            if (!(e instanceof 不动)) throw e;
            // 跳过的这条仍算撤着（行上 undo 不清）；回收区里标成处理过，不再重试
            留.push({ 实体: t.entity as 实体, 外部ID: row?.externalId ?? "", 名称: await 名称(tx, t.entity as 实体, t.targetId, 解(t.data, {})), 原因: e.message });
          }
        }
        await 重算最近跟进(tx, 碰过);
        await 入账(tx, 批次Id, "restoring", "恢复", { 恢复 }, 留);
      }),
    );
  const 出错跳过 = (t: 回收行, e: unknown) =>
    查完再写(async (tx) => {
      const n = await tx.entTrash.updateMany({ where: { id: t.id, restoredAt: null }, data: { restoredAt: new Date() } });
      if (n.count !== 1) throw new 让位();
      await 入账(tx, 批次Id, "restoring", "恢复", {}, [{ 实体: t.entity as 实体, 外部ID: "", 名称: t.targetId, 原因: 原因(e) }]);
    });

  const 跑过 = { 有: false };
  try {
    for (const e of 实体顺序) {
      // 回收区是倒着进来的：后进的先恢复 = 照原来写的顺序
      const 取 = () => prisma.entTrash.findMany({ where: { batchId: 批次Id, entity: e, restoredAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 每趟条数 });
      if (!(await 分段跑(截止, 跑过, 取, 一趟, 出错跳过))) return 结果(批次Id);
    }
  } catch (e) {
    if (!(e instanceof 让位)) throw e;
    return 结果(批次Id);
  }

  const n = await prisma.$transaction(async (tx) => {
    const n = await tx.entImportBatch.updateMany({ where: { id: 批次Id, status: "restoring" }, data: { status: "done", revertedAt: null } });
    if (n.count !== 1) return n;
    // 撤回时留下没动的那几行：恢复完又是这一批的了，下次撤回照常处理
    await tx.entImportRow.updateMany({ where: { batchId: 批次Id, undo: "留下" }, data: { undo: null } });
    // 冲突回到待定；同一条原系统记录之后又有一笔待定的，就不再翻出这一笔
    const 撤着 = await tx.entConflict.findMany({ where: { batchId: 批次Id, status: "已撤回" }, select: { id: true, source: true, entity: true, externalId: true } });
    for (const c of 撤着) {
      const 有新的 = await tx.entConflict.count({ where: { source: c.source, entity: c.entity, externalId: c.externalId, status: "待定" } });
      if (!有新的) await tx.entConflict.update({ where: { id: c.id }, data: { status: "待定" } });
    }
    if (批.kind === "resolve") await 冲突再定回去(tx, 批次Id, 批.plan, 批.userId);
    return n;
  });
  if (n.count === 1) {
    const r = await 结果(批次Id);
    await recordAudit({
      user: 用户,
      action: "ent-restore",
      entity: "EntImportBatch",
      entityId: 批次Id,
      summary: `恢复撤回的那一批（${来源名[批.source as 来源] ?? 批.source}${叫法(批.kind)}）：恢复 ${r.恢复} 条${r.留下数 ? `，${r.留下数} 条撤回后又有变动、跳过` : ""}`,
      detail: { batchId: 批次Id, 恢复: r.恢复, 留下数: r.留下数 },
    });
    for (const p of ["/customers", "/leads", "/opportunities", "/dashboard"]) revalidatePath(p);
  }
  return 结果(批次Id);
}

/* ───────────────────────── 冲突处理那一批 ───────────────────────── */

/** 冲突处理那一批记的计划：每一笔定的是哪个冲突、选了什么、当时冲突是哪一批记的、原系统那份的指纹 */
export type 定的一笔 = { 冲突Id: string; 选: "采用原系统" | "保留我们"; 批次Id: string | null; 指纹: string };

/** 这一笔冲突在这一批里记的那一行（本地已删又保留我们的没有行） */
const 那一行 = (tx: Tx, 批次Id: string, c: { entity: string; externalId: string }) =>
  tx.entImportRow.findFirst({ where: { batchId: 批次Id, entity: c.entity, externalId: c.externalId }, select: { undo: true } });

/** 撤回冲突处理那一批：定下的冲突回到待定。那一行留下没撤的、同一条原系统记录之后又有待定的，不动 */
async function 定的冲突回待定(tx: Tx, 批次Id: string): Promise<void> {
  const 定了 = await tx.entConflict.findMany({ where: { resolveBatchId: 批次Id, status: { in: ["采用原系统", "保留我们"] } } });
  for (const c of 定了) {
    if ((await 那一行(tx, 批次Id, c))?.undo === "留下") continue;
    const 有新的 = await tx.entConflict.count({ where: { source: c.source, entity: c.entity, externalId: c.externalId, status: "待定" } });
    if (!有新的) await tx.entConflict.update({ where: { id: c.id }, data: { status: "待定", resolvedById: null, resolvedAt: null } });
  }
}

/** 恢复冲突处理那一批：回到待定的冲突再定回去。撤回之后又同步过（冲突换了一份）、那一行没恢复的，仍待定 */
async function 冲突再定回去(tx: Tx, 批次Id: string, plan: string | null, userId: string | null): Promise<void> {
  for (const p of 解<定的一笔[]>(plan, [])) {
    const c = await tx.entConflict.findUnique({ where: { id: p.冲突Id } });
    if (!c || c.status !== "待定" || c.resolveBatchId !== 批次Id) continue;
    if (c.batchId !== p.批次Id || 解<{ 指纹?: string }>(c.incoming, {}).指纹 !== p.指纹) continue;
    const 行 = await 那一行(tx, 批次Id, c);
    if (行 && 行.undo !== null) continue;
    await tx.entConflict.update({ where: { id: c.id }, data: { status: p.选, resolvedById: userId, resolvedAt: new Date() } });
  }
}

async function 结果(批次Id: string): Promise<撤回结果> {
  const b = (await prisma.entImportBatch.findUnique({ where: { id: 批次Id } }))!;
  const a = 解<账 | null>(b.revertNote, null) ?? 空账("撤回");
  const { 动作, ...数 } = a;
  const 完了 = 动作 === "撤回" ? b.status === "reverted" : b.status === "done";
  return { 状态: b.status, 完了, ...数 };
}

/** 报告页用：留下的那几条按类分组的说法 */
export function 留下说法(x: 留下明细): string {
  return `${实体名[x.实体]}「${x.名称}」：${x.原因}`;
}
