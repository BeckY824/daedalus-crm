import type { Prisma, PrismaClient } from "@/generated/prisma";
import { OPP_STAGES } from "@/lib/constants";
import { 每批, 汇总, type 列汇总 } from "@/lib/pipeline-columns";
import { 带币种, 商机币种 } from "@/lib/money-db";

/**
 * 商机管道一页取多少（2026-10-24 企业版压测）。
 *
 * 原来一次把进行中的商机全取回来、全画成卡片：企业版 1 万张卡时整页 HTML 8.6 MB，30 人同时开就排队。
 * 现在分两步：
 *   1. 轻查询：同一个 where，只取 id、阶段、金额、负责人、币种。列头的条数和按币种合计、要不要显示负责人
 *      都在这一份「全部」上算，和原来一模一样（顺序也一样，按币种求和的先后不变）。
 *   2. 每列只取前 N 张的详情（默认 50），「再看 50 条」加大 N；刚新建的那一张（新）不在前 N 也带上。
 *
 * 不到 N 张的列（个人版几乎都是）取回来的就是全部，页面照原样在卡片上算列头。
 * 排序在金额之外加了 id：同金额的先后原来由库决定（不稳定），分批时必须稳定，否则翻页会重复、漏行。
 */

export const 管道条件 = (起: Date): Prisma.OpportunityWhereInput => ({
  OR: [
    { status: "OPEN" },
    { status: "WON", OR: [{ closed: { is: { closedAt: { gte: 起 } } } }, { closed: { is: null }, updatedAt: { gte: 起 } }] },
  ],
});

const 排序: Prisma.OpportunityOrderByWithRelationInput[] = [{ amount: "desc" }, { id: "asc" }];

export type 管道卡 = {
  id: string;
  name: string;
  amount: number;
  currency: string;
  stage: string;
  status: string;
  probability: number;
  expectedDealAt: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

export type 管道页 = {
  rows: 管道卡[];
  /** 每个阶段在「全部」上的条数和按币种合计（OPP_STAGES 里的阶段才有） */
  列: Record<string, 列汇总>;
  /** 全部商机条数（含不在 OPP_STAGES 里的老阶段：原来页面是否空状态就看它） */
  总条数: number;
  /** 全部商机的负责人 id（去重），页面拿它判断要不要在卡上写负责人 */
  负责人: string[];
};

type Db = Pick<PrismaClient, "opportunity">;

export async function 取管道(db: Db, 起: Date, 每列: Record<string, number>, 新?: string | null): Promise<管道页> {
  const where = 管道条件(起);
  const 轻 = await db.opportunity.findMany({
    where,
    orderBy: 排序,
    select: { id: true, stage: true, amount: true, ownerId: true, ...带币种.商机 },
  });

  const 列: Record<string, 列汇总> = {};
  const 要: string[] = [];
  for (const s of OPP_STAGES) {
    const 这列 = 轻.filter((o) => o.stage === s);
    列[s] = 汇总(这列, (o) => o.amount, (o) => 商机币种(o));
    for (const o of 这列.slice(0, 每列[s] ?? 每批)) 要.push(o.id);
  }
  if (新 && !要.includes(新) && 轻.some((o) => o.id === 新 && (OPP_STAGES as readonly string[]).includes(o.stage))) 要.push(新);

  const 详 = 要.length
    ? await db.opportunity.findMany({
        where: { AND: [where, { id: { in: 要 } }] },
        orderBy: 排序,
        include: {
          customer: { select: { id: true, name: true } },
          owner: { select: { name: true } },
          ...带币种.商机,
        },
      })
    : [];

  return {
    rows: 详.map((o) => ({
      id: o.id,
      name: o.name,
      amount: o.amount,
      currency: 商机币种(o),
      stage: o.stage,
      status: o.status,
      probability: o.probability,
      expectedDealAt: o.expectedDealAt?.toISOString() ?? null,
      customerId: o.customer.id,
      customerName: o.customer.name,
      ownerId: o.ownerId,
      ownerName: o.owner.name,
    })),
    列,
    总条数: 轻.length,
    负责人: [...new Set(轻.map((o) => o.ownerId))],
  };
}
