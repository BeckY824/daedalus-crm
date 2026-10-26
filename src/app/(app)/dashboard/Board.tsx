import { prisma, defaultClient } from "@/lib/prisma";
import { 限定的我, 读的我 } from "@/lib/team-scope";
import { requireUser } from "@/lib/auth";
import { OPP_STAGES } from "@/lib/constants";
import { 负责人口径 } from "@/lib/owners";
import { dayjs } from "@/lib/utils";
import { llmEnabled } from "@/lib/llm";
import { loadWatchlistPage } from "@/lib/sentinel-data";
import DashboardView from "./DashboardView";
import { 数逾期跟进 } from "@/lib/overdue";
import { 带币种, 商机币种, 签约合计 } from "@/lib/money-db";
import { 按币种合计, 取币种, 同币环比 } from "@/lib/currency";
import { getBusiness } from "@/lib/business";
import { 最近8周, 每周进行中金额, 每周赢单率 } from "@/lib/dashboard-trend";
import { 客户数, 全部商机 } from "@/lib/dashboard-sql";
import { 首页待办 } from "@/lib/dashboard-todo";
import type { 满额提醒 } from "@/lib/enterprise/lead-full-notice";

/**
 * 「现在」这个视图：指标卡、趋势、漏斗、排行、待办、盯盘。
 * 「数据」页和「没配 AI 时的首页」共用它。
 * 内嵌（`内嵌`）= 在「数据」页里，页头由外面那层给，这里不画；
 * 不内嵌 = 它就是没配 AI 的首页，页头写「首页」。
 */
export default async function Board({ 内嵌 = false, 满额提醒 }: { 内嵌?: boolean; /** 没配 AI 的首页才给：企业版自动分配都满额的提醒 */ 满额提醒?: 满额提醒[] }) {
  await requireUser();

  const now = dayjs();
  const monthStart = now.startOf("month").toDate();
  const lastMonthStart = now.subtract(1, "month").startOf("month").toDate();
  /** 下月 1 号零点。「本月」要两头都截：签约日期能选到未来，只有下界会把下个月登记的单算进本月（排查 C3） */
  const nextMonthStart = now.add(1, "month").startOf("month").toDate();
  // 老板、个人版、企业版没开按组织看 = 不限定：客户数和全部商机在库里直接数 / 连表取，近期待办走短时缓存。三处共用一次判断
  let 判过: Promise<boolean> | undefined;
  const 不限定 = () => (判过 ??= 限定的我(defaultClient).then((我) => !我));
  // 数客户时读的那组人：和 lib/team-scope 里客户、跟进的读范围同一个（不限定 / 开了互看 = null，虚线上级连带下属）
  const 读范围 = async () => ((await 不限定()) ? null : 读的我(defaultClient));

  const [
    leadTotal,
    customerTotal,
    owners,
    待办,
    数客户,
    wonCount,
    totalClosed,
    oppsForSeries,
    本月签约,
    上月签约,
    逾期跟进,
    watchlist,
    business,
    aiEnabled,
  ] = await Promise.all([
    // 这两个只用来判「空库」，不再进指标卡
    prisma.lead.count(),
    prisma.customer.count(),
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
        opportunities: { where: { status: "WON" }, select: { amount: true, ...带币种.商机 } },
      },
    }),
    /*
      「近期跟进任务」原来只读 Task。可落地页 `/follow-ups/plans` 是把
      **Task 和 FollowPlan 两张表合在一起**按逾期/今天/本周分组的（见 PlansView），
      于是只用「跟进计划」的人——新建客户时排的那种——首页这张卡永远是空的，
      点进去却满满一屏。两边必须同一个口径。
      日期语义可能与旧瞬间索引不同序：在服务端按原日历日合并排序，只交给浏览器前5条。
      没排时间的（Task.dueAt 可空）排在最后：它不是「近期」，只是还没排期。
      先只取时间排出前 5，再取这 5 条的标题和客户，见 lib/dashboard-todo.ts
    */
    (async () => 首页待办(prisma, await 不限定()))(),
    /*
      近 90 天两条线、本月 / 上月新增、每周新增：在库里按天数好再取回来；业务员在 SQL 里带上看得到的那组人
      （2026-10-26，原来取限定后的行算，企业版开着按组织看要三百多毫秒）。口径和对拍见 lib/dashboard-sql.ts
    */
    (async () => 客户数(prisma, now, await 读范围()))(),
    prisma.opportunity.count({ where: { status: "WON" } }),
    prisma.opportunity.count({ where: { status: { in: ["WON", "LOST"] } } }),
    // 卡片下方那三条小曲线原本是写死的装饰数据，改成按周真算。
    // 进行中的商机（漏斗各档、进行中总额）也从这一份里挑：原来单独再取一遍 status=OPEN，两遍都是整表扫
    // 不限定时一句 LEFT JOIN 取（企业版 1 万商机 66 → 18 毫秒），业务员照旧 Prisma 取限定后的行，见 lib/dashboard-sql.ts
    (async () => 全部商机(prisma, await 不限定()))(),
    /*
      设计稿 08/DATA·NOW 的四张指标卡：本月签约、新增学员、进行中商机、逾期跟进。
      原来那四张是线索总数 / 活跃客户数 / 本月新增商机 / 预测销售额——都是「库里有多少」，
      没有一个回答「今天要关心什么」。这四个都是**能落地**的：
      每一个都点得进一个能把它重新数一遍的页面（页面规则「关键指标可跳到明细」）。
    */
    // 按币种分开合计（不换汇），所以取行而不是 aggregate：币种在 ContractMoney 上
    prisma.contract.findMany({ select: { amount: true, ...带币种.签约 }, where: { signedAt: { gte: monthStart, lt: nextMonthStart, lte: now.toDate() } } }),
    prisma.contract.findMany({ select: { amount: true, ...带币种.签约 }, where: { signedAt: { gte: lastMonthStart, lt: monthStart } } }),
    /*
      逾期是全团队口径：这一页看的是整个盘子，不是「我的」。
      **两张表都要数**：原来只数 FollowPlan，而 `/follow-ups/plans` 的「逾期」一组里
      躺着 Task 和 FollowPlan 两种。有 5 条逾期任务、0 条逾期计划的人，
      首页写「0 · 都跟上了」，点进去一片红——卡片和它自己的落地页对不上。
    */
    // 口径只在 lib/overdue.ts 写一次：首页、计划页、这张卡三处共用
    数逾期跟进(prisma),
    // 盯盘只看「现在」，不依赖上面任何一个，一起取
    loadWatchlistPage(now),
    getBusiness(),
    llmEnabled(),
  ]);

  // 进行中商机：只要金额、阶段和币种。预测销售额那张卡撤了之后，概率在这一页不再用到。
  // 漏斗各档也拿它分（原来单独 groupBy 求和，币种在旁表上，groupBy 分不了币种）
  const openOpps = oppsForSeries.filter((o) => o.status === "OPEN");

  // 含月初零点那一刻（>=），和客户列表「本月新增」的筛选一个口径（排查 C3）
  const newCustomersThisMonth = 数客户.本月新增;
  const newCustomersLastMonth = 数客户.上月新增;

  // 近 90 天趋势：两条线都是「截至当天的累计值」
  /*
    两条线：**累计**客户数（不是当日新增）和活跃客户数。
    2026-09-19 之前图例把第一条写成「新增客户」，而它画的是累计——
    用户昨天加了一位，今天这条线还是 1，按「新增」的说法今天该是 0。
    数据没错，是名字在说谎；名字和口径都在 DashboardView 里改正了。
  */
  const trendData = 数客户.trend;

  /**
   * 漏斗。
   *
   * 前四档是「进行中商机」的快照，与时间窗无关——管道就是此刻手上有多少。
   * 末档「赢单成交」原本也只统计 status=OPEN，而阶段推到赢单时状态必然变成 WON，
   * 所以那一档结构性永远是 0，等于砍掉了漏斗最有用的读数（转化终点）。
   * 改为统计选定窗口内赢单的数量与金额。
   *
   * 赢单时间按 OpportunityClose.closedAt（2026-10-02 起记，排查 C6）。
   * 原来拿 updatedAt 近似：老的赢单改一下备注就被算进本月。之前赢的没有记录，仍退回 updatedAt。
   */
  const 赢单窗口 = (起: Date) => {
    // 按赢单那一刻算（OpportunityClose，排查 C6）；0.46.15 之前赢的没有记录，退回 updatedAt
    const 命中 = oppsForSeries.filter((o) => o.status === "WON" && (o.closed?.closedAt ?? o.updatedAt) >= 起);
    return { count: 命中.length, amount: 按币种合计(命中, (o) => o.amount, 商机币种) };
  };
  const 本月赢单 = 赢单窗口(monthStart);
  // dayjs 默认没有 quarterOfYear 插件，直接按月份算季度起点，省一个依赖
  const 季首月 = Math.floor(now.month() / 3) * 3;
  const 本季赢单 = 赢单窗口(now.month(季首月).startOf("month").toDate());

  const 进行中各档 = OPP_STAGES.slice(0, -1).map((s) => {
    const 这档 = openOpps.filter((o) => o.stage === s);
    return { stage: s, count: 这档.length, amount: 按币种合计(这档, (o) => o.amount, 商机币种) };
  });
  const 末档 = OPP_STAGES[OPP_STAGES.length - 1];
  const funnel = {
    本月: [...进行中各档, { stage: 末档, ...本月赢单 }],
    本季: [...进行中各档, { stage: 末档, ...本季赢单 }],
  };

  /*
    排行要一个数来排：按本位币那一份排、条也按它画，旁边的金额照样按币种全写出来。
    不换汇（lib/currency.ts），所以一个人全是美元单、本位币是人民币时他排在后面——这是有意的，比编一个汇率诚实。
  */
  const 本位币 = business.currency;
  const ranking = owners
    .map((o) => {
      const amount = 按币种合计(o.opportunities, (x) => x.amount, 商机币种);
      return { id: o.id, name: o.name, email: o.email, amount, 排序额: 取币种(amount, 本位币) };
    })
    .sort((a, b) => b.排序额 - a.排序额 || b.amount.length - a.amount.length)
    .slice(0, 5);

  const oppTotalAmount = 按币种合计(openOpps, (o) => o.amount, 商机币种);
  const winRate = totalClosed ? Math.round((wonCount / totalClosed) * 100) : 0;
  const 本月签约额 = 签约合计(本月签约);
  const 上月签约额 = 签约合计(上月签约);

  /**
   * 卡片下方的三条小曲线。
   * 原本是写死的数组（[4,7,5,9,...] 之类），零数据时照样画出一条漂亮的上升线——
   * 数据首页上的假曲线比没有曲线更糟，人会照着它做判断。
   * 这里按最近 8 周真算；一条数据都没有时就返回全 0，曲线自然是平的。
   */
  const 周 = 最近8周(now);

  const newCustomerSeries = 数客户.每周新增;
  // 进行中商机的金额是「截至那一周末的存量」，不是当周新增。一条线只能画一个币种：画本位币那一份
  const oppAmountSeries = 每周进行中金额(周, oppsForSeries, (o) => 商机币种(o) === 本位币);
  // 赢单率同样取截至那一周末的累计口径，和卡片上的总赢单率一致
  const winRateSeries = 每周赢单率(周, oppsForSeries);

  return (
    <DashboardView
      内嵌={内嵌}
      多人={owners.length > 1}
      满额提醒={满额提醒}
      /**
       * 空库时整页换成一张「从哪开始」——对着空库画四个 0、一条平的折线和全 0 的管道，
       * 既不好看也不给信息，第一次打开的人还以为是坏了。
       * 判据用线索 + 客户 + 商机三个总数，不看金额：录了人还没报价也算有数据。
       */
      空库={leadTotal === 0 && customerTotal === 0 && oppsForSeries.length === 0}
      stats={{
        newCustomersThisMonth,
        // 上月是 0：没有可比的口径，不给环比（原来给 0，显示成「较上月 持平」，实际是从 0 涨上来的，2026-10-02 排查）
        newCustomersDelta: newCustomersLastMonth
          ? Number((((newCustomersThisMonth - newCustomersLastMonth) / newCustomersLastMonth) * 100).toFixed(1))
          : null,
        oppTotalAmount,
        winRate,
        签约本月: 本月签约额,
        // 上月一分钱都没有时不给环比：分母是 0 的百分比没有意义，只会是个吓人的数；两个月币种不一样也不给（同币环比）
        签约环比: 同币环比(本月签约额, 上月签约额),
        进行中商机: openOpps.length,
        逾期跟进,
        newCustomerSeries,
        oppAmountSeries,
        winRateSeries,
      }}
      trend={trendData}
      funnel={funnel}
      ranking={ranking}
      tasks={待办}
      watchlist={watchlist.items}
      watchlistTotal={watchlist.total}
      aiEnabled={aiEnabled}
    />
  );
}
