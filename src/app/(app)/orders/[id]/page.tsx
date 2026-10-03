import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 订单详情 } from "@/lib/order-db";
import OrderView from "./OrderView";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ node?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const o = await 订单详情(id);
  if (!o) notFound();
  const 点名 = Number(sp.node);
  return <OrderView o={o} 先看={Number.isInteger(点名) && 点名 >= 1 && 点名 <= o.nodes.length ? 点名 : undefined} />;
}
