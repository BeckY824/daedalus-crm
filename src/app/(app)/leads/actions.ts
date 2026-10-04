"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { 看全部 } from "@/lib/team-scope";
import { 认回打码号 } from "@/lib/phone";
import { 查电话 } from "@/lib/phone";
import { 同号条件, 分机留存起 } from "@/lib/phone-dedupe";
import { 版本冲突, 版本条件 } from "@/lib/edit-version";
import { requireUser } from "@/lib/auth";
import { LEAD_STATUSES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { getBusiness } from "@/lib/business";
import { 线索转档案 } from "@/lib/lead-convert";

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
  /** 打开编辑框那一刻的 updatedAt。给了就当闸门：期间有人改过不盖掉（排查 D3） */
  版本?: string | null;
}) {
  const user = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.name ?? "").trim()) return { ok: false as const, error: "请填写线索名称" };
  if (!LEAD_STATUSES.includes(input.status as (typeof LEAD_STATUSES)[number])) {
    return { ok: false as const, error: `线索状态「${input.status}」不是合法取值` };
  }
  // 来源不再预填（审查 M13）：没选就是数据库默认的「其他」，三套预设里都有这一项
  input = { ...input, source: input.source?.trim() || "其他" };
  /*
    没改过的旧来源照样放行（排查 D5）：设置里换了预设、删了某个来源以后，
    带着旧来源的线索连改个备注都存不了，报「不是合法取值」。新选的来源才必须在当前列表里。
  */
  const 原 = input.id ? await prisma.lead.findUnique({ where: { id: input.id }, select: { source: true, phone: true } }) : null;
  const 原来源 = input.id ? 原?.source : null;
  /*
    共享试用区的线索页给的是打码号码（2026-10-02 排查 A6）：交回来的正是原号打码的样子就认回原号；
    别的带 * 的（AI 卡照抄的打码号）不收——星号进库就再也找不回真号
  */
  const 号 = 认回打码号(input.phone?.trim() || null, 原?.phone);
  if (号 && 号.includes("*")) return { ok: false as const, error: "电话里不能有 *" };
  input = { ...input, phone: 号 };
  /*
    来源能选也能填（2026-10-02 用户定）：不在业务配置列表里的也收——没有程序按来源的值去判断什么，
    人手上的说法（「视频号直播间」「老板朋友圈」）只让选等于逼他挑一个不对的。只限个长度
  */
  if (input.source.length > 30) return { ok: false as const, error: "线索来源太长了，30 个字以内" };
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
  if (input.id) {
    const 写了 = await prisma.lead.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data });
    if (写了.count === 0) return { ok: false as const, error: 原来源 === undefined ? "这条线索已经不在了（可能已删除）" : 版本冲突 };
    await recordAudit({
      user, action: "update", entity: "Lead", entityId: input.id,
      summary: `修改线索「${data.name}」：${data.source} · ${data.status}`,
      detail: { 名称: data.name, 来源: data.source, 状态: data.status, 联系人: data.contact, 电话: data.phone },
    });
  } else {
    const l = await prisma.lead.create({ data });
    await recordAudit({
      user, action: "create", entity: "Lead", entityId: l.id,
      summary: `新建线索「${data.name}」：${data.source} · ${data.status}`,
      detail: { 名称: data.name, 来源: data.source, 状态: data.status, 联系人: data.contact, 电话: data.phone },
    });
  }

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
  if (!lead.phone?.trim()) {
    return { ok: false as const, error: "该线索没有联系电话，请先补充后再转化" };
  }
  /*
    先规整再查重，和客户表单、导入同一条规矩（lib/phone.ts）。原来只 trim 就拿去精确比：
    线索上写「138 0000 1111」，库里已有「13800001111」，认不出来，同一个人建出第二份档案，
    号码格式还和其他客户都不一样（2026-10-01 排查 A8）
  */
  const 电话 = 查电话(lead.phone, { 必填: true });
  if (!电话.ok) return { ok: false as const, error: `线索上的电话「${lead.phone}」${电话.error.replace(/^电话/, "")}，先改一下再转化` };
  const phone = 电话.phone;

  const 起 = await 分机留存起();
  const outcome = await prisma.$transaction(async (tx) => {
    // 看全部：同事的客户也算已经有了（团队版业务员，lib/team-scope.ts）
    const dup = await 看全部(() => tx.customer.findFirst({ where: 同号条件(phone, 起), select: { name: true } }));
    if (dup) {
      return { ok: false as const, error: `手机号已存在于${b.customer}「${dup.name}」，请勿重复建档` };
    }

    const gate = await tx.lead.updateMany({
      where: { id, customerId: null },
      data: { status: "已转化", convertedAt: new Date() },
    });
    // 没抢到闸门说明别人刚刚转化过，此处尚未写入任何数据，直接退出即可
    if (gate.count === 0) {
      return { ok: false as const, error: "这条线索刚刚已经转化过了，刷新看看" };
    }

    // 线索名 → 公司、联系人 → 姓名、行业和来源一起带过去（审查 M13），规则在 lib/lead-convert.ts
    const 档案 = 线索转档案(lead, b.fields);
    const customer = await tx.customer.create({
      data: {
        name: 档案.name,
        phone,
        school: 档案.school,
        grade: null,
        major: 档案.major,
        followStatus: "待跟进",
        decisionStatus: "了解中",
        remark: 档案.remark,
        salesOwnerId: lead.ownerId ?? user.id,
        // 只有空格的联系人当没有（2026-10-04 L-016）：和 线索转档案 一个判法，邮箱那时已进了备注
        contacts: lead.contact?.trim()
          ? {
              create: {
                name: lead.contact.trim(),
                // 联系人就是客户本人时写明「本人」，联系人表里一眼看得出这条是谁
                position: 档案.name === lead.contact.trim() && 档案.school ? "本人" : null,
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
