import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 供应商详情 } from "@/lib/supplier-db";
import SupplierView from "./SupplierView";

export const dynamic = "force-dynamic";

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const s = await 供应商详情(id);
  if (!s) notFound();
  return <SupplierView s={s} />;
}
