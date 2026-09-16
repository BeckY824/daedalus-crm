import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { dayjs } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import { multiTenant } from "@/lib/tenant/context";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { daysLeft as 剩余天数 } from "@/lib/tenant/workspaces";
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
  /**
   * 管理员那几项给不给看。共享工作区里那个人的角色也是 ADMIN（他得能展示管理员看到的东西），
   * 但那套账号密码在多个团队手里——「管理员」在那里等于「拿到过密码的任何人」。
   * 设置页的页签（settings/page.tsx）用的是同一个判断，这里算一次传给壳，
   * 别让中栏和页签各判各的：2026-09-16 就是因为中栏只判角色，把「AI 接入」漏了出去。
   */
  const isAdmin = user.role === "ADMIN" && !(await 当前是共享区());
  const today = {
    plans: plans.map((p) => ({ id: p.id, subject: p.subject, plannedAt: p.plannedAt.toISOString(), method: p.method, customerId: p.customer.id, customerName: p.customer.name })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt ? t.dueAt.toISOString() : null, customerId: t.customer.id, customerName: t.customer.name })),
  };

  // 网页版不再有试用期：只有一个长期运行的共享工作区，横条整条去掉了（2026-09-16）。
  // 到期只读那套机制还在 computeWritable 里，共享工作区靠 paidUntil 设在很远来绕过它——
  // 机制留着是因为运营台还要用它停用工作区，不是因为网页版还在计时。

  return (
    <BusinessProvider value={business}>
      <AppShell user={user} pendingCount={pendingCount} desktop={desktop} isAdmin={isAdmin} today={today} customers={customers}>
        {children}
      </AppShell>
    </BusinessProvider>
  );
}
