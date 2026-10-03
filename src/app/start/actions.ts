"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { saveBusiness } from "@/lib/business";
import { BUSINESS_PRESETS, 模版预设, 模版名, type BusinessTemplate } from "@/lib/business-config";
import { setSetting } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { 选过模版键, 要选模版 } from "@/lib/onboarding";

/**
 * 选了哪个模版就整组套哪个预设（措辞、来源选项、本位币、模版本身），记一笔「选过了」。
 * 只在 要选模版() 为真时生效：页面跳过了也拦——Server Action 是独立端点，不经过页面也调得到，
 * 不能让它变成一个绕过「保存前看一眼」直接改全站措辞的口子
 */
export async function 选模版(t: BusinessTemplate): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { ok: false, error: "只有管理员能选模版" };
  if (t !== "general" && t !== "trade") return { ok: false, error: "没有这个模版" };
  if (!(await 要选模版())) return { ok: true };
  await saveBusiness(BUSINESS_PRESETS[模版预设[t]]);
  await setSetting(选过模版键, new Date().toISOString());
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "business", summary: `新用户选了「${模版名[t]}」模版` });
  revalidatePath("/", "layout");
  return { ok: true };
}
