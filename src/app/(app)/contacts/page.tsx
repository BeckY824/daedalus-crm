import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 可选客户 } from "@/lib/options";
import ContactsView from "./ContactsView";
import type { Prisma } from "@/generated/prisma";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 负责人候选 } from "@/lib/owners";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;

  const where: Prisma.ContactWhereInput = sp.keyword
    ? {
        OR: [
          { name: { contains: sp.keyword } },
          { phone: { contains: sp.keyword } },
          { customer: { name: { contains: sp.keyword } } },
        ],
      }
    : {};

  const [总数, rows, 学员们, users] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      take: 300,
      include: {
        customer: { select: { id: true, name: true, school: true, salesOwner: { select: { name: true } } } },
      },
    }),
    // 「添加联系人」要先选归属，所以把学员的名字一起带下来
    可选客户(),
    // 只拿来判断「是不是只有一个人」（负责人那一列摆不摆，见 lib/solo.ts）
    负责人候选(),
  ]);
  const 号 = await 号码脱敏器();

  return (
    <ContactsView
      总数={总数}
      keyword={sp.keyword ?? ""}
      学员们={学员们}
      users={users}
      rows={rows.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        phone: 号(c.phone),
        email: c.email,
        wechat: c.wechat,
        isPrimary: c.isPrimary,
        customerId: c.customer.id,
        customerName: c.customer.name,
        school: c.customer.school,
        ownerName: c.customer.salesOwner.name,
      }))}
    />
  );
}
