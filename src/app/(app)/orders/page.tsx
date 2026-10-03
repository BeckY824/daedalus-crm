import { requireUser } from "@/lib/auth";
import { 订单列表 } from "@/lib/order-db";
import { 负责人候选 } from "@/lib/owners";
import OrdersView from "./OrdersView";

export const dynamic = "force-dynamic";

/**
 * 订单一览（2026-10-03 外贸第 3a / 3b 块）：长得就是那张 Excel 订单总表——行是单，列是节点，格子红黄绿。
 * 超期多的排上面。按业务员筛走网址参数，刷新、分享都还在。
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ ownerId?: string; 看?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const [rows, users] = await Promise.all([订单列表(sp.ownerId ? { ownerId: sp.ownerId } : {}), 负责人候选()]);
  return <OrdersView rows={rows} users={users} filters={{ ownerId: sp.ownerId ?? "" }} />;
}
