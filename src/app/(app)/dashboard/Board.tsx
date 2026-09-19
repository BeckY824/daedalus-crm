import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { OPP_STAGES } from "@/lib/constants";
import { 负责人口径 } from "@/lib/owners";
import { dayjs } from "@/lib/utils";
import { llmEnabled } from "@/lib/llm";
import { loadWatchlist } from "@/lib/sentinel-data";
import DashboardView from "./DashboardView";

/**
 * 「现在」这个视图：指标卡、趋势、漏斗、排行、待办、盯盘。
 * 「数据」页和「没配 AI 时的首页」共用它。
 * 内嵌（`内嵌`）= 在「数据」页里，页头由外面那层给，这里不画；
 * 不内嵌 = 它就是没配 AI 的首页，页头写「首页」。
 */
export default async function Board({ 内嵌 = false }: { 内嵌?: boolean }) {
  await requireUser();

  const now = dayjs();
  const monthStart = now.startOf("month").toDate();
  const lastMonthStart = now.subtract(1, "month").startOf("month").toDate();

  const [
    leadTotal,
    activeCustomers,
    openOpps,
    stageGroups,
    owners,
    upcomingTasks,
    customersForTrend,
    wonCount,
    totalClosed,
    oppsForSeries,
    本月签约,
    上月签约,
    逾期跟进,
  ] = await Promise.all([
    // 这两个只用来判「空库」，不再进指标卡
    prisma.lead.count(),
    prisma.customer.count({ where: { followStatus: { notIn: ["已流失"] } } }),
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      // 只要金额：预测销售额那张卡撤了之后，概率在这一页不再用到
      select: { amount: true },
    }),
    // 管道只统计进行中的商机，已赢单/丢单不再占据漏斗
    prisma.opportunity.groupBy({
      by: ["stage"],
      where: { status: "OPEN" },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    /*
      排行榜也走同一条口径。多人工作区里仍然排除管理员（他不做销售，业绩不该上榜）；
      但**整个工作区只有他一个人**时，客户和商机全在他名下，用严格口径这张榜永远是空的——
      桌面端就是这个情形。见 lib/owners.ts 里 负责人口径 的说明。
    */
    prisma.user.findMany({
      where: await 负责人口径(),
      select: {
        id: true,
        name: true,
        email: true,
        opportunities: { where: { status: "WON" }, select: { amount: true } },
      },
    }),
    prisma.task.findMany({
      where: { done: false },
      orderBy: { dueAt: "asc" },
      take: 5,
      include: { customer: { select: { id: true, name: true } } },
    }),
    prisma.customer.findMany({ select: { createdAt: true, lastFollowAt: true } }),
    prisma.opportunity.count({ where: { status: "WON" } }),
    prisma.opportunity.count({ where: { status: { in: ["WON", "LOST"] } } }),
    // 卡片下方那三条小曲线原本是写死的装饰数据，改成按周真算
    prisma.opportunity.findMany({ select: { createdAt: true, updatedAt: true, amount: true, status: true } }),
    /*
      设计稿 08/DATA·NOW 的四张指标卡：本月签约、新增学员、进行中商机、逾期跟进。
      原来那四张是线索总数 / 活跃客户数 / 本月新增商机 / 预测销售额——都是「库里有多少」，
      没有一个回答「今天要关心什么」。这四个都是**能落地**的：
      每一个都点得进一个能把它重新数一遍的页面（页面规则「关键指标可跳到明细」）。
    */
    prisma.contract.aggregate({ _sum: { amount: true }, where: { signedAt: { gte: monthStart } } }),
    prisma.contract.aggregate({ _sum: { amount: true }, where: { signedAt: { gte: lastMonthStart, lt: monthStart } } }),
    // 逾期是全团队口径：这一页看的是整个盘子，不是「我的」
    prisma.followPlan.count({ where: { done: false, plannedAt: { lt: now.startOf("day").toDate() } } }),
  ]);

  const newCustomersThisMonth = customersForTrend.filter((c) =>
    dayjs(c.createdAt).isAfter(monthStart),
  ).length;
  const newCustomersLastMonth = customersForTrend.filter(
    (c) => dayjs(c.createdAt).isAfter(lastMonthStart) && dayjs(c.createdAt).isBefore(monthStart),
  ).length;

  // 近 90 天趋势：两条线都是「截至当天的累计值」
  /*
    两条线：**累计**客户数（不是当日新增）和活跃客户数。
    2026-09-19 之前图例把第一条写成「新增客户」，而它画的是累计——
    用户昨天加了一位，今天这条线还是 1，按「新增」的说法今天该是 0。
    数据没错，是名字在说谎；名字和口径都在 DashboardView 里改正了。
  */
  const days = Array.from({ length: 90 }, (_, i) => now.subtract(89 - i, "day"));
  const followDates = await prisma.followUp.findMany({
    select: { customerId: true, occurredAt: true },
    where: { occurredAt: { gte: now.subtract(120, "day").toDate() } },
  });

  const trendData = days.map((d) => {
    const total = customersForTrend.filter((c) => !dayjs(c.createdAt).isAfter(d, "day")).length;
    const activeIds = new Set(
      followDates
        .filter(
          (f) =>
            !dayjs(f.occurredAt).isAfter(d, "day") &&
            dayjs(f.occurredAt).isAfter(d.subtract(30, "day"), "day"),
        )
        .map((f) => f.customerId),
    );
    return { label: d.format("MM-DD"), created: total, active: activeIds.size };
  });

  /**
   * 漏斗。
   *
   * 前四档是「进行中商机」的快照，与时间窗无关——管道就是此刻手上有多少。
   * 末档「赢单成交」原本也只统计 status=OPEN，而阶段推到赢单时状态必然变成 WON，
   * 所以那一档结构性永远是 0，等于砍掉了漏斗最有用的读数（转化终点）。
   * 改为统计选定窗口内赢单的数量与金额。
   *
   * 赢单时间用 updatedAt 近似：模型里没有单独的「赢单时间」字段，
   * 而加字段要 ALTER TABLE，与现有的「只增不改」迁移约定冲突。
   * 商机一旦赢单通常不再改动，这个近似在实践中够用，口径已标在卡片上。
   */
  const 赢单窗口 = (起: Date) => {
    const 命中 = oppsForSeries.filter((o) => o.status === "WON" && o.updatedAt >= 起);
    return { count: 命中.length, amount: 命中.reduce((sum, o) => sum + o.amount, 0) };
  };
  const 本月赢单 = 赢单窗口(monthStart);
  // dayjs 默认没有 quarterOfYear 插件，直接按月份算季度起点，省一个依赖
  const 季首月 = Math.floor(now.month() / 3) * 3;
  const 本季赢单 = 赢单窗口(now.month(季首月).startOf("month").toDate());

  const 进行中各档 = OPP_STAGES.slice(0, -1).map((s) => {
    const g = stageGroups.find((x) => x.stage === s);
    return { stage: s, count: g?._count._all ?? 0, amount: g?._sum.amount ?? 0 };
  });
  const 末档 = OPP_STAGES[OPP_STAGES.length - 1];
  const funnel = {
    本月: [...进行中各档, { stage: 末档, ...本月赢单 }],
    本季: [...进行中各档, { stage: 末档, ...本季赢单 }],
  };

  const ranking = owners
    .map((o) => ({
      id: o.id,
      name: o.name,
      email: o.email,
      amount: o.opportunities.reduce((s, x) => s + x.amount, 0),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const oppTotalAmount = openOpps.reduce((s, o) => s + o.amount, 0);
  const winRate = totalClosed ? Math.round((wonCount / totalClosed) * 100) : 0;
  const 本月签约额 = 本月签约._sum.amount ?? 0;
  const 上月签约额 = 上月签约._sum.amount ?? 0;

  const watchlist = await loadWatchlist(now);

  /**
   * 卡片下方的三条小曲线。
   * 原本是写死的数组（[4,7,5,9,...] 之类），零数据时照样画出一条漂亮的上升线——
   * 数据首页上的假曲线比没有曲线更糟，人会照着它做判断。
   * 这里按最近 8 周真算；一条数据都没有时就返回全 0，曲线自然是平的。
   */
  const 周 = Array.from({ length: 8 }, (_, i) => ({
    起: now.subtract(7 - i, "week").startOf("week"),
    止: now.subtract(6 - i, "week").startOf("week"),
  }));

  const newCustomerSeries = 周.map(
    (w) => customersForTrend.filter((c) => dayjs(c.createdAt).isAfter(w.起) && dayjs(c.createdAt).isBefore(w.止)).length,
  );
  // 进行中商机的金额是「截至那一周末的存量」，不是当周新增
  const oppAmountSeries = 周.map((w) =>
    Math.round(
      oppsForSeries
        .filter((o) => o.status === "OPEN" && dayjs(o.createdAt).isBefore(w.止))
        .reduce((sum, o) => sum + o.amount, 0) / 1000,
    ),
  );
  // 赢单率同样取截至那一周末的累计口径，和卡片上的总赢单率一致
  const winRateSeries = 周.map((w) => {
    const 已关闭 = oppsForSeries.filter(
      (o) => (o.status === "WON" || o.status === "LOST") && dayjs(o.createdAt).isBefore(w.止),
    );
    const 赢 = 已关闭.filter((o) => o.status === "WON").length;
    return 已关闭.length ? Math.round((赢 / 已关闭.length) * 100) : 0;
  });

  return (
    <DashboardView
      内嵌={内嵌}
      /**
       * 空库时整页换成一张「从哪开始」——对着空库画四个 0、一条平的折线和全 0 的管道，
       * 既不好看也不给信息，第一次打开的人还以为是坏了。
       * 判据用线索 + 客户 + 商机三个总数，不看金额：录了人还没报价也算有数据。
       */
      空库={leadTotal === 0 && activeCustomers === 0 && oppsForSeries.length === 0}
      stats={{
        newCustomersThisMonth,
        newCustomersDelta: newCustomersLastMonth
          ? Number((((newCustomersThisMonth - newCustomersLastMonth) / newCustomersLastMonth) * 100).toFixed(1))
          : 0,
        oppTotalAmount,
        winRate,
        签约本月: 本月签约额,
        // 上月一分钱都没有时不给环比：分母是 0 的百分比没有意义，只会是个吓人的数
        签约环比: 上月签约额 ? Number((((本月签约额 - 上月签约额) / 上月签约额) * 100).toFixed(1)) : undefined,
        进行中商机: openOpps.length,
        逾期跟进,
        newCustomerSeries,
        oppAmountSeries,
        winRateSeries,
      }}
      trend={trendData}
      funnel={funnel}
      ranking={ranking}
      tasks={upcomingTasks.map((t) => ({
        id: t.id,
        title: t.title,
        customerId: t.customer.id,
        customerName: t.customer.name,
        dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      }))}
      watchlist={watchlist}
      aiEnabled={await llmEnabled()}
    />
  );
}
