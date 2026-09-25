import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/AppShell";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import { 本地模式, 归属对不上, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { multiTenant } from "@/lib/tenant/context";
import { llmEnabled, listModelOptions } from "@/lib/llm";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { 查额度 } from "@/lib/tenant/ai-allowance";

export default async function AppLayout({
  children,
  pane,
  modal,
}: {
  children: React.ReactNode;
  /** 中栏。并行路由槽位 @pane/[[...slug]]，它是 page，每次导航都重算——
      别搬回这个 layout 里：layout 在客户端导航时不重新渲染，学员中栏就是这么消失的 */
  pane: React.ReactNode;
  /** 浮层。并行路由槽位 @modal，目前只有设置（拦截 /settings）。没命中时是 default.tsx 的 null */
  modal: React.ReactNode;
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
  /**
   * 换了账号登录，但数据目录还是上一个账号那份（壳还没换完、或者压根没接到那一声）。
   * **这时进来看到的会是上一个账号的客户**——2026-09-20 报的就是这个。
   * 宁可把人挡在门口：壳换完目录、本地服务重起之后，这里自然就放行了。
   */
  if (归属对不上()) redirect("/api/auth/logout?reason=switched");

  // 铃铛计数：我名下未完成的待办。中栏要的数据在 @pane 槽位里各自查
  const [pendingCount, business, ua, 有AI, models] = await Promise.all([
    prisma.task.count({ where: { ownerId: user.id, done: false } }),
    // 业务术语（学员/客户、院校/年级/专业…）：全站客户端组件从这里拿
    getBusiness(),
    headers().then((h) => h.get("user-agent") ?? ""),
    /*
      全局 AI 面板（AiDock）要的两样。放在 layout 里取：它哪一页都在，
      而 layout 在客户端导航时不重新渲染——模型清单和额度都不需要每次换页重取，
      额度变了下次整页加载会对上。真正每次导航要重算的东西在 @pane 槽位里，别搬进来。
    */
    llmEnabled(),
    listModelOptions(),
  ]);
  let aiQuota: { 上限: number; 还剩: number } | null = null;
  if (有AI && multiTenant()) {
    const t = await resolveCurrentTenant();
    if (t) {
      const q = await 查额度(t.workspaceId);
      if (q.受限) aiQuota = { 上限: q.上限, 还剩: q.还剩 };
    }
  }
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
      {/* 反馈：托管版和桌面端有我们这个云可发，自部署的开源版没有，按钮改去 GitHub issues */}
      <AppShell
        user={user}
        pendingCount={pendingCount}
        desktop={desktop}
        反馈去向={本地模式() || multiTenant() ? "cloud" : "github"}
        pane={pane}
        ai={有AI ? { models, aiQuota } : null}
      >
        {children}
      </AppShell>
      {modal}
    </BusinessProvider>
  );
}
