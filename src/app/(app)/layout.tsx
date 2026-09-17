import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import { 本地模式, 读 as 读云端凭据 } from "@/lib/desktop/cloud";

export default async function AppLayout({
  children,
  pane,
}: {
  children: React.ReactNode;
  /** 中栏。并行路由槽位 @pane/[[...slug]]，它是 page，每次导航都重算——
      别搬回这个 layout 里：layout 在客户端导航时不重新渲染，学员中栏就是这么消失的 */
  pane: React.ReactNode;
}) {
  // JWT 有效但用户已被删除/停用时走这里：必须先清 Cookie 再回登录页，
  // 否则 proxy.ts 会把 /login 弹回 /dashboard 形成死循环。
  const user = await getCurrentUser();
  if (!user) redirect("/api/auth/logout");
  /**
   * 桌面端本地模式：身份是云端账号，业务会话只是它的影子。影子还在、本体没了
   * （令牌被吊销后壳清了文件，而 cookie 还有几天寿命）就不给进——否则人会带着
   * 一个失效的账号用上半天，只有 AI 在背后 401。
   */
  if (本地模式() && !读云端凭据()) redirect("/api/auth/logout?reason=revoked");

  // 铃铛计数：我名下未完成的待办。中栏要的数据在 @pane 槽位里各自查
  const [pendingCount, business, ua] = await Promise.all([
    prisma.task.count({ where: { ownerId: user.id, done: false } }),
    // 业务术语（学员/客户、院校/年级/专业…）：全站客户端组件从这里拿
    getBusiness(),
    headers().then((h) => h.get("user-agent") ?? ""),
  ]);
  /**
   * 跑在桌面端里：Electron 的 UA 带 "Electron/"。本地模式和连服务器两种都识别得到，
   * 壳据此把红黄绿钮的位置留出来。只影响布局，不影响任何权限。
   */
  const desktop = /Electron\//.test(ua);
  // 网页版不再有试用期：只有一个长期运行的共享工作区，横条整条去掉了（2026-09-16）。
  // 到期只读那套机制还在 computeWritable 里，共享工作区靠 paidUntil 设在很远来绕过它——
  // 机制留着是因为运营台还要用它停用工作区，不是因为网页版还在计时。

  return (
    <BusinessProvider value={business}>
      <AppShell user={user} pendingCount={pendingCount} desktop={desktop} pane={pane}>
        {children}
      </AppShell>
    </BusinessProvider>
  );
}
