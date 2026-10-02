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

  // 从客户上移出、人留着的（UnassignedContact，2026-10-01）。没有客户可搜，只按姓名、电话
  const 散的where: Prisma.UnassignedContactWhereInput = sp.keyword
    ? { OR: [{ name: { contains: sp.keyword } }, { phone: { contains: sp.keyword } }] }
    : {};

  const [总数, rows, 散的总数, 散的, 学员们, users] = await Promise.all([
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
    prisma.unassignedContact.count({ where: 散的where }),
    prisma.unassignedContact.findMany({ where: 散的where, orderBy: { detachedAt: "desc" }, take: 300 }),
    // 「添加联系人」要先选归属，所以把学员的名字一起带下来
    可选客户(),
    // 只拿来判断「是不是只有一个人」（负责人那一列摆不摆，见 lib/solo.ts）
    负责人候选(),
  ]);
  const 号 = await 号码脱敏器();

  return (
    <ContactsView
      总数={总数 + 散的总数}
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
        remark: c.remark,
        updatedAt: c.updatedAt.toISOString(),
        未归属: false,
        原来: null as string | null,
        customerId: c.customer.id,
        customerName: c.customer.name,
        school: c.customer.school,
        ownerName: c.customer.salesOwner.name,
      })).concat(
        散的.map((u) => ({
          id: u.id,
          name: u.name,
          position: u.position,
          phone: 号(u.phone),
          email: u.email,
          wechat: u.wechat,
          isPrimary: false,
          remark: u.remark,
          updatedAt: u.updatedAt.toISOString(),
          未归属: true,
          原来: u.fromCustomerName,
          customerId: "",
          customerName: "",
          school: null,
          ownerName: "",
        })),
      )}
    />
  );
}
