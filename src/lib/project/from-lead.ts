/**
 * 企业版项目模式下，线索转化顺手建一个项目（10-25 F6）。
 *
 * 原来项目模式里线索只能「转客户」，转完客户上一个项目都没有，跟进流程断在线索这一步。
 * 现在转客户（convertLead）或并到已有客户（mergeLeadInto）时，在同一个事务里给那位客户建一个项目：
 * 名字用线索名（截到项目名上限），负责人跟线索负责人走，联系人挂客户的主要联系人，
 * 放在第一个节点、记一行节点变更，和建档向导建出来的项目一样。金额、币种留默认，到项目里再填。
 * 不是企业版或者没开项目模式时调用方不进这里，和原来一样只转客户。
 *
 * 10-26 验收 #13：转出来的项目没有来源线索、没有下一步时间、没有首条跟进，开了超时回收的一转过去就按节点时长在倒数，
 * 项目页上也看不出是哪条线索来的。现在转化时必须带一条首条跟进（和建档向导同一套规整，lib/project/wizard.ts 规整沟通）：
 * 跟进记在客户和主要联系人上、挂到项目的第一个节点，下一步时间写到项目上，项目记下来源线索 id。
 */
import type { Prisma } from "@/generated/prisma";
import { 默认币种 } from "../currency";
import { 第一个节点 } from "./nodes";
import { 项目名上限, type 规整好的沟通 } from "./wizard";

export async function 线索建项目(
  tx: Pick<Prisma.TransactionClient, "contact" | "project" | "projectNodeLog" | "followUp" | "followUpProject" | "customer">,
  a: { 线索名: string; leadId: string; customerId: string; ownerId: string; creatorId: string; 跟进: 规整好的沟通 },
): Promise<string> {
  const 联系人 = await tx.contact.findFirst({ where: { customerId: a.customerId, isPrimary: true }, select: { id: true } });
  const 项目 = await tx.project.create({
    data: {
      name: a.线索名.trim().slice(0, 项目名上限), customerId: a.customerId, contactId: 联系人?.id ?? null,
      ownerId: a.ownerId, creatorId: a.creatorId, amount: 0, currency: 默认币种,
      phase: 第一个节点.phase, node: 第一个节点.node, nextStepAt: a.跟进.nextStepAt, sourceLeadId: a.leadId,
    },
  });
  await tx.projectNodeLog.create({ data: { projectId: 项目.id, userId: a.creatorId, toPhase: 第一个节点.phase, toNode: 第一个节点.node } });
  const 跟进 = await tx.followUp.create({
    data: {
      type: a.跟进.type, content: a.跟进.content, occurredAt: a.跟进.occurredAt, title: "", status: "已完成",
      customerId: a.customerId, contactId: 联系人?.id ?? null, ownerId: a.creatorId,
    },
  });
  await tx.followUpProject.create({ data: { followUpId: 跟进.id, projectId: 项目.id, node: 第一个节点.node } });
  // 并到已有客户时那位可能有更晚的跟进：只往后挪，不往回改
  await tx.customer.updateMany({
    where: { id: a.customerId, OR: [{ lastFollowAt: null }, { lastFollowAt: { lt: a.跟进.occurredAt } }] },
    data: { lastFollowAt: a.跟进.occurredAt },
  });
  return 项目.id;
}
