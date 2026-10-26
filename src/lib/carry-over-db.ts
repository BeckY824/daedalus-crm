import type { Prisma } from "@/generated/prisma";
import { 转交商机 } from "@/lib/opportunity-activity";
import { prisma } from "@/lib/prisma";
import { 记转让, 转让痕, 收回提醒尾 } from "@/lib/project/db";
import { 看全部 } from "@/lib/team-scope";
import { 记换负责人, type 换负责人种类 } from "@/lib/owner-log-db";
import { 预览列几个, type 带走数, type 转走项目预览 } from "@/lib/carry-over";

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

/**
 * 转之前先数一数会一起转走哪些项目（企业版 D-36「转之前先列出会一起转走的 N 个项目」，2026-10-24）。
 * 条件和真转的一样：要换人的客户（负责人不是新的）× 跟着客户转的项目 × 负责人不是新的，数出来的就是转完说的那个数。
 * 客户按调用方能看到的算（限定着查，看不到的本来也转不了）；项目看全部：整体转会带走同事负责的，那些也得列出来
 */
export async function 数转走的项目(ids: string[], 新: string): Promise<转走项目预览> {
  if (!ids.length) return { 项目数: 0, 项目: [] };
  const 换人的 = (await prisma.customer.findMany({ where: { id: { in: [...new Set(ids)] }, salesOwnerId: { not: 新 } }, select: { id: true } })).map((c) => c.id);
  if (!换人的.length) return { 项目数: 0, 项目: [] };
  const where: Prisma.ProjectWhereInput = { AND: [{ OR: 换人的.map(跟着客户转的项目) }, { ownerId: { not: 新 } }] };
  return 看全部(async () => {
    const [项目数, 们] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({ where, orderBy: { createdAt: "asc" }, take: 预览列几个, select: { name: true, customer: { select: { name: true } } } }),
    ]);
    return { 项目数, 项目: 们.map((p) => ({ name: p.name, 客户: p.customer.name })) };
  });
}

/**
 * 把挑出来的项目转给新负责人，每个项目记一行转让痕（谁、何时、从谁到谁）；返回转了哪几个。
 * 一次改、一次写痕：停用成员一次转一两百个，逐个改会拖到事务超时（企业版 D-36 要求 200 条一次做完）。
 * 上一位填的下一步时间不替新负责人算，同手动转让（改项目）
 */
export async function 转项目(tx: Prisma.TransactionClient, where: Prisma.ProjectWhereInput, 新: string, 操作人: string): Promise<string[]> {
  const 们 = await tx.project.findMany({ where: { AND: [where, { ownerId: { not: 新 } }] }, select: { id: true, ownerId: true, phase: true, node: true, result: true } });
  if (!们.length) return [];
  const ids = 们.map((p) => p.id);
  await tx.project.updateMany({ where: { id: { in: ids } }, data: { ownerId: 新, nextStepAt: null } });
  await tx.projectNodeLog.createMany({ data: 们.map((p) => 转让痕(p, 操作人, p.ownerId, 新)) });
  return ids;
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

/**
 * 同 带走没做完的，另外返回转走的那几条的 id。操作人记在项目的转让痕上，不给就记新负责人。
 * 同一个事务里记一行换负责人（kind 分得出是改负责人、公海领取还是公海分配，见 owner-log-db.ts）
 */
export async function 带走并记下(换: { customerId: string; 旧: string }[], 新: string, 操作人: string = 新, kind: 换负责人种类 = "assign"): Promise<{ 数: 带走数; 记下: 带走的 }> {
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
    const { 计划, 待办, 商机, 项目 } = await 看全部(() => prisma.$transaction((tx) => 带走一位(tx, customerId, 旧, 新, 操作人, kind)));
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

/**
 * 带走并记下 里一位客户的那一段，放在调用方自己的事务里做（企业版领项目公海时客户一起领过来，
 * 项目和客户在同一笔事务里换人；事务里不能再开事务）。调用方自己管限定（要转哪几条由条件定，不靠限定）
 */
export async function 带走一位(tx: Prisma.TransactionClient, customerId: string, 旧: string, 新: string, 操作人: string, kind: 换负责人种类) {
  const 计划 = (await tx.followPlan.findMany({ where: { customerId, ownerId: 旧, done: false }, select: { id: true } })).map((x) => x.id);
  // 超时收回的提醒是给原负责人的，不跟着转（企业版单项目客户随项目进了公海，领客户时提醒别落到新负责人头上）
  const 待办 = (await tx.task.findMany({ where: { customerId, ownerId: 旧, done: false, NOT: { title: { endsWith: 收回提醒尾 } } }, select: { id: true } })).map((x) => x.id);
  const 商机 = (await tx.opportunity.findMany({ where: { customerId, ownerId: 旧, status: "OPEN" }, select: { id: true } })).map((x) => x.id);
  if (计划.length) await tx.followPlan.updateMany({ where: { id: { in: 计划 } }, data: { ownerId: 新 } });
  if (待办.length) await tx.task.updateMany({ where: { id: { in: 待办 } }, data: { ownerId: 新 } });
  if (商机.length) await 转交商机(tx, { id: { in: 商机 } }, 新);
  const 项目 = await 转项目(tx, 跟着客户转的项目(customerId), 新, 操作人);
  await 记换负责人(tx, [{ customerId, from: 旧, to: 新 }], 操作人, kind);
  return { 计划, 待办, 商机, 项目 };
}
