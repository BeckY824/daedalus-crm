/**
 * 客户外贸档案的读写（2026-10-05）。规则在 lib/customer-extra.ts。
 * 一位客户最多一行；没有这一行 = 都没填。全部清空也**不删行**、写成空（2026-10-05 复查）：删了再填是一条「插入」，
 * 团队同步里插入带着全部列，会把同事那边同时填的格子冲掉（lib/sync/local.ts 回放那条规矩只管插入撞已有行）
 */
import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 外贸键, 空档案, type 外贸档案 } from "./customer-extra";

type 库 = Prisma.TransactionClient | typeof prisma;

/**
 * 只改给了的那几格（undefined = 不碰，null = 清空）。
 * 默认顺带把客户的 updatedAt 往前推（2026-10-05 复查）：档案是客户的一部分，撤销导入靠 updatedAt 认「导入之后人改过没有」，
 * 不推的话人逐个补了 WhatsApp，一撤销整批照删。刚建出来的客户（新建、线索转客户、导入）不用推：传 碰版本 false
 */
export async function 写外贸档案(db: 库, customerId: string, 改: Partial<外贸档案>, 碰版本 = true): Promise<void> {
  const 有改 = 外贸键.filter((k) => 改[k] !== undefined);
  if (有改.length === 0) return;
  const 原 = await db.customerExtra.findUnique({ where: { customerId } });
  const 新: 外贸档案 = { ...空档案(), ...(原 ? 取档案(原) : {}) };
  for (const k of 有改) 新[k] = 改[k] ?? null;
  if (!原 && 外贸键.every((k) => !新[k])) return;
  await db.customerExtra.upsert({ where: { customerId }, create: { customerId, ...新 }, update: 新 });
  if (碰版本) {
    // 版本号严格递增（同 saveCustomer 的 bump）：取 max(现在, 现值 + 1)——紧跟在一次保存后面、或本机钟慢时不往回退（二审）
    const 现 = await db.customer.findUnique({ where: { id: customerId }, select: { updatedAt: true } });
    if (现) await db.customer.updateMany({ where: { id: customerId }, data: { updatedAt: new Date(Math.max(Date.now(), 现.updatedAt.getTime() + 1)) } });
  }
}

/** 库里那一行 → 五格（多余的列不带出去） */
export function 取档案(r: Partial<外贸档案> | null | undefined): 外贸档案 {
  const o = 空档案();
  if (!r) return o;
  for (const k of 外贸键) o[k] = r[k] ?? null;
  return o;
}

/**
 * 切到外贸模版时给老客户补一次「来源」（2026-10-06 二审）：通用模版下来源记在渠道（推荐人）里，或者线索转过来时写在
 * 线索上；外贸模版不摆渠道，新的来源格又是空的，人一看像是数据丢了、按来源也筛不出来。
 * 只补来源空着的：线索上的来源（不是「其他」）优先，没有就用渠道名。不推 updatedAt（不算人改的），返回补了几位
 */
export async function 补来源(): Promise<number> {
  const 人们 = await prisma.customer.findMany({
    where: { OR: [{ extra: { is: null } }, { extra: { is: { source: null } } }], AND: [{ OR: [{ lead: { isNot: null } }, { channelId: { not: null } }] }] },
    select: { id: true, lead: { select: { source: true } }, channel: { select: { name: true } } },
    take: 20_000,
  });
  let 补了 = 0;
  for (const c of 人们) {
    const 线索来源 = c.lead?.source && c.lead.source !== "其他" ? c.lead.source.trim() : "";
    const 来源 = (线索来源 || c.channel?.name || "").trim().slice(0, 40);
    if (!来源) continue;
    await 写外贸档案(prisma, c.id, { source: 来源 }, false);
    补了++;
  }
  return 补了;
}
