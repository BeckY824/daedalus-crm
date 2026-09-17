import { prisma } from "@/lib/prisma";
import { 成员选项 } from "@/lib/utils";

/**
 * 「数据」页那两个回看视图（本月 / 本年）的数据。
 *
 * 原来这段在 `/reports` 的 page 里，那一页现在并进了 `/overview`——
 * 三处看数、两个问答框，新用户分不清该去哪儿（见改版方案）。
 * 逻辑一个字没改，只是挪成可以按任意时间段调用：本月传这个月，本年传今年。
 */

export type Bucket = { label: string; amount: number; count: number };
export type Agg = { id: string; name: string; amount: number; count: number };
/** 趋势图上点开一根柱子时看到的那几行：这一段是哪几笔签约凑出来的 */
export type 明细行 = { id: string; 学员: string; 学员id: string; 金额: number; 日期: string; 销售: string };

export type 复盘 = {
  trend: Bucket[];
  /** 按趋势图的横轴刻度分好的明细，key 就是 Bucket.label */
  明细: Record<string, 明细行[]>;
  bySales: Agg[];
  byChannelOwner: Agg[];
  byChannel: Agg[];
  byAttribution: Agg[];
  total: { amount: number; count: number };
};

/** 趋势那张图的横轴按什么切：本月按天，本年按月 */
export type 粒度 = "day" | "month";

function bucketOf(d: Date, 粒: 粒度) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  if (粒 === "day") return `${m}-${String(d.getDate()).padStart(2, "0")}`;
  return `${y}-${m}`;
}

export async function 加载复盘(from: Date, to: Date, 粒: 粒度): Promise<复盘> {
  const contracts = await prisma.contract.findMany({
    where: { signedAt: { gte: from, lt: to } },
    orderBy: { signedAt: "asc" },
    select: {
      id: true,
      amount: true,
      signedAt: true,
      customer: {
        select: {
          id: true,
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

  const byBucket = new Map<string, { amount: number; count: number }>();
  /**
   * 每一根柱子对应的那几笔。**顺手分好，不另跑一趟查询**——
   * 合同行已经全在手上了，分组是几行代码；为「点开一根柱子」再查一次库，
   * 既慢又可能和图上的数对不上（两次查询之间有人签了一单）。
   */
  const 明细 = new Map<string, 明细行[]>();
  for (const c of contracts) {
    const k = bucketOf(c.signedAt, 粒);
    const cur = byBucket.get(k) ?? { amount: 0, count: 0 };
    byBucket.set(k, { amount: cur.amount + c.amount, count: cur.count + 1 });
    const 行 = 明细.get(k) ?? [];
    行.push({
      id: c.id,
      学员: c.customer.name,
      学员id: c.customer.id,
      金额: c.amount,
      日期: c.signedAt.toISOString(),
      销售: c.customer.salesOwner?.name ?? "—",
    });
    明细.set(k, 行);
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
    const m = new Map<string, Agg>();
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

  return {
    trend: [...byBucket.entries()].map(([label, v]) => ({ label, ...v })),
    明细: Object.fromEntries(明细),
    bySales: 成员agg((c) => c.customer.salesOwner, "—"),
    byChannelOwner: 成员agg((c) => c.customer.channelOwner, "无渠道"),
    byChannel: agg((c) => c.customer.channel, "自然流量"),
    byAttribution: agg((c) => c.customer.attributionChannel ?? c.customer.attributionCustomer, "无归属"),
    total: { amount: contracts.reduce((s, c) => s + c.amount, 0), count: contracts.length },
  };
}
