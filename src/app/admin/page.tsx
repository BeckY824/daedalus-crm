import { notFound } from "next/navigation";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { computeWritable, daysLeft } from "@/lib/tenant/workspaces";
import AdminView from "./AdminView";
import { 展示, 取万能码, 演示对话上限 } from "@/lib/tenant/activation";

export const dynamic = "force-dynamic";

/**
 * 运营台：看有多少工作区在试用、谁提交了付款、手动开通。
 *
 * 刻意**不挂在应用的登录体系里**——它属于我们，不属于任何工作区，
 * 而 (app) 下的所有页面都会被 requireUser 拉进某个工作区的上下文。
 * 用一个独立的 ADMIN_TOKEN 保护：只有我们几个人用，不值得为它做一套账号。
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = process.env.ADMIN_TOKEN;
  const { token: given } = await searchParams;
  // 没配 token 就当这个页面不存在，免得自部署的人暴露一个无保护的运营台
  if (!multiTenant() || !token || given !== token) notFound();

  const [rows, 赠送, 用量, master, 演示, 码] = await Promise.all([
    control.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { memberships: { include: { account: true } } },
    }),
    // AI 次数：每个工作区送了多少、用了多少，运营台一眼看到谁快用完了
    control.aiGrant.groupBy({ by: ["workspaceId"], _sum: { amount: true } }),
    control.aiUsage.findMany(),
    // 万能邀请码：一个，可换。没生成过就是 null，界面上给一个「生成」
    取万能码(),
    // 演示码：最近 200 个，未绑的排前面
    control.demoCode.findMany({ orderBy: [{ boundAt: "asc" }, { createdAt: "desc" }], take: 200 }),
    // 一次性邀请码（旧称激活码）：最近 200 个，未用的排前面
    control.activationCode.findMany({ orderBy: [{ usedAt: "asc" }, { createdAt: "desc" }], take: 200 }),
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

  const demoCodes = 演示.map((d) => ({
    code: 展示(d.code),
    note: d.note,
    boundAt: d.boundAt ? d.boundAt.toISOString() : null,
    left: Math.max(0, 演示对话上限 - d.calls),
  }));

  const codes = 码.map((c) => ({
    code: 展示(c.code),
    note: c.note,
    usedAt: c.usedAt ? c.usedAt.toISOString() : null,
    workspace: c.workspaceId ? (list.find((w) => w.id === c.workspaceId)?.name ?? c.workspaceId) : null,
  }));

  return <AdminView token={given} rows={list} codes={codes} demoCodes={demoCodes} master={master ? 展示(master) : null} />;
}
