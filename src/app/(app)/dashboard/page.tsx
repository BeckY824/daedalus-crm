import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { OPP_STAGES, 可担任负责人 } from "@/lib/constants";
import { dayjs } from "@/lib/utils";
import { llmEnabled } from "@/lib/llm";
import { buildWatchlist } from "@/lib/sentinel";
import { getBusiness } from "@/lib/business";
import DashboardView from "./DashboardView";
import { statusLabel } from "@/lib/business-config";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireUser();

  const now = dayjs();
  const monthStart = now.startOf("month").toDate();
  const lastMonthStart = now.subtract(1, "month").startOf("month").toDate();

  const [
    leadTotal,
    leadLastMonth,
    activeCustomers,
    activeLastMonth,
    oppThisMonth,
    oppLastMonth,
    openOpps,
    stageGroups,
    owners,
    upcomingTasks,
    customersForTrend,
    wonCount,
    totalClosed,
    oppsForSeries,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { lt: monthStart } } }),
    prisma.customer.count({ where: { followStatus: { notIn: ["已流失"] } } }),
    prisma.customer.count({ where: { createdAt: { lt: monthStart }, followStatus: { notIn: ["已流失"] } } }),
    prisma.opportunity.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.opportunity.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      select: { amount: true, probability: true },
    }),
    // 管道只统计进行中的商机，已赢单/丢单不再占据漏斗
    prisma.opportunity.groupBy({
      by: ["stage"],
      where: { status: "OPEN" },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.user.findMany({
      where: 可担任负责人,
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
  ]);

  // 预测销售额 = Σ(金额 × 概率)
  const forecast = openOpps.reduce((s, o) => s + o.amount * (o.probability / 100), 0);
  const newCustomersThisMonth = customersForTrend.filter((c) =>
    dayjs(c.createdAt).isAfter(monthStart),
  ).length;
  const newCustomersLastMonth = customersForTrend.filter(
    (c) => dayjs(c.createdAt).isAfter(lastMonthStart) && dayjs(c.createdAt).isBefore(monthStart),
  ).length;

  // 近 90 天趋势：两条线都是「截至当天的累计值」
  // 新增客户 = 累计客户数；活跃客户 = 其中当天之前 30 天内有过跟进的客户数
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

  // 盯盘提醒：纯规则实时计算（见 src/lib/sentinel.ts），不依赖定时任务
  const [overduePlans, sentinelCustomers, sentinelOpps] = await Promise.all([
    prisma.followPlan.findMany({
      where: { done: false, plannedAt: { lt: now.toDate() } },
      select: {
        subject: true,
        plannedAt: true,
        customer: { select: { id: true, name: true } },
        owner: { select: { name: true } },
      },
    }),
    prisma.customer.findMany({
      where: { followStatus: { notIn: ["已签约", "已流失", "暂缓跟进"] } },
      select: {
        id: true,
        name: true,
        followStatus: true,
        lastFollowAt: true,
        createdAt: true,
        salesOwner: { select: { name: true } },
      },
    }),
    prisma.opportunity.findMany({
      where: { status: "OPEN" },
      select: {
        name: true,
        stage: true,
        updatedAt: true,
        customer: { select: { id: true, name: true } },
        owner: { select: { name: true } },
      },
    }),
  ]);
  const business = await getBusiness();
  const watchlist = buildWatchlist(
    {
      overduePlans: overduePlans.map((p) => ({
        customerId: p.customer.id,
        customerName: p.customer.name,
        ownerName: p.owner.name,
        subject: p.subject,
        plannedAt: p.plannedAt,
      })),
      customers: sentinelCustomers.map((c) => ({
        id: c.id,
        name: c.name,
        followStatus: c.followStatus,
        lastFollowAt: c.lastFollowAt,
        createdAt: c.createdAt,
        ownerName: c.salesOwner.name,
      })),
      opportunities: sentinelOpps.map((o) => ({
        customerId: o.customer.id,
        customerName: o.customer.name,
        ownerName: o.owner.name,
        name: o.name,
        stage: o.stage,
        updatedAt: o.updatedAt,
      })),
    },
    now.toDate(),
    business.customer,
    (v) => statusLabel(business, v),
  );

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
      stats={{
        leadTotal,
        leadDelta: leadLastMonth ? Number((((leadTotal - leadLastMonth) / leadLastMonth) * 100).toFixed(1)) : 0,
        activeCustomers,
        activeDelta: activeLastMonth ? Number((((activeCustomers - activeLastMonth) / activeLastMonth) * 100).toFixed(1)) : 0,
        oppThisMonth,
        oppDelta: oppLastMonth ? Number((((oppThisMonth - oppLastMonth) / oppLastMonth) * 100).toFixed(1)) : 0,
        forecast,
        newCustomersThisMonth,
        newCustomersDelta: newCustomersLastMonth
          ? Number((((newCustomersThisMonth - newCustomersLastMonth) / newCustomersLastMonth) * 100).toFixed(1))
          : 0,
        oppTotalAmount,
        winRate,
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
