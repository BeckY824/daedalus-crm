import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";

/**
 * 收藏的客户怎么存、怎么读（左栏那一栏，改动在 app/(app)/favorites.ts）。
 * 读的这一半不放在 "use server" 文件里：那里导出的每个函数都能被浏览器直接调，
 * 一个收 userId 的读函数放过去，就成了「传别人的 id 读别人的收藏」。
 */
export const 收藏键 = (userId: string) => `favorites:${userId}`;

export type 收藏项 = { id: string; name: string };

export async function 读收藏(userId: string): Promise<收藏项[]> {
  const ids = (await getSetting<string[]>(收藏键(userId))) ?? [];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const rows = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const 按id = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => 按id.get(id)).filter((x): x is 收藏项 => Boolean(x));
}

export async function 收藏了吗(userId: string, customerId: string): Promise<boolean> {
  const ids = (await getSetting<string[]>(收藏键(userId))) ?? [];
  return Array.isArray(ids) && ids.includes(customerId);
}
