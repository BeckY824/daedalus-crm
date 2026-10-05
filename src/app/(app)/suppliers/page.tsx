import { 供应商页 } from "@/lib/features";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 供应商列表 } from "@/lib/supplier-db";
import SuppliersView from "./SuppliersView";

export const dynamic = "force-dynamic";

/** 供应商一览（2026-10-03 外贸第 3c 块）：评级好的、合作多的排前面；按名字 / 品类搜走网址参数 */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ keyword?: string }> }) {
  // 订单 / 供应商这一版不上（lib/features.ts）：直接输网址也打不开
  if (!供应商页) notFound();
  await requireUser();
  const sp = await searchParams;
  const k = sp.keyword?.trim();
  const rows = await 供应商列表(k ? { OR: [{ name: { contains: k } }, { category: { contains: k } }, { region: { contains: k } }] } : {});
  return <SuppliersView rows={rows} filters={{ keyword: sp.keyword ?? "" }} />;
}
