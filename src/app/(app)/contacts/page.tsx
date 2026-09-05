import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import ContactsView from "./ContactsView";
import type { Prisma } from "@/generated/prisma";

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

  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    take: 300,
    include: {
      customer: { select: { id: true, name: true, school: true, salesOwner: { select: { name: true } } } },
    },
  });

  return (
    <ContactsView
      keyword={sp.keyword ?? ""}
      rows={rows.map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        phone: c.phone,
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
