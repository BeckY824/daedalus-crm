/**
 * 团队同步之后的疑似重复（2026-10-03）：两个人各录了同一位客户、各建了同一家供应商。
 * 同步不替人合并：号码一样不一定是同一个人（一个号码几个联系人的公司常见），名字一样的供应商可能是两家分厂。
 * 列出来、给链接，让人自己判断（合并客户的功能还没有，先删掉多的那一条）。
 */
import { 供应商页 } from "@/lib/features";
import { prisma } from "../prisma";
import { 号键 } from "../phone";
import { 号键SQL, 按号键找 } from "../phone-dedupe";
import { 按邮箱找 } from "../email-dedupe";

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
  /*
    外贸按邮箱认的（没有电话，2026-10-07）：两台各建了一位同邮箱的，号码那组查不出来。只比没有电话的那些——
    有电话的几位联系人共用 info@ 是常事，不算重复（同 lib/email-dedupe 开头）
  */
  const 邮箱们 = await prisma.$queryRawUnsafe<{ 键: string }[]>(
    `SELECT lower(trim(e."email")) AS 键 FROM "CustomerExtra" e JOIN "Customer" c ON c.id = e."customerId"
     WHERE (c.phone IS NULL OR TRIM(c.phone) = '') AND e."email" IS NOT NULL AND TRIM(e."email") <> '' GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 50`,
  );
  const 邮行 = await 按邮箱找(prisma, 邮箱们.map((x) => x.键));
  const 邮客户 = await prisma.customer.findMany({
    where: { id: { in: 邮行.map((r) => r.id) }, phone: "" },
    select: { id: true, name: true, salesOwner: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  // 供应商页这一版不上（lib/features.ts）：不列，点进去也是 404
  const 名字们 = 供应商页 ? await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM "Supplier" GROUP BY name HAVING COUNT(*) > 1 LIMIT 50`) : [];
  const 供应商 = await prisma.supplier.findMany({ where: { name: { in: 名字们.map((x) => x.name) } }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  return [
    ...号码们.map((g) => ({
      种类: "客户" as const,
      依据: `号码 ${g.phone}`,
      记录: 客户.filter((c) => 号键(c.phone) === g.phone).map((c) => ({ id: c.id, name: c.name, href: `/customers/${c.id}`, 谁的: c.salesOwner.name })),
    })),
    ...邮箱们.map((g) => ({
      种类: "客户" as const,
      依据: `邮箱 ${g.键}`,
      记录: 邮客户.filter((c) => 邮行.some((r) => r.id === c.id && r.键 === g.键)).map((c) => ({ id: c.id, name: c.name, href: `/customers/${c.id}`, 谁的: c.salesOwner.name })),
    })),
    ...名字们.map((g) => ({
      种类: "供应商" as const,
      依据: `名称「${g.name}」`,
      记录: 供应商.filter((s) => s.name === g.name).map((s) => ({ id: s.id, name: s.name, href: `/suppliers/${s.id}`, 谁的: null })),
    })),
    /*
      号码那一句是裸 SQL 查的、不过团队版限定；记录是限定过的。业务员看来两条都是同事的那组，记录是空的、号码却摆出来了——
      等于把同事客户的号码给了他（10-04 撞号不露同事客户那次查出来的）。自己看得到不到两条的组不算「疑似重复」
    */
  ].filter((g) => g.记录.length >= 2);
}
