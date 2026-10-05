import { 供应商页 } from "@/lib/features";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 供应商详情 } from "@/lib/supplier-db";
import SupplierView from "./SupplierView";

export const dynamic = "force-dynamic";

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  // 订单 / 供应商这一版不上（lib/features.ts）：直接输网址也打不开
  if (!供应商页) notFound();
  await requireUser();
  const { id } = await params;
  const s = await 供应商详情(id);
  if (!s) notFound();
  return <SupplierView s={s} />;
}
