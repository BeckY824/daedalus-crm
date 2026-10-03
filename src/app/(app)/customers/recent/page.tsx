import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 最近客户键 } from "@/lib/last-customer";

export const dynamic = "force-dynamic";

/**
 * 左栏「客户」点进来先到这儿（2026-10-03，照毛玻璃原型）：直接进「名单 + 详情」，打开最近看过的那位。
 * 记的那位已经删了，就开名单最上面那位（和中栏名单同一个排序：最近跟进的在前）；
 * 一位客户都没有，进表格页——那里有空库引导和导入。
 * 表格视图在名单右上角的按钮里（/customers），筛选、批量、导出都还在那儿。
 */
export default async function 最近客户() {
  await requireUser();
  const 记的 = (await cookies()).get(最近客户键)?.value;
  if (记的) {
    const 在 = await prisma.customer.findUnique({ where: { id: 记的 }, select: { id: true } });
    if (在) redirect(`/customers/${在.id}`);
  }
  const 第一位 = await prisma.customer.findFirst({
    orderBy: [{ lastFollowAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  redirect(第一位 ? `/customers/${第一位.id}` : "/customers");
}
