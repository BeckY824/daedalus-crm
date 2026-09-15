import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { dayjs } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import TrialBar from "@/components/TrialBar";
import DemoBar from "@/components/DemoBar";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { daysLeft as 剩余天数 } from "@/lib/tenant/workspaces";
import { 是演示工作区 } from "@/lib/demo/config";
import { 查额度 } from "@/lib/tenant/ai-allowance";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // JWT 有效但用户已被删除/停用时走这里：必须先清 Cookie 再回登录页，
  // 否则 proxy.ts 会把 /login 弹回 /dashboard 形成死循环。
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/logout");

  const 今天结束 = dayjs().endOf("day").toDate();
  // 铃铛计数：我名下未完成的待办；中栏「今天」：我的跟进计划（含逾期）和待办
  const [pendingCount, business, plans, tasks, ua] = await Promise.all([
    prisma.task.count({ where: { ownerId: user.id, done: false } }),
    // 业务术语（学员/客户、院校/年级/专业…）：全站客户端组件从这里拿
    getBusiness(),
    prisma.followPlan.findMany({
      where: { ownerId: user.id, done: false, plannedAt: { lte: 今天结束 } },
      orderBy: { plannedAt: "asc" },
      take: 30,
      select: { id: true, subject: true, plannedAt: true, method: true, customer: { select: { id: true, name: true } } },
    }),
    prisma.task.findMany({
      where: { ownerId: user.id, done: false },
      orderBy: [{ dueAt: "asc" }],
      take: 30,
      select: { id: true, title: true, dueAt: true, customer: { select: { id: true, name: true } } },
    }),
    headers().then((h) => h.get("user-agent") ?? ""),
  ]);
  const pathname = (await headers()).get("x-pathname") ?? "";
  /**
   * 学员模块的中栏：最近跟进过的 50 位。只在这个模块下查——中栏是按路由出现的，
   * 别的页面不该为它多跑一次库。路径来自 proxy 塞的 x-pathname。
   */
  let customers: { total: number; rows: { id: string; name: string; followStatus: string; lastFollowAt: string | null; ownerName: string; lastNote: string | null }[] } | null = null;
  if (pathname === "/customers" || pathname.startsWith("/customers/")) {
    const [total, rows] = await Promise.all([
      prisma.customer.count(),
      prisma.customer.findMany({
        orderBy: [{ lastFollowAt: "desc" }, { createdAt: "desc" }],
        take: 50,
        select: {
          id: true, name: true, followStatus: true, lastFollowAt: true,
          salesOwner: { select: { name: true } },
          followUps: { orderBy: { occurredAt: "desc" }, take: 1, select: { content: true } },
        },
      }),
    ]);
    customers = {
      total,
      rows: rows.map((c) => ({
        id: c.id, name: c.name, followStatus: c.followStatus,
        lastFollowAt: c.lastFollowAt ? c.lastFollowAt.toISOString() : null,
        ownerName: c.salesOwner.name,
        lastNote: c.followUps[0]?.content?.trim().slice(0, 60) || null,
      })),
    };
  }
  /**
   * 跑在桌面端里：Electron 的 UA 带 "Electron/"。本地模式和连服务器两种都识别得到，
   * 壳据此把红黄绿钮的位置留出来。只影响布局，不影响任何权限。
   */
  const desktop = /Electron\//.test(ua);
  const today = {
    plans: plans.map((p) => ({ id: p.id, subject: p.subject, plannedAt: p.plannedAt.toISOString(), method: p.method, customerId: p.customer.id, customerName: p.customer.name })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt ? t.dueAt.toISOString() : null, customerId: t.customer.id, customerName: t.customer.name })),
  };

  // 托管版：试用 / 订阅状态。getCurrentUser 已经把工作区放进上下文了
  let trial: { daysLeft: number; writable: boolean; aiLeft: number | null } | null = null;
  let demo = false;
  if (multiTenant()) {
    const t = await resolveCurrentTenant();
    if (t) {
      const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
      // 演示区不显示试用横条：它永不过期，显示「还剩 3650 天」只会让人困惑
      if (是演示工作区(ws?.slug)) demo = true;
      else if (ws) {
        // 试用期的 AI 免费次数是独立的一条线：可能还剩 25 天，但 5 次已经用完
        const 额度 = await 查额度(t.workspaceId);
        trial = { daysLeft: 剩余天数(ws), writable: t.writable, aiLeft: 额度.受限 ? 额度.还剩 : null };
      }
    }
  }

  return (
    <BusinessProvider value={business}>
      <AppShell user={user} pendingCount={pendingCount} desktop={desktop} today={today} customers={customers}>
        {demo && <DemoBar />}
        {trial && <TrialBar daysLeft={trial.daysLeft} writable={trial.writable} aiLeft={trial.aiLeft} />}
        {children}
      </AppShell>
    </BusinessProvider>
  );
}
