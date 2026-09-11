import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { llmEnabled, listModelOptions } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import { getBusiness } from "@/lib/business";
import { loadWatchlist } from "@/lib/sentinel-data";
import Board from "./Board";
import HomeChat, { type Suggestion } from "./HomeChat";

export const dynamic = "force-dynamic";

/**
 * 首页。配了 AI 就是一个对话面（指标图表去了 /overview）；没配 AI 就直接是数据看板。
 */
export default async function DashboardPage() {
  const user = await requireUser();
  if (!(await llmEnabled())) return <Board />;

  const b = await getBusiness();
  const now = dayjs();
  const [todayPlans, myPlans, myLast, watchlist, models] = await Promise.all([
    prisma.followPlan.count({ where: { ownerId: user.id, done: false, plannedAt: { gte: now.startOf("day").toDate(), lt: now.endOf("day").toDate() } } }),
    prisma.followPlan.count({ where: { ownerId: user.id, done: false } }),
    prisma.followUp.findFirst({ where: { ownerId: user.id }, orderBy: { occurredAt: "desc" }, select: { customer: { select: { name: true } } } }),
    loadWatchlist(now),
    listModelOptions(),
  ]);

  const mine = watchlist.filter((w) => w.ownerName === user.name);
  const parts: string[] = [];
  parts.push(todayPlans > 0 ? `今天有 ${todayPlans} 条跟进计划` : myPlans > 0 ? `有 ${myPlans} 条未完成的跟进计划` : "今天没有排跟进计划");
  if (mine.length > 0) parts.push(`${mine.length} 位${b.customer}正在被遗忘`);
  if (myLast?.customer.name) parts.push(`上次跟的是${myLast.customer.name}`);

  const suggestions: Suggestion[] = [];
  if (myPlans > 0) suggestions.push({ label: "准备下次跟进", question: "", kind: "prep" });
  if (myLast) suggestions.push({ label: "回顾上次沟通", question: "", kind: "recap" });
  for (const w of mine.slice(0, 2)) suggestions.push({ label: `${w.customerName}：${w.reason.replace(/^「[^」]*」的\S+?/, "")}`, question: `${w.customerName}这边该怎么接上？` });
  suggestions.push({ label: `各跟进状态各有多少${b.customer}`, question: `各跟进状态各有多少${b.customer}` });
  suggestions.push({ label: "这个月谁签得最多", question: "这个月哪个销售的签约金额最多" });

  return <HomeChat userName={user.name} suggestions={suggestions.slice(0, 6)} context={parts.join("，") + "。"} models={models} />;
}
