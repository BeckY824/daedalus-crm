import type { Prisma } from "@/generated/prisma";
import { 转交商机 } from "@/lib/opportunity-activity";
import { prisma } from "@/lib/prisma";
import { 记转让 } from "@/lib/project/db";
import { 看全部 } from "@/lib/team-scope";
import type { 带走数 } from "@/lib/carry-over";

/**
 * 客户换了销售负责人，原负责人在他身上**没做完的活**跟着走（2026-10-02 排查 B3）：
 * 没完成的计划、待办，进行中的商机。原来不跟：客户转给李四以后，到点提醒、早报还发给张三，李四收不到。
 * 只动原负责人名下的——别的同事挂在这位客户上的活不碰；做完的、赢单丢单的是历史，不动。
 * 项目（团队版项目模式）不一样，见 跟着客户转的项目：客户名下整体转，不管原来是谁负责、有没有结局。
 */
export async function 带走没做完的(换: { customerId: string; 旧: string }[], 新: string, 操作人?: string): Promise<带走数> {
  return (await 带走并记下(换, 新, 操作人)).数;
}

/**
 * 客户转给别人时，哪些项目跟着走（团队版项目模式 1a，2026-10-23 定「整体转」）：这位客户名下的项目
 * 不管原来是谁负责的，都连同客户一起转给新负责人；只有放在项目公海里的不动（等人领）。
 * 改负责人、批量分配、公海领取 / 分配、停用成员都走这一处。单个项目手动转让另走 改项目
 */
export function 跟着客户转的项目(customerId: string): Prisma.ProjectWhereInput {
  return { customerId, pooledAt: null };
}

/** 把挑出来的项目转给新负责人，每个项目记一行转让痕（谁、何时、从谁到谁）；返回转了哪几个 */
export async function 转项目(tx: Prisma.TransactionClient, where: Prisma.ProjectWhereInput, 新: string, 操作人: string): Promise<string[]> {
  const 们 = await tx.project.findMany({ where: { AND: [where, { ownerId: { not: 新 } }] }, select: { id: true, ownerId: true, phase: true, node: true, result: true } });
  for (const p of 们) {
    await tx.project.update({ where: { id: p.id }, data: { ownerId: 新 } });
    await 记转让(tx, p, 操作人, p.ownerId, 新);
  }
  return 们.map((p) => p.id);
}

/**
 * 撤销时把带过来的项目还回去：只还「还在这位客户下、还归现负责人、没进公海」的。
 * 整体转会带走别的同事负责的项目，所以各还各的：按这个项目最近一行「转给现负责人」的转让痕还给当时的负责人，
 * 找不到痕的（老数据）还给客户原负责人
 */
export async function 还项目(tx: Prisma.TransactionClient, ids: string[] | undefined, customerId: string, 现: string, 原: string, 操作人: string) {
  if (!ids?.length) return;
  const 们 = await tx.project.findMany({ where: { id: { in: ids }, customerId, ownerId: 现, pooledAt: null }, select: { id: true, phase: true, node: true, result: true } });
  for (const p of 们) {
    const 痕 = await tx.projectNodeLog.findFirst({ where: { projectId: p.id, kind: "transfer", toOwnerId: 现 }, orderBy: { at: "desc" }, select: { fromOwnerId: true } });
    const 还给 = 痕?.fromOwnerId ?? 原;
    if (还给 === 现) continue;
    await tx.project.update({ where: { id: p.id }, data: { ownerId: 还给 } });
    await 记转让(tx, p, 操作人, 现, 还给);
  }
}

/** 转走的是哪几条（撤销时只还这几条，不碰「转之前就归新负责人」的那些——0.46.15 公海复查）。项目可能没有：老版本撤销条上带回来的没这一项 */
export type 带走的 = { 计划: string[]; 待办: string[]; 商机: string[]; 项目?: string[] };

/** 同 带走没做完的，另外返回转走的那几条的 id。操作人记在项目的转让痕上，不给就记新负责人 */
export async function 带走并记下(换: { customerId: string; 旧: string }[], 新: string, 操作人: string = 新): Promise<{ 数: 带走数; 记下: 带走的 }> {
  const 数: 带走数 = { 计划和待办: 0, 商机: 0, 项目: 0 };
  const 记下: 带走的 = { 计划: [], 待办: [], 商机: [], 项目: [] };
  for (const { customerId, 旧 } of 换) {
    if (旧 === 新) continue;
    /*
      函数式事务，不用数组式：托管版的 prisma 是按工作区解析的代理，模型方法一调就执行、返回原生 Promise，
      数组式 $transaction 收到它会直接抛错（而那几条已经写进去了）。函数式拿到的 tx 是真客户端，两边都对（2026-10-02 排查 A3）
      先取 id 再按 id 改：同一个事务里，取到的就是改掉的
    */
    /*
      看全部（团队版业务员，lib/team-scope.ts）：业务员把自己的客户交给同事，客户一换负责人他就看不到了，
      限定着查会漏掉这位客户上的商机（商机跟着客户可见），活带不过去（2026-10-04 五人实测）。要转哪几条由上面的条件定，不靠限定
    */
    const [计划, 待办, 商机, 项目] = await 看全部(() => prisma.$transaction(async (tx) => {
      const 计划 = (await tx.followPlan.findMany({ where: { customerId, ownerId: 旧, done: false }, select: { id: true } })).map((x) => x.id);
      const 待办 = (await tx.task.findMany({ where: { customerId, ownerId: 旧, done: false }, select: { id: true } })).map((x) => x.id);
      const 商机 = (await tx.opportunity.findMany({ where: { customerId, ownerId: 旧, status: "OPEN" }, select: { id: true } })).map((x) => x.id);
      if (计划.length) await tx.followPlan.updateMany({ where: { id: { in: 计划 } }, data: { ownerId: 新 } });
      if (待办.length) await tx.task.updateMany({ where: { id: { in: 待办 } }, data: { ownerId: 新 } });
      if (商机.length) await 转交商机(tx, { id: { in: 商机 } }, 新);
      const 项目 = await 转项目(tx, 跟着客户转的项目(customerId), 新, 操作人);
      return [计划, 待办, 商机, 项目];
    }));
    数.计划和待办 += 计划.length + 待办.length;
    数.商机 += 商机.length;
    数.项目 = (数.项目 ?? 0) + 项目.length;
    记下.项目!.push(...项目);
    记下.计划.push(...计划);
    记下.待办.push(...待办);
    记下.商机.push(...商机);
  }
  return { 数, 记下 };
}
