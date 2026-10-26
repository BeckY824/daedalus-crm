/**
 * 企业版站内提醒（2026-10-26，A8 / 验收 7.6）：系统替某件事去叫某几个人，打开应用时弹出来。
 *
 * 第一个用处：自动分配时参与的人都满额，线索没分出去 → 市场管理、总管理员各一条。
 * 同一个人、同一类，没点「知道了」之前只留一条：再来一次就换成最新的内容、次数加 1，
 * 不会一天满额几十次就弹几十条。点了「知道了」写 readAt，下次再发是新的一条。
 */
import { prisma } from "@/lib/prisma";
import { 管理员类别of, type 组织, type 管理员类别 } from "./org-core";

export type 提醒类 = "线索满额";
export type 企业提醒 = { id: string; kind: string; title: string; body: string; link: string | null; times: number; updatedAt: Date };

/** 组织里属于这几类管理员的人（在职的才在组织里） */
export function 管理员们(org: 组织, 类别: readonly 管理员类别[]): string[] {
  return [...org.成员.keys()].filter((id) => {
    const c = 管理员类别of(org, id);
    return c !== null && 类别.includes(c);
  });
}

/** 给每个人发一条；同类没读的已有一条就刷新它、次数加 1 */
export async function 发企业提醒(userIds: readonly string[], n: { kind: 提醒类; title: string; body: string; link?: string | null }): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const 已有 = await prisma.entNotice.findMany({ where: { userId: { in: ids }, kind: n.kind, readAt: null }, select: { id: true, userId: true } });
  const 有的 = new Set(已有.map((x) => x.userId));
  await prisma.$transaction(async (tx) => {
    for (const x of 已有) await tx.entNotice.update({ where: { id: x.id }, data: { title: n.title, body: n.body, link: n.link ?? null, times: { increment: 1 } } });
    for (const userId of ids.filter((id) => !有的.has(id))) await tx.entNotice.create({ data: { userId, kind: n.kind, title: n.title, body: n.body, link: n.link ?? null } });
  });
}

/** 这个人没读的提醒，新的在前 */
export async function 没读的提醒(userId: string): Promise<企业提醒[]> {
  return prisma.entNotice.findMany({
    where: { userId, readAt: null },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, kind: true, title: true, body: true, link: true, times: true, updatedAt: true },
  });
}

/** 「知道了」：只动自己的；别人的 id 传进来什么也不改 */
export async function 读过提醒(userId: string, id: string): Promise<boolean> {
  const r = await prisma.entNotice.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  return r.count > 0;
}
