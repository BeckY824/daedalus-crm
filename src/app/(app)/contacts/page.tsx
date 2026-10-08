import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 搜索词, 号码片段 } from "@/lib/search-keyword";
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
  // 关键词去掉前后空格再搜（2026-10-04 J-008）：复制来的「张三 」原来一个都搜不到
  const 词 = 搜索词(sp.keyword);

  const where: Prisma.ContactWhereInput = 词
    ? {
        OR: [
          { name: { contains: 词 } },
          { phone: { contains: 号码片段(词) ?? 词 } },
          // 搜索框写着能搜微信（2026-10-02 排查 H6）
          { wechat: { contains: 词 } },
          { customer: { name: { contains: 词 } } },
        ],
      }
    : {};

  // 未归属保留原客户名，搜索它不会重新关联已删除的客户，也不会扩大账号可见范围。
  const 散的where: Prisma.UnassignedContactWhereInput = 词
    ? { OR: [{ name: { contains: 词 } }, { phone: { contains: 号码片段(词) ?? 词 } }, { wechat: { contains: 词 } }, { fromCustomerName: { contains: 词 } }] }
    : {};

  const [总数, rows, 散的总数, 散的, firstCustomer, users] = await Promise.all([
    // take: 300 取回来的行数不是总数，分页条会拿它冒充总数。见 leads/page.tsx 的说明
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      take: 300,
      include: {
        customer: { select: { id: true, name: true, school: true, salesOwner: { select: { id: true, name: true, email: true } } } },
      },
    }),
    prisma.unassignedContact.count({ where: 散的where }),
    prisma.unassignedContact.findMany({ where: 散的where, orderBy: { detachedAt: "desc" }, take: 300 }),
    // 只判断是否可添加；候选由表单按需搜索，不拉整表。
    prisma.customer.findFirst({ select: { id: true } }),
    // 只拿来判断「是不是只有一个人」（负责人那一列摆不摆，见 lib/solo.ts）
    负责人候选(),
  ]);
  const 号 = await 号码脱敏器();

  return (
    <ContactsView
      总数={总数 + 散的总数}
      keyword={sp.keyword ?? ""}
      学员们={[]}
      有客户={Boolean(firstCustomer)}
      users={users}
      rows={rows.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        phone: 号(c.phone),
        email: c.email,
        wechat: c.wechat,
        isPrimary: c.isPrimary,
        fromCustomerId: null as string | null,
        wasPrimary: null as boolean | null,
        remark: c.remark,
        updatedAt: c.updatedAt.toISOString(),
        未归属: false,
        原来: null as string | null,
        customerId: c.customer.id,
        customerName: c.customer.name,
        school: c.customer.school,
        ownerName: c.customer.salesOwner.name,
        ownerId: c.customer.salesOwner.id,
        ownerEmail: c.customer.salesOwner.email,
      })).concat(
        散的.map((u) => ({
          id: u.id,
          name: u.name,
          position: u.position,
          phone: 号(u.phone),
          email: u.email,
          wechat: u.wechat,
          isPrimary: false,
          fromCustomerId: u.fromCustomerId,
          wasPrimary: u.wasPrimary,
          remark: u.remark,
          updatedAt: u.updatedAt.toISOString(),
          未归属: true,
          原来: u.fromCustomerName,
          customerId: "",
          customerName: "",
          school: null,
          ownerName: "",
          ownerId: "",
          ownerEmail: "",
        })),
      )}
    />
  );
}
