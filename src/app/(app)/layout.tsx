import { redirect } from "next/navigation";
import { 订单节点 } from "@/lib/features";
import { 读收藏 } from "@/lib/favorites";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import AppShell from "@/components/AppShell";
import { 算提醒 } from "@/lib/reminders";
import { 取提醒项, 取订单提醒项 } from "@/lib/reminders-db";
import { getBusiness } from "@/lib/business";
import { BusinessProvider } from "@/lib/business-client";
import { 本地模式, 归属对不上, 读 as 读云端凭据 } from "@/lib/desktop/cloud";
import { multiTenant } from "@/lib/tenant/context";
import { llmEnabled, listModelOptions } from "@/lib/llm";
import { 读AI计次, 不计次 } from "@/lib/ai-meter";
import { AiMeterProvider } from "@/components/AiCost";
import { 记下分机留存起 } from "@/lib/phone-dedupe";

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
  // 升级后第一次进来：记下「号码从这一刻起留着分机」，查重据此只拿主号认这之前的老记录（lib/phone-dedupe）。只写一次
  await 记下分机留存起();

  /*
    要跟的数：我名下逾期 + 今天到期、还没做的计划和待办。左栏「跟进」上的红数字、手机顶栏的铃铛、
    桌面端 Dock 上的数都是这一个（lib/reminders-db.ts）。layout 在客户端导航时不重算，
    但完成、改期、新建之后各处都会 router.refresh()——那时它跟着变。中栏要的数据在 @pane 槽位里各自查
  */
  const [提醒项, 订单提醒项, business, ua, 有AI, models, 收藏, 客户数, 在谈商机数] = await Promise.all([
    取提醒项(user.id),
    // 订单节点这一版不上（lib/features.ts）：不取，左栏和 Dock 上也就没有订单的数
    订单节点 ? 取订单提醒项(user.id) : Promise.resolve([]),
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
    // 左栏下半截（2026-10-02 照毛玻璃原型）：收藏的客户、客户和在谈商机的数。都很便宜，和上面一起查
    读收藏(user.id),
    prisma.customer.count(),
    prisma.opportunity.count({ where: { status: "OPEN" } }),
  ]);
  /*
    这个人点 AI 按钮花不花次数、还剩几次（lib/ai-meter.ts）：全站的「1 次」角标和输入框下那行字都认它。
    这里**不去云端问余额**（桌面端要联网，断网时会把整页拖住），数由浏览器随后问 /api/ai/meter。
  */
  const AI计次 = 有AI ? await 读AI计次({ 问余额: false }) : 不计次;
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
      <AiMeterProvider 初值={AI计次}>
      <AppShell
        user={user}
        要跟={(({ 逾期, 今天 }) => ({ 逾期, 今天 }))(算提醒(提醒项))}
        订单要看={(({ 超期, 今天 }) => ({ 超期, 今天 }))(算提醒([], new Date(), 订单提醒项).订单)}
        desktop={desktop}
        反馈去向={本地模式() || multiTenant() ? "cloud" : "github"}
        pane={pane}
        ai={有AI ? { models } : null}
        收藏={收藏}
        计数={{ "/customers": 客户数, "/opportunities": 在谈商机数 }}
      >
        {children}
      </AppShell>
      {modal}
      </AiMeterProvider>
    </BusinessProvider>
  );
}
