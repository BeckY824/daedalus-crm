import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import CustomerRoster from "@/components/CustomerRoster";

/**
 * 中栏（312px）的内容。眼下**只有一种**：学员记录页的窄名单。
 *
 * 首页原来挂「今天」、商机和跟进各挂一张两行的子页目录——那三条都撤了（设计稿 03/LAYOUT：
 * 「中栏不是默认栏位；只有记录切换等明确场景才出现」）。首页的待办进了信号行，
 * 商机和跟进的两个子页进了各自页头的视图切换按钮：一个模块两个视图，
 * 不值得为它常驻一列 312px。
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
