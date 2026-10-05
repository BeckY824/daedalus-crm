import { 订单, 订单节点 } from "@/lib/features";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 订单详情 } from "@/lib/order-db";
import { prisma } from "@/lib/prisma";
import OrderView from "./OrderView";
import OrderLite from "./OrderLite";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ node?: string }> }) {
  // 订单 / 供应商这一版不上（lib/features.ts）：直接输网址也打不开
  if (!订单) notFound();
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const [o, 供应商] = await Promise.all([
    订单详情(id),
    prisma.supplier.findMany({ orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, rating: true } }),
  ]);
  if (!o) notFound();
  // 节点关着（lib/features.ts）：轻量的订单页——信息 + 挂在它上面的跟进
  if (!订单节点) return <OrderLite o={o} />;
  const 点名 = Number(sp.node);
  return <OrderView o={o} 供应商={供应商} 先看={Number.isInteger(点名) && 点名 >= 1 && 点名 <= o.nodes.length ? 点名 : undefined} />;
}
