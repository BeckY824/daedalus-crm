"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { LEAD_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { getBusiness } from "@/lib/business";

export async function saveLead(input: {
  id?: string;
  name: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  industry?: string | null;
  source: string;
  status: string;
  remark?: string | null;
  ownerId?: string | null;
}) {
  const user = await requireUser();
  const b = await getBusiness();
  if (!LEAD_STATUSES.includes(input.status as (typeof LEAD_STATUSES)[number])) {
    return { ok: false as const, error: `线索状态「${input.status}」不是合法取值` };
  }
  if (!b.sources.includes(input.source)) {
    return { ok: false as const, error: `线索来源「${input.source}」不是合法取值` };
  }
  const data = {
    name: input.name.trim(),
    contact: input.contact || null,
    phone: input.phone || null,
    email: input.email || null,
    industry: input.industry || null,
    source: input.source,
    status: input.status,
    remark: input.remark || null,
    ownerId: input.ownerId || user.id,
  };
  if (input.id) await prisma.lead.update({ where: { id: input.id }, data });
  else await prisma.lead.create({ data });

  revalidatePath("/leads");
  revalidatePath("/dashboard");
  return { ok: true as const };
}

export async function deleteLeads(ids: string[]) {
  const me = await requireUser();
  const 待删 = await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const res = await prisma.lead.deleteMany({ where: { id: { in: ids } } });
  if (res.count) {
    await recordAudit({
      user: me, action: "delete", entity: "Lead",
      summary: `删除 ${res.count} 条线索：${待删.map((l) => l.name).join("、")}`,
      detail: 待删,
    });
  }
  revalidatePath("/leads");
  return { ok: true as const, deleted: res.count };
}

/**
 * 线索转客户：建客户 + 建联系人 + 标记线索已转化。
 *
 * 三步必须在同一个事务里，且要有并发闸门。原本是「先查 customerId 是否为空，
 * 再建客户，再回写线索」——两个人同时点转化，双方都会看到 customerId 为空、
 * 双方都建档成功，于是同一个人在学员库里出现两条，回写又只留下后一条的关联，
 * 另一条变成没人知道来历的孤儿记录。
 *
 * 闸门是那句 updateMany：只有把线索从「未关联」翻过来的那一次会影响到行，
 * 另一次影响 0 行、直接退出。SQLite 的写锁保证两句 updateMany 不会同时生效。
 */
export async function convertLead(id: string) {
  const user = await requireUser();
  const b = await getBusiness();
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return { ok: false as const, error: "线索不存在" };
  if (lead.customerId) return { ok: false as const, error: "该线索已转化" };
  // 手机号是学员的查重主键，没有就无法建档
  const phone = lead.phone?.trim();
  if (!phone) {
    return { ok: false as const, error: "该线索没有联系电话，请先补充后再转化" };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const dup = await tx.customer.findFirst({ where: { phone }, select: { name: true } });
    if (dup) {
      return { ok: false as const, error: `手机号已存在于${b.customer}「${dup.name}」，请勿重复建档` };
    }

    const gate = await tx.lead.updateMany({
      where: { id, customerId: null },
      data: { status: "已转化", convertedAt: new Date() },
    });
    // 没抢到闸门说明别人刚刚转化过，此处尚未写入任何数据，直接退出即可
    if (gate.count === 0) {
      return { ok: false as const, error: "该线索刚刚已被其他人转化，请刷新查看" };
    }

    const customer = await tx.customer.create({
      data: {
        name: lead.name,
        phone,
        school: null,
        grade: null,
        major: null,
        followStatus: "待跟进",
        decisionStatus: "了解中",
        remark: lead.remark,
        salesOwnerId: lead.ownerId ?? user.id,
        contacts: lead.contact
          ? {
              create: {
                name: lead.contact,
                phone,
                email: lead.email,
                isPrimary: true,
              },
            }
          : undefined,
      },
    });

    await tx.lead.update({ where: { id }, data: { customerId: customer.id } });
    return { ok: true as const, customerId: customer.id };
  });

  if (!outcome.ok) return outcome;

  await recordAudit({
    user, action: "convert", entity: "Lead", entityId: id,
    summary: `线索「${lead.name}」转为${b.customer}`,
    detail: { leadId: id, customerId: outcome.customerId, phone },
  });

  revalidatePath("/leads");
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return outcome;
}
