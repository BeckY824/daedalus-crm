import { prisma } from "@/lib/prisma";
import { 成员选项 } from "@/lib/utils";
import { requireUser } from "@/lib/auth";
import { llmEnabled } from "@/lib/llm";
import ReportsView from "./ReportsView";

export const dynamic = "force-dynamic";

type SP = Promise<{ period?: string; year?: string }>;

/** 把签约记录按 月 / 季 / 年 归组 */
function bucketOf(d: Date, period: string) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (period === "year") return `${y}年`;
  if (period === "quarter") return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export default async function ReportsPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;
  const period = sp.period ?? "month";
  const year = sp.year ? Number(sp.year) : new Date().getFullYear();

  const from = new Date(year, 0, 1);
  const to = new Date(year + 1, 0, 1);

  const contracts = await prisma.contract.findMany({
    where: { signedAt: { gte: from, lt: to } },
    orderBy: { signedAt: "asc" },
    select: {
      amount: true,
      signedAt: true,
      customer: {
        select: {
          name: true,
          salesOwner: { select: { id: true, name: true, email: true } },
          channelOwner: { select: { id: true, name: true, email: true } },
          channel: { select: { id: true, name: true } },
          attributionChannel: { select: { id: true, name: true } },
          attributionCustomer: { select: { id: true, name: true } },
        },
      },
    },
  });

  // 按周期归组
  const byBucket = new Map<string, { amount: number; count: number }>();
  for (const c of contracts) {
    const k = bucketOf(c.signedAt, period);
    const cur = byBucket.get(k) ?? { amount: 0, count: 0 };
    byBucket.set(k, { amount: cur.amount + c.amount, count: cur.count + 1 });
  }

  /**
   * 按维度汇总。
   *
   * **key 必须是实体 id，不能是姓名。** 成员姓名和学员姓名都允许重复，
   * 按姓名分组会把两个不同的人的签约累加进同一行——报表读数直接错，
   * 而且看不出任何异常，没人会来报这个错。
   */
  type 维度项 = { id: string; name: string } | null;
  const agg = (pick: (c: (typeof contracts)[number]) => 维度项, 空值名: string) => {
    const m = new Map<string, { id: string; name: string; amount: number; count: number }>();
    for (const c of contracts) {
      const e = pick(c);
      const id = e?.id ?? "__none__";
      const cur = m.get(id) ?? { id, name: e?.name ?? 空值名, amount: 0, count: 0 };
      m.set(id, { ...cur, amount: cur.amount + c.amount, count: cur.count + 1 });
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  };

  /**
   * 成员维度：撞名的把登录名带出来，口径与各处负责人下拉一致。
   * 分组已经按 id 分开了，这一步只解决「两行都叫张三，不知道哪行是谁」。
   */
  const 成员agg = (
    pick: (c: (typeof contracts)[number]) => { id: string; name: string; email: string } | null,
    空值名: string,
  ) => {
    const 成员 = new Map<string, { id: string; name: string; email: string }>();
    for (const c of contracts) {
      const e = pick(c);
      if (e) 成员.set(e.id, e);
    }
    const 标签 = new Map(成员选项([...成员.values()]).map((o) => [o.value, o.label]));
    return agg(pick, 空值名).map((r) => ({ ...r, name: 标签.get(r.id) ?? r.name }));
  };

  const years = await prisma.contract.findMany({ select: { signedAt: true } });
  const yearOptions = [...new Set(years.map((c) => c.signedAt.getFullYear()))].sort((a, b) => b - a);
  if (!yearOptions.includes(year)) yearOptions.unshift(year);

  return (
    <ReportsView
      period={period}
      year={year}
      yearOptions={yearOptions}
      trend={[...byBucket.entries()].map(([label, v]) => ({ label, ...v }))}
      bySales={成员agg((c) => c.customer.salesOwner, "—")}
      byChannelOwner={成员agg((c) => c.customer.channelOwner, "无渠道")}
      byChannel={agg((c) => c.customer.channel, "自然流量")}
      byAttribution={agg(
        (c) => c.customer.attributionChannel ?? c.customer.attributionCustomer,
        "无归属",
      )}
      total={{
        amount: contracts.reduce((s, c) => s + c.amount, 0),
        count: contracts.length,
      }}
      aiEnabled={await llmEnabled()}
    />
  );
}
