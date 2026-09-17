import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { llmEnabled, listModelOptions } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { getBusiness } from "@/lib/business";
import { statusLabel } from "@/lib/business-config";
import { loadWatchlist } from "@/lib/sentinel-data";
import Board from "./Board";
import HomeChat, { type Suggestion } from "./HomeChat";
import StartCard from "./StartCard";
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { 查额度 } from "@/lib/tenant/ai-allowance";

export const dynamic = "force-dynamic";

/**
 * 首页。配了 AI 就是一个对话面（指标图表去了 /overview）；没配 AI 就直接是数据看板。
 */
export default async function DashboardPage() {
  const user = await requireUser();
  if (!(await llmEnabled())) {
    /*
      没配 AI 的首页就是数据看板。但**一条业务数据都没有**的时候，看板没什么可看，
      而第一次打开的人最需要的恰恰是一个起点——所以空库时不论配没配 AI，
      首页都是那张「开始」卡。配了 AI 的那条路在 HomeChat 里做同样的判断。
    */
    const 学员数 = await prisma.customer.count();
    if (学员数 === 0 && (await prisma.lead.count()) === 0) {
      // StartCard 自带那句「欢迎使用 Daedalus CRM」，这里不再叠一个页头
      return <StartCard />;
    }
    return <Board />;
  }

  const b = await getBusiness();
  const now = dayjs();
  const [todayPlans, myPlans, myLast, watchlist, models, 逾期, 高意向, 本月签约, 学员数] = await Promise.all([
    prisma.followPlan.count({ where: { ownerId: user.id, done: false, plannedAt: { gte: now.startOf("day").toDate(), lt: now.endOf("day").toDate() } } }),
    prisma.followPlan.count({ where: { ownerId: user.id, done: false } }),
    prisma.followUp.findFirst({ where: { ownerId: user.id }, orderBy: { occurredAt: "desc" }, select: { customer: { select: { name: true } } } }),
    loadWatchlist(now),
    listModelOptions(),
    /*
      首页那一行信号。三个数都必须是**这一刻真查出来的**，而且每个都能点到
      一个能把它重新数一遍的页面去——首页上写死过一次数字（手工测试清单里记着），
      从那以后规矩是：算不出来就不显示，绝不摆一个看起来像那么回事的数。
    */
    prisma.followPlan.count({ where: { ownerId: user.id, done: false, plannedAt: { lt: now.startOf("day").toDate() } } }),
    prisma.customer.count({ where: { followStatus: "意向较高" } }),
    prisma.contract.aggregate({ _sum: { amount: true }, where: { signedAt: { gte: now.startOf("month").toDate(), lt: now.endOf("month").toDate() } } }),
    prisma.customer.count(),
  ]);

  const mine = watchlist.filter((w) => w.ownerName === user.name);
  const parts: string[] = [];
  parts.push(todayPlans > 0 ? `今天有 ${todayPlans} 条跟进计划` : myPlans > 0 ? `有 ${myPlans} 条未完成的跟进计划` : "今天没有排跟进计划");
  if (mine.length > 0) parts.push(`${mine.length} 位${b.customer}正在被遗忘`);
  if (myLast?.customer.name) parts.push(`上次跟的是${myLast.customer.name}`);

  /*
    输入框底下那排问题。设计稿要求 4-6 条，而且**每一条都要是具体的问题**，
    不是「试试问我点什么」这种。所以分两段：
      先放这个库里真有的东西——名下有计划就「准备下次跟进」，有正在被遗忘的人就点名问他；
      再用一组任何时候都问得出答案的兜底补到至少四条。
    兜底不是凑数：这四条问的都是真表真列（计划、签约、商机阶段、跟进记录），
    空库时首页压根不走这条路（走 StartCard），所以不存在「点了什么也答不出来」。
  */
  const suggestions: Suggestion[] = [];
  if (myPlans > 0) suggestions.push({ label: "准备下次跟进", question: "", kind: "prep" });
  if (myLast) suggestions.push({ label: "回顾上次沟通", question: "", kind: "recap" });
  for (const w of mine.slice(0, 2)) suggestions.push({ label: `${w.customerName}：${w.reason.replace(/^「[^」]*」的\S+?/, "")}`, question: `${w.customerName}这边该怎么接上？` });
  const 兜底: Suggestion[] = [
    { label: `今天谁最需要跟进？`, question: `今天最该跟进的${b.customer}是谁，为什么` },
    { label: "这个月谁签得最多？", question: "这个月哪个销售的签约金额最多" },
    { label: "哪些商机可能延期？", question: "哪些进行中的商机已经很久没动了，可能延期" },
    { label: `各跟进状态各有多少${b.customer}？`, question: `各跟进状态各有多少${b.customer}` },
    { label: "帮我记一次电话", question: "帮我记一次电话沟通" },
  ];
  for (const x of 兜底) if (suggestions.length < 6) suggestions.push(x);

  // 试用期的免费提问次数。付费与自部署都是 null，界面上就不出现这一项
  let aiQuota: { 上限: number; 还剩: number } | null = null;
  if (multiTenant()) {
    const t = await resolveCurrentTenant();
    if (t) {
      const q = await 查额度(t.workspaceId);
      if (q.受限) aiQuota = { 上限: q.上限, 还剩: q.还剩 };
    }
  }

  return (
    <HomeChat
      userName={user.name}
      suggestions={suggestions.slice(0, 6)}
      context={parts.join("，") + "。"}
      models={models}
      aiQuota={aiQuota}
      /* 一条业务数据都没有：首页换成一张「开始」卡，不摆信号也不摆指标 */
      空库={学员数 === 0 && watchlist.length === 0 && myPlans === 0}
      信号={{
        逾期,
        高意向,
        本月签约: 本月签约._sum.amount ?? 0,
        高意向标签: statusLabel(b, "意向较高"),
      }}
    />
  );
}
