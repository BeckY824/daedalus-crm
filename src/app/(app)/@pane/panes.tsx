import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { dayjs } from "@/lib/utils";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import TodayPane from "@/components/TodayPane";
import SectionPane from "@/components/SectionPane";
import CustomerRoster from "@/components/CustomerRoster";

/**
 * 中栏（三栏里中间那 312px）的几种内容。槽位页各自 import 要用的那个。
 *
 * **为什么中栏是并行路由而不是在 layout 里算。** 原来 (app)/layout.tsx 读 proxy 塞的
 * `x-pathname` 决定中栏画什么、并顺手查数据。但 App Router 的 layout **在客户端导航时
 * 不重新渲染**——从首页点「学员管理」，layout 还是首页那次的结果，customers 一直是 null，
 * 中栏就不出现；⌘R 硬刷新才对。商机 / 跟进 / 设置的中栏是静态列表，不依赖那次查询，
 * 所以只有学员页露馅，表现成「一会儿三栏一会儿两栏」。槽位里的是 **page**，每次导航都重算。
 *
 * **为什么是一条路由一个槽位页，而不是一个 [...slug] 接住全部。** 试过 catch-all，省 7 个
 * 文件，但它会把 `/[...slug]` 注册成一条真实路由——于是 `/demo`、打错的地址全都不再 404，
 * 而是渲染出应用外壳。2026-09-16 被 hosted 那条「/demo 的路由该删干净了」抓到。
 * 不值得为省几个文件换掉 404。
 *
 * `<aside class="pane">` 由槽位渲染而不是由壳渲染：没有中栏的页面要一个节点都不出，
 * 否则壳那边拿到的永远是个「渲染结果为 null 的元素」，会留一列 312px 的空白。
 */

function 包一层(children: React.ReactNode) {
  return <aside className="pane">{children}</aside>;
}

/** 首页中栏：我今天要跟的人和到期的待办 */
export async function 今天中栏() {
  const user = await requireUser();
  const 今天结束 = dayjs().endOf("day").toDate();
  const [plans, tasks] = await Promise.all([
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
  ]);
  return 包一层(
    <TodayPane
      today={{
        plans: plans.map((p) => ({ id: p.id, subject: p.subject, plannedAt: p.plannedAt.toISOString(), method: p.method, customerId: p.customer.id, customerName: p.customer.name })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt ? t.dueAt.toISOString() : null, customerId: t.customer.id, customerName: t.customer.name })),
      }}
    />,
  );
}

/**
 * 记录页的窄名单：最近跟进过的 50 位。
 *
 * **只在 `/customers/[id]` 出现，列表页没有**（批 2）。列表页已经是一张全宽的表，
 * 旁边再挂一条同样内容的名单等于把同一件事画两遍；而记录页缺的正是「换一个人」
 * 这条路——原来从林夏切到陈航要退回列表再进去。
 *
 * 它自己渲染 <aside>，不走 包一层：窄屏下整条要变成抽屉，那时不能留一个空的 aside。
 */
export async function 学员名单() {
  await requireUser();
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
  return (
    <CustomerRoster
      data={{
        total,
        rows: rows.map((c) => ({
          id: c.id, name: c.name, followStatus: c.followStatus,
          lastFollowAt: c.lastFollowAt ? c.lastFollowAt.toISOString() : null,
          ownerName: c.salesOwner.name,
          lastNote: c.followUps[0]?.content?.trim().slice(0, 60) || null,
        })),
      }}
    />
  );
}

export function 商机中栏() {
  return 包一层(
    <SectionPane
      title="商机"
      items={[
        { href: "/opportunities", label: "商机列表", hint: "按阶段、金额、负责人筛" },
        { href: "/opportunities/pipeline", label: "商机管道", hint: "按阶段拖着看" },
      ]}
    />,
  );
}

export function 跟进中栏() {
  return 包一层(
    <SectionPane
      title="跟进"
      items={[
        { href: "/follow-ups", label: "跟进记录", hint: "已经发生的沟通" },
        { href: "/follow-ups/plans", label: "跟进计划", hint: "排好还没做的" },
      ]}
    />,
  );
}

/**
 * 设置中栏。管理员那两项的门：**和设置页页签用的是同一个判断**——
 * 「管理员 且 不在共享区」。共享区那个人的角色也是 ADMIN，但密码在多个团队手里。
 * 同一道门判两遍迟早漏一边，2026-09-16 就是这么把「AI 接入」漏出去的。
 */
export async function 设置中栏() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN" && !(await 当前是共享区());
  return 包一层(
    <SectionPane
      title="设置"
      items={[
        { href: "/settings?tab=members", label: "团队成员", hint: "谁能进、谁是管理员" },
        { href: "/settings?tab=password", label: "修改密码", hint: "改自己的登录密码" },
        ...(isAdmin
          ? [
              { href: "/settings?tab=ai", label: "AI 接入", hint: "走哪把 Key、还剩几次" },
              { href: "/settings?tab=business", label: "业务配置", hint: "学员 / 客户这些叫法" },
            ]
          : []),
        { href: "/settings?tab=audit", label: "操作日志", hint: "每一次改动的记录" },
      ]}
    />,
  );
}

/**
 * 没有中栏的页面**也要有自己的槽位页**，不能只靠 default.tsx。
 *
 * Next 并行路由：客户端软导航时，匹配不到的槽位会**保留上一页的内容**，
 * default.tsx 只在硬加载（首次进入 / 刷新）时兜底。所以从学员点到线索，
 * 中栏会赖着不走——2026-09-16 被 shell-pane 那三条抓到。
 * 一条路由一个槽位页，槽位就永远匹配得上，也就不会留着上一页的。
 */
export function 无中栏() {
  return null;
}
