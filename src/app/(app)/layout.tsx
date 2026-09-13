import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import TrialBar from "@/components/TrialBar";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { daysLeft as 剩余天数 } from "@/lib/tenant/workspaces";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // JWT 有效但用户已被删除/停用时走这里：必须先清 Cookie 再回登录页，
  // 否则 proxy.ts 会把 /login 弹回 /dashboard 形成死循环。
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/logout");

  // 顶栏铃铛：我名下未完成的待办
  const [pendingCount, business] = await Promise.all([
    prisma.task.count({ where: { ownerId: user.id, done: false } }),
    // 业务术语（学员/客户、院校/年级/专业…）：全站客户端组件从这里拿
    getBusiness(),
  ]);

  // 托管版：试用 / 订阅状态。getCurrentUser 已经把工作区放进上下文了
  let trial: { daysLeft: number; writable: boolean } | null = null;
  if (multiTenant()) {
    const t = await resolveCurrentTenant();
    if (t) {
      const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
      if (ws) trial = { daysLeft: 剩余天数(ws), writable: t.writable };
    }
  }

  return (
    <BusinessProvider value={business}>
      <AppShell user={user} pendingCount={pendingCount}>
        {trial && <TrialBar daysLeft={trial.daysLeft} writable={trial.writable} />}
        {children}
      </AppShell>
    </BusinessProvider>
  );
}
