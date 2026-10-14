/**
 * 订单就是一笔签约（2026-10-05，外贸客户建议）。
 *
 * 客户原话：「把客户详情里面的签约名称改成订单，签约里面的信息对应成订单类目信息」。
 * 外贸里签约 = 客户确认 PI = 下单，签约和订单分开登记就是同一件事记两遍。所以外贸模版下：
 *   - 「新建订单」走登记签约那条原路（查重、赢单联动、把客户推到已签约、业绩都在那里），
 *     同一个事务里再写这张订单：订单号、付款方式、供应商
 *   - 金额、币种、订单确认时间以签约为准（确认时间 = 签约时间），订单上那两格只是跟着抄一份给订单一览用
 *   - 删签约订单跟着没（TradeOrder.contractId 外键级联）
 * 这里只写订单这一半；签约那一半在 customers/actions.ts 的 saveContract。
 */
import { businessDayjs } from "@/lib/business-clock";
import type { Prisma } from "@/generated/prisma";
import { 节点名们, 成交前节点数, 默认单据, 默认订单号 } from "./order";
import { 看全部 } from "./team-scope";

/** 订单那边说不通的（号撞了、定金比金额多）：事务里抛出、saveContract 接住说人话，整笔不落库 */
export class 订单说不通 extends Error {}

/** 订单号撞了别的单（2026-10-05 复查） */
export class 订单号重复 extends 订单说不通 {
  constructor(public 号: string) {
    super(`订单号「${号}」已经有一张了，换一个号，或者不填让系统按日期编`);
  }
}

/** 订单比签约多的那几格。不给（undefined）= 不碰 */
export type 订单附加 = {
  no?: string | null;
  payment?: string | null;
  /** 供应商名字：库里有同名的就挂上它，没有就新建一家（能选也能填）。空 = 不挂 */
  supplier?: string | null;
  /** 已选档案的稳定ID；null明确清空，undefined兼容旧客户端只给名字。 */
  supplierId?: string | null;
};

const 文本 = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 旧客户端只给名字时仅复用唯一匹配，不能从同名档案中猜一家。 */
async function 供应商id(tx: Prisma.TransactionClient, 名: string): Promise<string | null> {
  if (!名) return null;
  const 有 = await tx.supplier.findMany({ where: { name: 名 }, take: 2, select: { id: true } });
  if (有.length > 1) throw new 订单说不通("有多家同名供应商，请从候选中选择具体的档案");
  if (有.length === 1) return 有[0].id;
  return (await tx.supplier.create({ data: { name: 名 }, select: { id: true } })).id;
}

/**
 * 在登记 / 编辑签约的事务里把订单写上：这笔签约还没有订单就建一张，有就改。
 * 新建时：订单号不填按日期编（团队里带上下单人的第一个字）；从商机来的，前四个节点（询盘 → 客户确认）记成已完成。
 */
export async function 写签约的订单(
  tx: Prisma.TransactionClient,
  a: {
    签约id: string;
    customerId: string;
    ownerId: string;
    amount: number;
    currency: string;
    附加: 订单附加;
    /** 从哪个商机转来的（只认一个：勾了好几个商机就不挂） */
    opportunityId?: string | null;
    /** 团队里订单号的前缀（lib/order.ts 团队订单前缀） */
    前缀?: string;
    现在?: Date;
    /**
     * 编辑一笔签约时：它还没有订单（切外贸之前登记的老签约），**订单那几格一格都没填就不建**（2026-10-05 复查：
     * 改一下备注就冒出一张订单不对）；填了订单号 / 付款方式 / 供应商任意一格 = 人要给它补一张订单，就建（二审：
     * 原来填了也一声不响丢掉，还提示「已保存」）。补建的单号按签约那天编
     */
    只改不建?: boolean;
  },
): Promise<{ id: string; no: string } | null> {
  const 现在 = a.现在 ?? new Date();
  const 填的号 = a.附加.no !== undefined ? 文本(a.附加.no, 40) : undefined;
  const payment = a.附加.payment !== undefined ? 文本(a.附加.payment, 60) || null : undefined;
  // 和供应商档案页同一个规矩：去首尾空格、最长 60 字、名字一字不差算同一家（suppliers/actions.ts saveSupplier）
  const 供应商名 = a.附加.supplier !== undefined ? 文本(a.附加.supplier, 60) : undefined;

  const 已有 = await tx.tradeOrder.findUnique({ where: { contractId: a.签约id }, select: { id: true, no: true, depositDue: true, purchase: { select: { supplierId: true, supplier: { select: { name: true } } } } } });
  // 金额改得比定金应收还少（二审）：存下去之后定金尾款那块怎么填都报「定金比订单金额还多」，卡死
  if (已有 && 已有.depositDue > a.amount) throw new 订单说不通(`这张订单的定金应收是 ${已有.depositDue}，比新的金额还多：先在订单页「条款 · 定金」里把定金改小`);
  if (!已有 && a.只改不建 && !填的号 && !payment && !供应商名 && !a.附加.supplierId) return null;
  // 供应商在决定建不建之后才建：不建订单时不留一家没人用的供应商（二审）
  let 供应商: string | null | undefined;
  if (a.附加.supplierId !== undefined) {
    if (a.附加.supplierId === null) 供应商 = null;
    else {
      if (typeof a.附加.supplierId !== "string" || !a.附加.supplierId) throw new 订单说不通("请重新选择供应商");
      const 选中 = await tx.supplier.findUnique({ where: { id: a.附加.supplierId }, select: { id: true } });
      if (!选中) throw new 订单说不通("这家供应商已经不在了，请重新选择");
      供应商 = 选中.id;
    }
  } else if (供应商名 !== undefined) {
    // 旧界面重复提交原名字时保留原引用，不能悄悄换成同名的另一家。
    供应商 = 供应商名 && 已有?.purchase?.supplier?.name === 供应商名
      ? 已有.purchase.supplierId
      : await 供应商id(tx, 供应商名);
  }
  /*
    手填的号不许和别的单重：跟进下拉、导出、订单一览里都按号认单。看全部——业务员看不到的同事那张也算
    （订单号没有唯一索引：老库、同步回放里可能已经有重的，不为它建索引让迁移失败）
  */
  if (填的号 && 填的号 !== 已有?.no) {
    const 撞 = await 看全部(async () => tx.tradeOrder.findFirst({ where: { no: 填的号, ...(已有 ? { id: { not: 已有.id } } : {}) }, select: { id: true } }));
    if (撞) throw new 订单号重复(填的号);
  }
  let o: { id: string; no: string };
  if (已有) {
    o = await tx.tradeOrder.update({
      where: { id: 已有.id },
      data: {
        amount: a.amount,
        currency: a.currency,
        ...(填的号 ? { no: 填的号 } : {}),
        ...(payment !== undefined ? { payment } : {}),
      },
      select: { id: true, no: true },
    });
  } else {
    const 日 = `${a.前缀 ?? ""}${businessDayjs(现在).format("YYYYMMDD")}`;
    // 看全部：业务员看不到的那几张（进了公海、转给了同事的客户）也占着号，不看全部会编出重号
    const 今天的号 = 填的号 ? [] : (await 看全部(async () => tx.tradeOrder.findMany({ where: { no: { startsWith: 日 } }, select: { no: true } }))).map((x) => x.no);
        o = await tx.tradeOrder.create({
      data: {
        no: 填的号 || 默认订单号(今天的号, 现在, a.前缀 ?? ""),
        customerId: a.customerId,
        opportunityId: a.opportunityId ?? null,
        ownerId: a.ownerId,
        amount: a.amount,
        currency: a.currency,
        payment: payment ?? null,
        contractId: a.签约id,
        // 节点、单据这一版不摆（lib/features.ts 订单节点），照旧建上：哪天打开时老订单不至于一步都没有
        nodes: {
          // 订单就是客户确认了（一笔签约）：询盘 → 客户确认这前 4 步一律算走完，不论挂没挂上商机（二审）
          create: 节点名们.map((name, i) => {
            const 走完 = i < 成交前节点数;
            return { idx: i + 1, name, status: 走完 ? "已完成" : "未开始", doneAt: 走完 ? 现在 : null };
          }),
        },
        docs: { create: 默认单据(null).map((name, i) => ({ name, sort: i })) },
      },
      select: { id: true, no: true },
    });
  }
  /*
    比价里「选用」的那家（供应商页开着时有比价）：新建、从商机转来、人又没填供应商——带它过去（二审：原来 createOrder 里有，
    订单改走签约之后断了）。人填了就以人填的为准
  */
  if (!已有 && !供应商 && a.opportunityId) {
    const 选 = await tx.supplierQuote.findFirst({ where: { opportunityId: a.opportunityId, verdict: "选用" }, orderBy: { quotedAt: "desc" }, select: { supplierId: true } });
    if (选) await tx.tradeOrderPurchase.upsert({ where: { orderId: o.id }, create: { orderId: o.id, supplierId: 选.supplierId }, update: { supplierId: 选.supplierId } });
  }
  if (供应商 !== undefined) {
    if (供应商) await tx.tradeOrderPurchase.upsert({ where: { orderId: o.id }, create: { orderId: o.id, supplierId: 供应商 }, update: { supplierId: 供应商 } });
    else await tx.tradeOrderPurchase.updateMany({ where: { orderId: o.id }, data: { supplierId: null } });
  }
  return o;
}
