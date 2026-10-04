/**
 * 团队同步之后的疑似重复（2026-10-03）：两个人各录了同一位客户、各建了同一家供应商。
 * 同步不替人合并：号码一样不一定是同一个人（一个号码几个联系人的公司常见），名字一样的供应商可能是两家分厂。
 * 列出来、给链接，让人自己判断（合并客户的功能还没有，先删掉多的那一条）。
 */
import { 订单与供应商 } from "@/lib/features";
import { prisma } from "../prisma";
import { 号键 } from "../phone";
import { 号键SQL, 按号键找 } from "../phone-dedupe";

export type 疑似组 = { 种类: "客户" | "供应商"; 依据: string; 记录: { id: string; name: string; href: string; 谁的: string | null }[] };

export async function 疑似重复(): Promise<疑似组[]> {
  // 按号键分组（R-067 / R-069）：老库里的「138 0000 1111」和同事录的 13800001111 是同一组。和查重同一个式子，走同一个索引
  const 号码们 = await prisma.$queryRawUnsafe<{ phone: string }[]>(
    `SELECT ${号键SQL('"phone"')} AS phone FROM "Customer" WHERE phone IS NOT NULL AND TRIM(phone) <> '' GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 50`,
  );
  const 客户 = await prisma.customer.findMany({
    where: { id: { in: (await 按号键找(prisma, 号码们.map((x) => x.phone))).map((r) => r.id) } },
    select: { id: true, name: true, phone: true, salesOwner: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  // 供应商这一版不上（lib/features.ts）：不列，点进去也是 404
  const 名字们 = 订单与供应商 ? await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "Supplier" GROUP BY name HAVING COUNT(*) > 1 LIMIT 50`) : [];
  const 供应商 = await prisma.supplier.findMany({ where: { name: { in: 名字们.map((x) => x.name) } }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  return [
    ...号码们.map((g) => ({
      种类: "客户" as const,
      依据: `号码 ${g.phone}`,
      记录: 客户.filter((c) => 号键(c.phone) === g.phone).map((c) => ({ id: c.id, name: c.name, href: `/customers/${c.id}`, 谁的: c.salesOwner.name })),
    })),
    ...名字们.map((g) => ({
      种类: "供应商" as const,
      依据: `名称「${g.name}」`,
      记录: 供应商.filter((s) => s.name === g.name).map((s) => ({ id: s.id, name: s.name, href: `/suppliers/${s.id}`, 谁的: null })),
    })),
  ];
}
