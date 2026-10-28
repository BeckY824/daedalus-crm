import { 订单, 订单节点 } from "@/lib/features";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 订单列表 } from "@/lib/order-db";
import { 负责人候选 } from "@/lib/owners";
import { 企业版 } from "@/lib/enterprise/switch";
import { 分页起, 切订单页 } from "@/lib/orders-paging";
import { defaultClient } from "@/lib/prisma";
import { 限定的我 } from "@/lib/team-scope";
import { 缓存着 } from "@/lib/home-cache";
import { 我该做的 } from "@/lib/order-track";
import OrdersView from "./OrdersView";

export const dynamic = "force-dynamic";

/**
 * 订单一览（2026-10-03 外贸第 3a / 3b 块）：长得就是那张 Excel 订单总表——行是单，列是节点，格子红黄绿。
 * 超期多的排上面。按业务员筛走网址参数，刷新、分享都还在。
 * 「我该做的」（0.46.30 D-47，团队版多人才有）：只留有我负责、没做完的节点的单。负责人只是筛选，不是权限。
 * 企业版超过 分页起 单：服务端排好、算好合计，只发这一页（lib/orders-paging.ts）；页码、每页、排序也在网址里。
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ ownerId?: string; 我?: string; 看?: string; page?: string; pageSize?: string; sort?: string }> }) {
  // 订单 / 供应商这一版不上（lib/features.ts）：直接输网址也打不开
  if (!订单) notFound();
  const me = await requireUser();
  const sp = await searchParams;
  const [全部, users] = await Promise.all([
    // 不限定（老板、个人版、企业版没开按组织看）时原始行走短时缓存（lib/order-db.ts）
    (async () => 订单列表(sp.ownerId ? { ownerId: sp.ownerId } : {}, new Date(), (await 限定的我(defaultClient)) ? undefined : 缓存着))(),
    负责人候选(),
  ]);
  const 只看我的 = !!sp.我 && 订单节点 && users.length > 1;
  const rows = 只看我的 ? 全部.filter((r) => 我该做的(r.nodes, me.id).length > 0) : 全部;
  const filters = { ownerId: sp.ownerId ?? "", 我: 只看我的 ? "1" : "" };
  if (企业版() && rows.length > 分页起) {
    const 这页 = 切订单页(rows, { 节点: 订单节点, sort: sp.sort, page: sp.page, pageSize: sp.pageSize });
    return <OrdersView rows={这页.rows} users={users} filters={filters} 分页={这页.分页} />;
  }
  return <OrdersView rows={rows} users={users} filters={filters} />;
}
