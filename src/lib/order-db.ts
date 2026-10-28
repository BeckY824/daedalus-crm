/**
 * 外贸订单的读（2026-10-03 外贸第 3a 块）。写在 app/(app)/orders/actions.ts，规则在 lib/order.ts。
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 当前节点, 超期数, 进度, 订单的钱 } from "./order";
import { 返工, 样品状态, 到港灯, 尾款要催 } from "./order-track";
import { 规整币种 } from "./currency";
import { 签约币种, 签约金额 } from "./money-db";

const 节点查询 = { orderBy: { idx: "asc" as const }, select: { idx: true, name: true, dueAt: true, status: true, doneAt: true, owner: { select: { userId: true } } } };

type 节点行 = { idx: number; name: string; dueAt: Date | null; status: string; doneAt: Date | null; owner: { userId: string } | null };
/** ownerId = 这一步的负责人（0.46.30 D-47），没指定是 null */
const 节点出 = (n: 节点行) => ({ idx: n.idx, name: n.name, dueAt: n.dueAt?.toISOString() ?? null, status: n.status, doneAt: n.doneAt?.toISOString() ?? null, ownerId: n.owner?.userId ?? null });

export type 订单行 = {
  id: string;
  no: string;
  customerId: string;
  customerName: string;
  /** 公司（Customer.school）：订单一览「客户」那一格的第二行 */
  customerCompany: string | null;
  ownerId: string;
  ownerName: string;
  amount: number;
  currency: string;
  incoterm: string | null;
  /** 付款方式、供应商、订单确认时间（2026-10-05 外贸客户要的列）。确认时间 = 那笔签约的时间，老订单没有签约就用建单时间 */
  payment: string | null;
  supplier: string | null;
  confirmedAt: string;
  createdAt: string;
  nodes: ReturnType<typeof 节点出>[];
  当前: { idx: number; name: string } | null;
  超期: number;
  进度: number;
  未收: number;
  /** 最近一轮验货不过：卡在返工（0.46.30 D-45） */
  返工: boolean;
  /** 样品走到哪了（0.46.30 D-44），见 lib/order-track.ts 样品状态 */
  样品: ReturnType<typeof 样品状态>;
  /** 预计 / 实际到港（0.46.30 D-46）；到港灯、要不要催尾款依赖 现在，订单列表 每次现算 */
  eta: string | null;
  ata: string | null;
  到港灯: ReturnType<typeof 到港灯>;
  催尾款: boolean;
};

/** 订单一览要的原始行：订单（带客户、节点、签约、供应商）+ 负责人名字。不看日子 */
async function 取订单原始(where: Prisma.TradeOrderWhereInput) {
  const readBatch = (after?: string) => prisma.tradeOrder.findMany({
    where: after ? {AND:[where,{id:{gt:after}}]} : where,
    orderBy: { id: "asc" },
    take: 1000,
    include: {
      customer: { select: { name: true, school: true } },
      nodes: 节点查询,
      contract: { select: { signedAt: true, amount: true, money: true } },
      purchase: { select: { supplier: { select: { name: true } } } },
      checks: { select: { kind: true, round: true, result: true } },
      track: { select: { sampleNa: true, eta: true, ata: true } },
    },
  });
  const rows: Awaited<ReturnType<typeof readBatch>> = [];
  let after: string | undefined;
  for (;;) {
    const batch = await readBatch(after);
    rows.push(...batch);
    if (batch.length < 1000) break;
    after = batch.at(-1)!.id;
  }
  const 人 = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return { rows, 人 };
}

/** 原始行拼成订单行（不看日子）。超期依赖 现在，这里先占 0，订单列表 每次现算再填（键的顺序不变） */
function 拼行({ rows, 人 }: Awaited<ReturnType<typeof 取订单原始>>): 订单行[] {
  return rows.map((o) => {
    const nodes = o.nodes.map(节点出);
    const 当 = 当前节点(nodes);
    return {
      id: o.id,
      no: o.no,
      customerId: o.customerId,
      customerName: o.customer.name,
      customerCompany: o.customer.school,
      ownerId: o.ownerId,
      ownerName: 人.get(o.ownerId) ?? "（已删除的成员）",
      // 有签约的以签约为准（2026-10-05 复查）：订单上那两格只是抄的，切过模版再改签约金额时会对不上
      amount: o.contract ? 签约金额(o.contract) : o.amount,
      currency: o.contract ? 签约币种(o.contract) : 规整币种(o.currency),
      incoterm: o.incoterm,
      payment: o.payment,
      supplier: o.purchase?.supplier?.name ?? null,
      confirmedAt: (o.contract?.signedAt ?? o.createdAt).toISOString(),
      createdAt: o.createdAt.toISOString(),
      nodes,
      当前: 当 ? { idx: 当.idx, name: 当.name } : null,
      超期: 0,
      进度: 进度(nodes),
      // 未收也按签约金额算（二审：和这一行展示的金额同一个口径）
      未收: 订单的钱({ ...o, amount: o.contract ? 签约金额(o.contract) : o.amount }).未收,
      返工: 返工(o.checks),
      样品: 样品状态(o.checks, !!o.track?.sampleNa),
      eta: o.track?.eta?.toISOString() ?? null,
      ata: o.track?.ata?.toISOString() ?? null,
      到港灯: "无",
      催尾款: false,
    };
  });
}

/**
 * 订单一览：每行一单，带 12 个节点。超期多的排上面，其次新的在前（和 Excel 总表同一个看法）。
 *
 * `共用`：不限定（lib/team-scope 的 限定的我 是 null：老板、个人版、企业版没开按组织看）时页面传 lib/home-cache.ts 的
 * 缓存着 进来——同一个筛选下各人看到的行一样，库一有提交就重取，企业版才开。缓存里放的是拼好的行，超期依赖 现在，仍每次现算。
 * 2026-10-25 企业版压测：2000 单时两批带 include 的查询约 36 ms，全占着读连接；拼行在单人时约 1 ms，
 * 压测时各页抢 CPU，每次要 6 ms 左右，所以连拼好的一起缓存。
 * 共用的行只读：下面每次给出去的是新的行、新的节点和当前节点，调用方改了不影响缓存里那份
 */
export async function 订单列表(
  where: Prisma.TradeOrderWhereInput = {},
  现在: Date = new Date(),
  共用?: <T>(key: string, 算: () => Promise<T>) => Promise<T>,
): Promise<订单行[]> {
  const 行 = 共用 ? await 共用(`订单列表:${JSON.stringify(where)}`, async () => 拼行(await 取订单原始(where))) : 拼行(await 取订单原始(where));
  return 行
    .map((r) => {
      const nodes = r.nodes.map((n) => ({ ...n }));
      const 海运 = { eta: r.eta, ata: r.ata };
      return { ...r, nodes, 当前: r.当前 && { ...r.当前 }, 超期: 超期数(nodes, 现在), 到港灯: 到港灯(海运, 现在), 催尾款: 尾款要催(海运, r.未收, 现在) };
    })
    .sort((a, b) => b.超期 - a.超期 || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 订单详情：表头、节点、单据、挂在各节点上的跟进、来源商机和它当前那一版报价 */
export async function 订单详情(id: string) {
  const o = await prisma.tradeOrder.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true } },
      opportunity: {
        select: {
          id: true, name: true,
          quotes: { orderBy: [{ quotedAt: "desc" }, { id: "desc" }], take: 1, select: { quotedAt: true, currency: true, lines: { orderBy: { sort: "asc" }, select: { product: true, spec: true, qty: true, unit: true, unitPrice: true } } } },
        },
      },
      nodes: 节点查询,
      docs: { orderBy: { sort: "asc" }, select: { id: true, name: true, state: true } },
      followUps: { include: { followUp: { select: { id: true, content: true, occurredAt: true, owner: { select: { name: true } } } } } },
      purchase: { include: { supplier: { select: { id: true, name: true } } } },
      contract: { select: { id: true, amount: true, signedAt: true, remark: true, money: true } },
      checks: { orderBy: [{ kind: "asc" }, { round: "asc" }], select: { id: true, kind: true, round: true, at: true, result: true, issue: true } },
      track: true,
    },
  });
  if (!o) return null;
  const 业务员 = await prisma.user.findUnique({ where: { id: o.ownerId }, select: { name: true } });
  const q = o.opportunity?.quotes[0];
  return {
    id: o.id,
    no: o.no,
    customer: o.customer,
    opportunity: o.opportunity ? { id: o.opportunity.id, name: o.opportunity.name } : null,
    报价: q && q.lines.length ? { quotedAt: q.quotedAt.toISOString(), currency: 规整币种(q.currency), 行: q.lines } : null,
    ownerName: 业务员?.name ?? "（已删除的成员）",
    // 有签约的以签约为准（同订单列表，2026-10-05 复查）：未收、页头都按它算
    amount: o.contract ? 签约金额(o.contract) : o.amount,
    currency: o.contract ? 签约币种(o.contract) : 规整币种(o.currency),
    incoterm: o.incoterm,
    payment: o.payment,
    depositDue: o.depositDue,
    depositPaid: o.depositPaid,
    depositAt: o.depositAt?.toISOString() ?? null,
    balancePaid: o.balancePaid,
    balanceAt: o.balanceAt?.toISOString() ?? null,
    remark: o.remark,
    createdAt: o.createdAt.toISOString(),
    /** 这张订单对应的签约（外贸，2026-10-05）。金额、币种、确认时间、备注以它为准；老订单没有 */
    contract: o.contract
      ? { id: o.contract.id, amount: 签约金额(o.contract), currency: 签约币种(o.contract), signedAt: o.contract.signedAt.toISOString(), remark: o.contract.remark }
      : null,
    采购: o.purchase
      ? { supplierId: o.purchase.supplierId, supplierName: o.purchase.supplier?.name ?? null, cost: o.purchase.cost, currency: 规整币种(o.purchase.currency), fxRate: o.purchase.fxRate }
      : null,
    nodes: o.nodes.map(节点出),
    docs: o.docs,
    /** 样品 / 验货每一轮（0.46.30 D-44 / D-45），按类、轮次排 */
    checks: o.checks.map((c) => ({ id: c.id, kind: c.kind, round: c.round, at: c.at?.toISOString() ?? null, result: c.result, issue: c.issue })),
    /** 海运 + 样品不适用（0.46.30 D-44 / D-46）；没有这一行就是都没填 */
    track: {
      sampleNa: o.track?.sampleNa ?? false,
      vessel: o.track?.vessel ?? null,
      container: o.track?.container ?? null,
      eta: o.track?.eta?.toISOString() ?? null,
      ata: o.track?.ata?.toISOString() ?? null,
    },
    notes: o.followUps
      .map((x) => ({ nodeIdx: x.nodeIdx, id: x.followUp.id, content: x.followUp.content, occurredAt: x.followUp.occurredAt.toISOString(), who: x.followUp.owner.name }))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  };
}

export type 订单详情数据 = NonNullable<Awaited<ReturnType<typeof 订单详情>>>;
