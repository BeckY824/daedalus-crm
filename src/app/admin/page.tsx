import { notFound } from "next/navigation";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { computeWritable, daysLeft } from "@/lib/tenant/workspaces";
import AdminView from "./AdminView";
import { 展示 } from "@/lib/tenant/activation";

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

  const rows = await control.workspace.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { memberships: { include: { account: true } } },
  });

  const list = rows.map((w) => {
    const owner = w.memberships.find((m) => m.role === "OWNER")?.account;
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
      // 待核对的付款记在这里，运营台一眼看到谁交了钱
      note: w.note,
    };
  });

  // 激活码：最近 200 个，未用的排前面，运营一眼看到还剩几个能发
  const 码 = await control.activationCode.findMany({ orderBy: [{ usedAt: "asc" }, { createdAt: "desc" }], take: 200 });
  const codes = 码.map((c) => ({
    code: 展示(c.code),
    note: c.note,
    usedAt: c.usedAt ? c.usedAt.toISOString() : null,
    workspace: c.workspaceId ? (list.find((w) => w.id === c.workspaceId)?.name ?? c.workspaceId) : null,
  }));

  return <AdminView token={given} rows={list} codes={codes} />;
}
