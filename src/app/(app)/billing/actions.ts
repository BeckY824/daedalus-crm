"use server";

import { requireUser } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { isPlanKey, PLANS } from "@/lib/tenant/plans";

export type PayResult = { ok: true } | { ok: false; error: string };

/**
 * 提交付款信息。
 *
 * 注意它**不会**开通订阅——只是把单号记到工作区备注里，等人核对。
 * 让用户自己点一下就延长有效期，等于把付费做成了荣誉制度。
 * 真正的开通只有两条路：后台手动（现在）或支付回调（商户号下来之后）。
 */
export async function submitPayment(input: { plan: string; reference: string }): Promise<PayResult> {
  await requireUser();
  if (!multiTenant()) return { ok: false, error: "这个部署不需要订阅" };

  const t = await resolveCurrentTenant();
  if (!t) return { ok: false, error: "没有工作区上下文" };
  // 只有创建者能提交，避免同一个工作区收到几份互相矛盾的付款信息
  if (t.role !== "OWNER") return { ok: false, error: "只有工作区创建者能开通" };
  if (!isPlanKey(input.plan)) return { ok: false, error: "套餐不对" };

  const ref = input.reference.trim().slice(0, 64);
  if (ref.length < 4) return { ok: false, error: "请填写转账单号" };

  const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
  if (!ws) return { ok: false, error: "工作区不存在" };

  const 记录 = `[待核对] ${new Date().toISOString().slice(0, 10)} ${PLANS[input.plan].label} ¥${PLANS[input.plan].price} 单号 ${ref}`;
  await control.workspace.update({
    where: { id: t.workspaceId },
    // 追加而不是覆盖：续费第二次时上一次的记录还得能查
    data: { note: ws.note ? `${ws.note}\n${记录}` : 记录 },
  });
  console.info(`[billing] 待核对付款 workspace=${ws.slug} ${记录}`);
  return { ok: true };
}
