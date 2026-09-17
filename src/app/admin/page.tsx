import { notFound } from "next/navigation";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { computeWritable, daysLeft } from "@/lib/tenant/workspaces";
import AdminView from "./AdminView";

export const dynamic = "force-dynamic";

/**
 * 运营台：看有多少工作区在试用、谁提交了付款、手动开通。
 *
 * 刻意**不挂在应用的登录体系里**——它属于我们，不属于任何工作区，
 * 而 (app) 下的所有页面都会被 requireUser 拉进某个工作区的上下文。
 * 用一个独立的 ADMIN_TOKEN 保护：只有我们几个人用，不值得为它做一套账号。
 *
 * 这里原来还管着三种码（一次性邀请码、万能码、演示码）的生成和查看。
 * 整套码 2026-09-15 下线：开号只有「注册」一条路，演示区进门不要码。
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = process.env.ADMIN_TOKEN;
  const { token: given } = await searchParams;
  // 没配 token 就当这个页面不存在，免得自部署的人暴露一个无保护的运营台
  if (!multiTenant() || !token || given !== token) notFound();

  const [rows, 赠送, 用量, 反馈] = await Promise.all([
    control.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { memberships: { include: { account: true } } },
    }),
    // AI 次数：每个工作区送了多少、用了多少，运营台一眼看到谁快用完了
    control.aiGrant.groupBy({ by: ["workspaceId"], _sum: { amount: true } }),
    control.aiUsage.findMany(),
    /* 用户从界面里发来的话。没人看的收件箱等于没有这个功能，所以它和工作区摆在同一页 */
    control.feedback.findMany({ orderBy: { at: "desc" }, take: 100 }),
  ]);
  const 送表 = new Map(赠送.map((g) => [g.workspaceId, g._sum.amount ?? 0]));
  const 用表 = new Map(用量.map((u) => [u.workspaceId, u.calls]));

  const list = rows.map((w) => {
    const owner = w.memberships.find((m) => m.role === "OWNER")?.account;
    const 送 = 送表.get(w.id) ?? 0;
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      status: w.status,
      writable: computeWritable(w),
      daysLeft: daysLeft(w),
      createdAt: w.createdAt.toISOString(),
      paidUntil: w.paidUntil ? w.paidUntil.toISOString() : null,
      members: w.memberships.length,
      owner: owner ? { name: owner.name, contact: owner.phone ?? owner.email ?? "" } : null,
      ai: { 送, 剩: Math.max(0, 送 - (用表.get(w.id) ?? 0)) },
      // 待核对的付款记在这里，运营台一眼看到谁交了钱
      note: w.note,
    };
  });

  /*
    顶栏那个环境标记。这一页对着的是线上库，一个动作就能停掉别人的工作区——
    人得一眼知道自己点的是生产还是本地。
  */
  return (
    <AdminView
      token={given}
      rows={list}
      环境={process.env.NODE_ENV === "production" ? "生产" : "本地"}
      反馈={反馈.map((f) => ({
        id: f.id,
        at: f.at.toISOString(),
        source: f.source,
        body: f.body,
        path: f.path,
        version: f.version,
        platform: f.platform,
        who: f.who,
        handled: f.handled,
      }))}
    />
  );
}
