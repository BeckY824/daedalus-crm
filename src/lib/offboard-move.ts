import type { Prisma } from "@/generated/prisma";
import { 转交商机 } from "@/lib/opportunity-activity";
import { 转项目 } from "@/lib/carry-over-db";
import { 记换负责人 } from "@/lib/owner-log-db";
import { 转让痕 } from "@/lib/project/db";
import { 月份 } from "@/lib/enterprise/lead-assign";
import { 停用进公海理由, 停用项目进公海理由, type 停用分拣结果 } from "@/lib/offboard-db";

/**
 * 离职交接真动数据的两半（原来写在 settings/actions.ts deactivateUser 的事务里，2026-10-26 抽出来）：
 * 企业版「交接中」（规则「交接要接手人确认」，测试清单 D10）要把它拆开——放进公海的那半发起时就放，
 * 给接手人的那半等接手人确认了再给。规则关着时 deactivateUser 在同一笔事务里先后调这两半，顺序、写法和原来一字不差。
 * 两半都在调用方的事务里跑，分拣（停用分拣）也由调用方在同一笔事务里先做
 */

/** 给接手人的那半：客户改负责人（记历史负责人）、进行中商机、没做完的待办计划、线索、渠道、项目。返回转走的项目 id */
export async function 离职转给接手人(
  tx: Prisma.TransactionClient,
  分: 停用分拣结果,
  id: string,
  接手人: string,
  操作人: string,
  记分配: boolean,
): Promise<string[]> {
  await tx.customer.updateMany({ where: { id: { in: 分.客户 } }, data: { salesOwnerId: 接手人 } });
  // 历史负责人：每位转走的客户记一行「他 → 接手人」（D-36）；进公海的负责人不改，等领的时候再记
  await 记换负责人(tx, 分.客户.map((customerId) => ({ customerId, from: id, to: 接手人 })), 操作人, "deactivate");
  await 转交商机(tx, { id: { in: 分.商机 }, ownerId: id, status: "OPEN" }, 接手人);
  await tx.task.updateMany({ where: { id: { in: 分.待办 } }, data: { ownerId: 接手人 } });
  await tx.followPlan.updateMany({ where: { id: { in: 分.计划 } }, data: { ownerId: 接手人 } });
  /**
   * 线索、渠道原本漏了转交：
   *   线索      —— 留在停用的人名下，列表按负责人筛选时谁都看不到，等于丢了
   *   渠道负责人 —— Channel.channelOwnerId 还指着停用的人，之后这个渠道新带来的学员会继续算到一个离职的人头上
   */
  await tx.lead.updateMany({ where: { id: { in: 分.线索 } }, data: { ownerId: 接手人 } });
  if (记分配) await 记交接分配(tx, 分.线索, id, 接手人, 操作人);
  await tx.channel.updateMany({ where: { id: { in: 分.渠道 } }, data: { channelOwnerId: 接手人 } });
  // 项目：跟着转走的客户整体转（同转让客户，跟着客户转的项目），企业版再加上他负责、挂在别人客户上的
  return 分.项目.length ? await 转项目(tx, { id: { in: 分.项目 }, pooledAt: null }, 接手人, 操作人) : [];
}

/** 放进公海的那半（企业版「放进公海」方式）：客户进客户公海，他负责、挂在别人客户上的线索 / 商机阶段项目放回项目公海 */
export async function 离职放进公海(tx: Prisma.TransactionClient, 分: 停用分拣结果, 操作人: string): Promise<void> {
  if (分.进公海客户.length) {
    await tx.customerPool.createMany({ data: 分.进公海客户.map((customerId) => ({ customerId, userId: 操作人, reason: 停用进公海理由 })) });
  }
  if (分.进公海项目.length) {
    const 们 = await tx.project.findMany({ where: { id: { in: 分.进公海项目 } }, select: { id: true, ownerId: true, phase: true, node: true, result: true } });
    await tx.project.updateMany({ where: { id: { in: 分.进公海项目 } }, data: { pooledAt: new Date(), nextStepAt: null } });
    await tx.projectNodeLog.createMany({ data: 们.map((p) => 转让痕(p, 操作人, p.ownerId, null, "pool-release", 停用项目进公海理由)) });
  }
}

/**
 * 企业版「线索分配」开着时，离职转给接手人的线索也记一行分配（EntLeadAssign），和手动分配同一张表：
 * 分配记录里查得到这条线索怎么到了接手人手上。只记还没转化的；不算进接手人当月的分配数（counted=false），
 * 交接来的不占配额；走哪条线不填，种类沿用这条线索最近一次分配的（没分配过 = 营销）
 */
async function 记交接分配(tx: Prisma.TransactionClient, 线索: string[], from: string, to: string, by: string) {
  if (!线索.length) return;
  const 没转化 = (await tx.lead.findMany({ where: { id: { in: 线索 }, convertedAt: null }, select: { id: true } })).map((l) => l.id);
  if (!没转化.length) return;
  const 上次 = new Map<string, string>();
  for (const r of await tx.entLeadAssign.findMany({ where: { leadId: { in: 没转化 } }, orderBy: { createdAt: "desc" }, select: { leadId: true, kind: true } })) {
    if (!上次.has(r.leadId)) 上次.set(r.leadId, r.kind);
  }
  const 月 = 月份();
  await tx.entLeadAssign.createMany({
    data: 没转化.map((leadId) => ({ leadId, toUserId: to, fromUserId: from, byUserId: by, line: null, kind: 上次.get(leadId) ?? "营销", counted: false, month: 月 })),
  });
}
