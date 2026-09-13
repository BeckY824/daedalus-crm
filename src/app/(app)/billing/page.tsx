import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { daysLeft } from "@/lib/tenant/workspaces";
import BillingView from "./BillingView";

export const dynamic = "force-dynamic";

/**
 * 开通订阅。
 *
 * 这一版不接在线支付——微信商户号还在审核。先走「看价格 → 转账 → 填单号 → 我们开通」，
 * 一天就能上线，也足够验证有没有人真的愿意付。等商户号下来再把扫码接进来，
 * 这个页面的结构不用改，只是多一个付款方式。
 */
export default async function BillingPage() {
  await requireUser();
  if (!multiTenant()) redirect("/dashboard");

  const t = await resolveCurrentTenant();
  if (!t) redirect("/dashboard");

  const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
  if (!ws) redirect("/dashboard");

  return (
    <BillingView
      workspaceName={ws.name}
      status={ws.status}
      daysLeft={daysLeft(ws)}
      writable={t.writable}
      isOwner={t.role === "OWNER"}
      paidUntil={ws.paidUntil ? ws.paidUntil.toISOString() : null}
    />
  );
}
