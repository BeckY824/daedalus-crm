"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { 收藏键 as 键 } from "@/lib/favorites";

/**
 * 收藏的客户（2026-10-02，左栏「收藏的客户」那一栏，学的是 MonoCode 左栏的项目列表）。
 *
 * 存在 Setting 里，一人一份（键带用户 id）：团队版同事各收各的，不互相看见。
 * 不在客户表上加列——迁移只增不改，而「谁收藏了谁」本来就是人的偏好，不是客户的属性。
 * 只存 id；名字每次从库里现查，客户改了名左栏跟着变，删了的自然消失。
 */
const 上限 = 8;
/** 收藏 / 取消。新收藏的排最前；满了挤掉最早的那位 */
export async function 切换收藏(customerId: string): Promise<{ ok: true; 收藏了: boolean } | { ok: false; error: string }> {
  const user = await requireUser();
  const 有 = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!有) return { ok: false, error: "这位客户已经不在了" };
  const 旧 = ((await getSetting<string[]>(键(user.id))) ?? []).filter((x) => typeof x === "string");
  const 收藏了 = !旧.includes(customerId);
  const 新 = 收藏了 ? [customerId, ...旧].slice(0, 上限) : 旧.filter((x) => x !== customerId);
  await setSetting(键(user.id), 新);
  // 左栏在 layout 里，layout 客户端导航不重算：让它重新取一次
  revalidatePath("/", "layout");
  return { ok: true, 收藏了 };
}
