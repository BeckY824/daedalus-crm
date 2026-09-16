import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { dayjs } from "@/lib/utils";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import TodayPane from "@/components/TodayPane";
import SectionPane from "@/components/SectionPane";
import CustomerPane from "@/components/CustomerPane";

export const dynamic = "force-dynamic";

/**
 * 中栏（三栏里中间那 312px）。
 *
 * **为什么是并行路由而不是 layout 里算。** 原来 (app)/layout.tsx 读 proxy 塞的 `x-pathname`
 * 决定中栏画什么、并顺手查数据。但 App Router 的 layout **在客户端导航时不重新渲染**——
 * 从首页点「学员管理」，layout 还是首页那次的结果，customers 一直是 null，中栏就不出现；
 * ⌘R 硬刷新才对。商机 / 跟进 / 设置的中栏是静态列表，不依赖那次查询，所以只有学员页露馅。
 *
 * 槽位里的是 **page**，每次导航都重新渲染，所以这类问题整类消失，`x-pathname` 那个 hack 也拿掉了。
 * 一个 [...slug] 接住 (app) 下所有路径，按第一段决定画谁——比给每条路由建一个同名槽位文件省得多。
 * 用必选 catch-all 而不是 [[...slug]]：可选的那个也匹配「零段」，和根路由 `/` 同优先级，
 * Next 会直接拒绝构建（"same specificity as an optional catch-all route"）。`/` 归 default.tsx。
 *
 * `<aside class="pane">` 由这里渲染而不是由壳渲染：没有中栏的页面要一个节点都不出，
 * 否则壳那边拿到的永远是个「渲染结果为 null 的元素」，会留一列 312px 的空白。
 */
export default async function Pane({ params }: { params: Promise<{ slug: string[] }> }) {
  const 段 = (await params).slug[0];

  if (段 === "dashboard") return <aside className="pane">{await 今天()}</aside>;
  if (段 === "customers") return <aside className="pane">{await 学员()}</aside>;
  if (段 === "opportunities")
    return (
      <aside className="pane">
        <SectionPane
          title="商机"
          items={[
            { href: "/opportunities", label: "商机列表", hint: "按阶段、金额、负责人筛" },
            { href: "/opportunities/pipeline", label: "商机管道", hint: "按阶段拖着看" },
          ]}
        />
      </aside>
    );
  if (段 === "follow-ups")
    return (
      <aside className="pane">
        <SectionPane
          title="跟进"
          items={[
            { href: "/follow-ups", label: "跟进记录", hint: "已经发生的沟通" },
            { href: "/follow-ups/plans", label: "跟进计划", hint: "排好还没做的" },
          ]}
        />
      </aside>
    );
  if (段 === "settings") return <aside className="pane">{await 设置()}</aside>;
  return null;
}

/** 首页中栏：我今天要跟的人和到期的待办 */
async function 今天() {
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
  return (
    <TodayPane
      today={{
        plans: plans.map((p) => ({ id: p.id, subject: p.subject, plannedAt: p.plannedAt.toISOString(), method: p.method, customerId: p.customer.id, customerName: p.customer.name })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt ? t.dueAt.toISOString() : null, customerId: t.customer.id, customerName: t.customer.name })),
      }}
    />
  );
}

/** 学员模块中栏：最近跟进过的 50 位 */
async function 学员() {
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
    <CustomerPane
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

/**
 * 设置中栏。管理员那两项的门：**和设置页页签用的是同一个判断**——
 * 「管理员 且 不在共享区」。共享区那个人的角色也是 ADMIN，但密码在多个团队手里。
 * 同一道门判两遍迟早漏一边，2026-09-16 就是这么把「AI 接入」漏出去的。
 */
async function 设置() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN" && !(await 当前是共享区());
  return (
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
    />
  );
}
