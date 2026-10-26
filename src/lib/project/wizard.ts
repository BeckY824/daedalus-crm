/**
 * 项目模式的建档向导（2026-10-23，D-31）：查重 → 联系人 → 客户 → 项目 → 首条跟进，最后一步才落库，一笔事务。
 * 客户那部分整个交给 saveCustomer（查重、校验、外贸档案都是那一份），这里只管后面四样：
 * 先把交上来的规整好、该拦的先拦，再给 saveCustomer 一个「接着建」，在建客户的同一个事务里写下去。
 * 中途哪一步失败整笔回滚：客户、联系人、项目、跟进一行不留（tests/project-wizard.test.ts）。
 */
import type { Prisma } from "@/generated/prisma";
import { hasVisibleText } from "../form-validation";
import { parseDateInput } from "../date-input";
import { FOLLOW_TYPES } from "../constants";
import { 是币种, 默认币种 } from "../currency";
import { dayjs } from "../utils";
import { 第一个节点, 企业版字典, 节点序号 } from "./nodes";
import { 有效线索节点, 缺有效沟通, 记沟通标记 } from "./stage-gates";
import { 登记接着建, type 接着建 } from "./hook";

export const 项目名上限 = 60;
export const 备注上限 = 500;

export type 向导联系人 = { name: string; position?: string | null; phone?: string | null; email?: string | null; wechat?: string | null };
export type 向导项目 = { name: string; ownerId?: string | null; amount?: number | null; currency?: string | null; remark?: string | null };
/** 下一步时间：企业版开了超时回收时线索、商机阶段必填（lib/project/timeout.ts），没开可不填 */
/**
 * 阶段、明确回复：企业版记沟通必选（lib/project/stage-gates.ts 的 记沟通阶段问题），团队版不传、不看
 */
export type 向导跟进 = { type: string; content: string; occurredAt: string; 下一步时间?: string | null; 阶段?: string; 明确回复?: boolean | null;
  /** 企业版建档向导：项目建在线索阶段的哪个节点（跟进节点，必选）；团队版不传，一律潜客培育 */
  节点?: string | null };

export type 规整好的 = {
  联系人: { name: string; position: string | null; phone: string | null; email: string | null; wechat: string | null };
  项目: { name: string; ownerId: string; amount: number; currency: string; remark: string | null };
  跟进: 规整好的沟通;
  /** 企业版建档（10-26）：项目落在哪个线索节点、首条沟通客户是否明确回复；团队版没有 */
  企业?: { 节点: string; 明确回复: boolean };
};

export type 规整好的沟通 = { type: string; content: string; occurredAt: Date; nextStepAt: Date | null };

export const 要下一步时间 = "开了超时回收：线索、商机阶段的项目记沟通要填下一步时间";

/** 首条跟进记的是一次沟通；待办、提醒要带时间，进了项目页再排 */
const 首条能记的 = FOLLOW_TYPES.filter((t) => t.value !== "TASK" && t.value !== "REMIND").map((t) => t.value as string);

const 文字 = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const 可空 = (v: unknown) => 文字(v) || null;

/** 项目那几格（名称、负责人、金额、币种、备注）规整一遍：向导第四步和项目详情里「编辑」共用。负责人没选 = 默认那位 */
export function 规整项目(p: 向导项目, 默认负责人: string): 规整好的["项目"] | { error: string } {
  if (!hasVisibleText(p.name)) return { error: "请填写项目名称" };
  if (文字(p.name).length > 项目名上限) return { error: `项目名称请控制在 ${项目名上限} 字以内` };
  const amount = p.amount ?? 0;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return { error: "项目金额不能为负数" };
  const currency = p.currency || 默认币种;
  if (!是币种(currency)) return { error: `币种「${currency}」认不出来` };
  if (文字(p.remark).length > 备注上限) return { error: `项目备注请控制在 ${备注上限} 字以内` };
  return { name: 文字(p.name), ownerId: p.ownerId || 默认负责人, amount, currency, remark: 可空(p.remark) };
}

/**
 * 一条项目沟通规整一遍：向导的首条跟进、项目详情里「记一条」共用。
 * 要下一步 = 开了超时回收、项目在线索 / 商机阶段（调用方判断）；下一步时间填了就得是今天或以后
 */
export function 规整沟通(
  f: 向导跟进,
  opt: { 要下一步: boolean; now?: Date; 叫法?: string },
): 规整好的沟通 | { error: string } {
  const now = opt.now ?? new Date(), 叫 = opt.叫法 ?? "";
  if (!首条能记的.includes(f.type)) return { error: `${叫}跟进的类型「${f.type}」不能选` };
  if (!hasVisibleText(f.content)) return { error: `请填写${叫}跟进的沟通内容` };
  const occurredAt = parseDateInput(f.occurredAt);
  if (!occurredAt) return { error: `${叫}跟进的时间格式不正确` };
  if (occurredAt.getTime() > now.getTime() + 60_000) return { error: `${叫}跟进的时间不能在未来` };
  let nextStepAt: Date | null = null;
  if (文字(f.下一步时间)) {
    nextStepAt = parseDateInput(f.下一步时间);
    if (!nextStepAt) return { error: "下一步时间格式不正确" };
    if (dayjs(nextStepAt).format("YYYY-MM-DD") < dayjs(now).format("YYYY-MM-DD")) return { error: "下一步时间不能早于今天" };
  } else if (opt.要下一步) return { error: 要下一步时间 };
  return { type: f.type, content: 文字(f.content), occurredAt, nextStepAt };
}

/** 后四步交上来的规整一遍。负责人没选 = 自己；在不在职由调用方查库。要下一步 = 开了超时回收（项目建在线索阶段） */
export function 规整向导(
  me: { id: string },
  input: { 联系人?: 向导联系人; 项目?: 向导项目; 跟进?: 向导跟进 },
  now = new Date(),
  要下一步 = false,
  企业 = false,
): 规整好的 | { error: string } {
  const c = input.联系人, p = input.项目, f = input.跟进;
  if (!c || !p || !f) return { error: "建档信息不完整，请从头再走一遍" };
  if (!hasVisibleText(c.name)) return { error: "请填写联系人姓名" };
  const 电话 = 可空(c.phone);
  if (电话?.includes("*")) return { error: "联系人电话里不能有 *" };

  const 项目 = 规整项目(p, me.id);
  if ("error" in 项目) return 项目;

  const 跟进 = 规整沟通(f, { 要下一步, now, 叫法: "首条" });
  if ("error" in 跟进) return 跟进;

  // 企业版新建线索（10-26）：负责人必选（不默认自己）、跟进节点必选、客户是否明确回复必选；渠道必选在 建档向导 里查库
  let 企业档: 规整好的["企业"];
  if (企业) {
    if (!文字(p.ownerId)) return { error: "请选项目负责人" };
    const 节点 = 文字(f.节点);
    if (!企业版字典.节点们.线索.includes(节点)) return { error: "请选跟进节点（线索阶段的哪一步）" };
    if (typeof f.明确回复 !== "boolean") return { error: "请选客户是否明确回复" };
    if (节点序号({ phase: "线索", node: 节点 }, 企业版字典) > 节点序号({ phase: "线索", node: 有效线索节点 }, 企业版字典) && !f.明确回复) {
      return { error: 缺有效沟通 };
    }
    企业档 = { 节点, 明确回复: f.明确回复 };
  }

  return {
    联系人: { name: 文字(c.name), position: 可空(c.position), phone: 电话, email: 可空(c.email), wechat: 可空(c.wechat) },
    项目,
    跟进,
    ...(企业档 ? { 企业: 企业档 } : {}),
  };
}

export type 建好的 = { contactId: string; projectId: string; followUpId: string };

/**
 * 给 saveCustomer 的「接着建」：主要联系人、建档人、项目（落在潜客培育，记第一行节点变更）、首条跟进挂上项目。
 * 只用 tx；建好的 id 写进 出参，事务提交了才算数
 */
export function 向导接着建(me: { id: string }, 好: 规整好的, 出参: Partial<建好的>): 接着建 {
  return 登记接着建(async (tx: Prisma.TransactionClient, customerId: string) => {
    const 联系人 = await tx.contact.create({ data: { ...好.联系人, isPrimary: true, customerId } });
    await tx.customerCreator.create({ data: { customerId, userId: me.id } });
    // 企业版建档选了跟进节点就落在那，团队版一律潜客培育
    const 落 = { phase: 第一个节点.phase, node: 好.企业?.节点 ?? 第一个节点.node };
    const 项目 = await tx.project.create({
      data: {
        ...好.项目, customerId, contactId: 联系人.id, creatorId: me.id,
        phase: 落.phase, node: 落.node, nextStepAt: 好.跟进.nextStepAt,
      },
    });
    await tx.projectNodeLog.create({ data: { projectId: 项目.id, userId: me.id, toPhase: 落.phase, toNode: 落.node } });
    const 跟进 = await tx.followUp.create({
      data: { type: 好.跟进.type, content: 好.跟进.content, occurredAt: 好.跟进.occurredAt, title: "", status: "已完成", customerId, contactId: 联系人.id, ownerId: me.id },
    });
    await tx.followUpProject.create({ data: { followUpId: 跟进.id, projectId: 项目.id, node: 落.node } });
    if (好.企业) await 记沟通标记(tx, 跟进.id, 项目.id, 落.phase, 好.企业.明确回复);
    await tx.customer.update({ where: { id: customerId }, data: { lastFollowAt: 好.跟进.occurredAt } });
    Object.assign(出参, { contactId: 联系人.id, projectId: 项目.id, followUpId: 跟进.id });
  });
}
