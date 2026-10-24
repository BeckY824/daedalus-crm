"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 取详情 } from "@/lib/plans-page";

/**
 * 跟进计划页分批时，页面上要摆、手里却没有详情的那几条（2026-10-24）：
 * 「再看 50 条」刚翻完还没刷新、浏览器和服务器时区不同分组差了几条、刚新建的那条。
 * 和整页一样走同一个按团队范围收窄的 prisma，只取还没做完的。
 * 不叫 actions.ts：几个页面测试把 actions 整个换成桩，这里得照常跑。
 */
export async function 补计划详情(keys: string[]) {
  await requireUser();
  if (!Array.isArray(keys) || keys.length > 500 || !keys.every((k) => typeof k === "string" && /^(plan|task):[\w-]+$/.test(k))) {
    return { plans: [], tasks: [] };
  }
  return 取详情(prisma, keys);
}
