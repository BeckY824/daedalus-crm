import { prisma } from "./prisma";

/**
 * 表单下拉里「选一个渠道 / 选一个客户」的候选。几张页面都要，口径放在一处：
 * 渠道只列在用的，按名字排；客户全列（排除自己，给「谁介绍来的」那种自引用用）。
 * 负责人候选规则多，单独在 owners.ts。
 */

export function 可选渠道() {
  return prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export function 可选客户(除了?: string) {
  return prisma.customer.findMany({
    where: 除了 ? { id: { not: 除了 } } : undefined,
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/**
 * 地址栏 `?customer=<id>` 带过来的那一位（跟进 / 计划页「新建」时预填）。
 * 查不到就当没带：id 是地址栏里的，可能过期、可能被人改过，不能原样信
 */
export async function 带过来的客户(id: string | undefined): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  return prisma.customer.findUnique({ where: { id }, select: { id: true, name: true } });
}
