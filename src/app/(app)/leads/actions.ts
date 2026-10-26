"use server";

import { hasVisibleText } from "@/lib/form-validation";

import { 规整外贸档案 } from "@/lib/customer-extra";
import { 写外贸档案 } from "@/lib/customer-extra-db";

import { revalidatePath } from "next/cache";
import { prisma, defaultClient } from "@/lib/prisma";
import { 看全部, 看得到, 限定的我, 读的我 } from "@/lib/team-scope";
import { 认回打码号, 查电话, 号码带着字 } from "@/lib/phone";
import { 同号条件, 分机留存起 } from "@/lib/phone-dedupe";
import { 同邮箱条件 } from "@/lib/email-dedupe";

/** 外贸线索没有电话时拿来认人的邮箱（格式对才算）；有电话、或不是外贸，返回 null */
function 线索认人邮箱(lead: { phone: string | null; email: string | null }, 外贸: boolean): string | null {
  if (!外贸 || lead.phone?.trim()) return null;
  const r = 规整外贸档案({ email: lead.email });
  return r.ok && r.data.email ? r.data.email : null;
}
import { 版本冲突, 版本条件 } from "@/lib/edit-version";
import { requireUser } from "@/lib/auth";
import { LEAD_STATUSES } from "@/lib/constants";
import { recordAudit, type Actor } from "@/lib/audit";
import { getBusiness } from "@/lib/business";
import { 线索转档案 } from "@/lib/lead-convert";
import { 企业版 } from "@/lib/enterprise/switch";
import { 线索建项目 } from "@/lib/project/from-lead";
import { 规整沟通, type 向导跟进, type 规整好的沟通 } from "@/lib/project/wizard";
import { 超上限 } from "@/lib/project/db";
import { 生效组织规则 } from "@/lib/project/org-rules-store";
import { 客户存了推项目 } from "@/lib/project/auto-advance";
import { 规则开着 } from "@/lib/enterprise/rules";
import { 读组织 } from "@/lib/enterprise/org";
import { 能分配 } from "@/lib/enterprise/lead-assign";
import { 当前是共享区 } from "@/lib/shared-ws/current";

/**
 * 企业版「线索分配和配额」开着时，负责人只能经「分配」换（F2，10-25 实测）：编辑、新建里随手改负责人
 * 不查接手人角色、不查配额、不查谁能分，也不记分配。返回挡下的话；null = 照常存
 */
async function 改负责人不给(user: { id: string; role: string }, 原负责人: string | null | undefined, 新负责人: string): Promise<string | null> {
  if (新负责人 === 原负责人) return null;
  if (!(await 规则开着("线索分配")) || (await 当前是共享区())) return null;
  return 能分配(await 读组织(), user)
    ? "改负责人请用线索列表里的「分配」：会查接手人的角色、配额，并记进分配记录"
    : "只有老板、总管理员、市场管理能分配线索";
}

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
  if (!hasVisibleText(input.name)) return { ok: false as const, error: "请填写线索名称" };
  if (!LEAD_STATUSES.includes(input.status as (typeof LEAD_STATUSES)[number])) {
    return { ok: false as const, error: `线索状态「${input.status}」不是合法取值` };
  }
  // 来源不再预填（审查 M13）：没选就是数据库默认的「其他」，三套预设里都有这一项
  input = { ...input, source: input.source?.trim() || "其他" };
  /*
    没改过的旧来源照样放行（排查 D5）：设置里换了预设、删了某个来源以后，
    带着旧来源的线索连改个备注都存不了，报「不是合法取值」。新选的来源才必须在当前列表里。
  */
  const 原 = input.id ? await prisma.lead.findUnique({ where: { id: input.id }, select: { source: true, phone: true, ownerId: true } }) : null;
  const 原来源 = input.id ? 原?.source : null;
  /*
    共享试用区的线索页给的是打码号码（2026-10-02 排查 A6）：交回来的正是原号打码的样子就认回原号；
    别的带 * 的（AI 卡照抄的打码号）不收——星号进库就再也找不回真号
  */
  const 号 = 认回打码号(input.phone?.trim() || null, 原?.phone);
  if (号 && 号.includes("*")) return { ok: false as const, error: "电话里不能有 *" };
  // 未改的历史号码与准确打码返回保持原文；只规范新填写/更改的号码。
  const 电话 = 号 === 原?.phone ? { ok: true as const, phone: 号 ?? "" } : 查电话(号, { 必填: false });
  if (!电话.ok) return { ok: false as const, error: 电话.error };
  const 原文 = 号 && 号 !== 原?.phone && 号码带着字(号) ? `原始电话：${号}` : "";
  const 备注 = input.remark?.trim() || "";
  const remark = 原文 && !备注.includes(原文) ? [备注, 原文].filter(Boolean).join("\n") : 备注;
  input = { ...input, phone: 电话.phone, remark };
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
  // 新建、没人管的线索，原负责人都当作「我」：建给自己、认领照常，给别人要走分配
  const 不给 = input.id && !原 ? null : await 改负责人不给(user, 原?.ownerId ?? user.id, data.ownerId);
  if (不给) return { ok: false as const, error: 不给 };
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
 * 企业版开了项目模式：转化时顺手建项目（10-25 F6，lib/project/from-lead.ts）。负责人是别人时先按持有上限查一遍，
 * 规则要在事务外读（事务里读设置会卡住）。返回 null = 不建；{ error } = 超上限或首条跟进不对，转化整个不做。
 * 首条跟进必带（10-26 验收 #13），和建档向导同一套规整：开了超时回收要填下一步时间，没开时选填
 */
async function 转项目前查(b: { projectMode?: boolean }, me: { id: string }, ownerId: string, 跟进: 向导跟进 | undefined): Promise<null | { 建: true; 跟进: 规整好的沟通 } | { error: string }> {
  if (!企业版() || b.projectMode !== true) return null;
  if (!跟进 || typeof 跟进 !== "object") return { error: "转成项目要记一条首条跟进：这次和对方聊了什么" };
  const 规则 = await 生效组织规则();
  const 要下一步 = 规则.超时回收.开;
  const 好 = 规整沟通(跟进, { 要下一步, 叫法: "首条" });
  if ("error" in 好) return 好;
  if (ownerId !== me.id) {
    const 超 = await 超上限(prisma, 规则, ownerId, { phase: "线索", result: null });
    if (超) return { error: 超 };
  }
  return { 建: true, 跟进: 好 };
}

async function 转项目之后(user: Actor, lead: { name: string }, customerId: string, projectId: string | undefined) {
  if (!projectId) return;
  await recordAudit({
    user, action: "create", entity: "Project", entityId: projectId,
    summary: `线索「${lead.name}」转化时新建项目，连同首条跟进`,
    detail: { 项目: lead.name, customerId },
  });
  await 客户存了推项目(user, customerId);
  revalidatePath("/projects");
  revalidatePath("/follow-ups");
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
/**
 * 转客户时撞了号，撞的是谁（J-024）。业务员撞到同事的客户：**只给负责人**，不给名字、不给 id、不能并
 * （10-04 用户拍板，和客户表单查重一个口径）；看得到那位客户的人（老板、负责人自己、公海里的）可以「并到这位客户」。
 */
export type 线索撞号 = { 客户名: string | null; 负责人: string; customerId: string | null; 能并: boolean };

export async function convertLead(id: string, 跟进?: 向导跟进): Promise<
  { ok: true; customerId: string; projectId?: string } | { ok: false; error: string; 撞号?: 线索撞号 }
> {
  const user = await requireUser();
  const b = await getBusiness();
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) return { ok: false as const, error: "线索不存在" };
  if (lead.customerId) return { ok: false as const, error: "该线索已转化" };
  // 外贸：没有电话、有邮箱的线索按邮箱认人建档（2026-10-07，同客户表单和导入，lib/email-dedupe.ts）
  const 邮箱 = 线索认人邮箱(lead, b.template === "trade");
  // 手机号是学员的查重主键，没有就无法建档
  if (!lead.phone?.trim() && !邮箱) {
    return { ok: false as const, error: b.template === "trade" ? "该线索没有电话也没有邮箱，请先补充一样再转化" : "该线索没有联系电话，请先补充后再转化" };
  }
  /*
    先规整再查重，和客户表单、导入同一条规矩（lib/phone.ts）。原来只 trim 就拿去精确比：
    线索上写「138 0000 1111」，库里已有「13800001111」，认不出来，同一个人建出第二份档案，
    号码格式还和其他客户都不一样（2026-10-01 排查 A8）
  */
  const 电话 = 邮箱 ? { ok: true as const, phone: "" } : 查电话(lead.phone, { 必填: true });
  if (!电话.ok) return { ok: false as const, error: `线索上的电话「${lead.phone}」${电话.error.replace(/^电话/, "")}，先改一下再转化` };
  const phone = 电话.phone;
  const 依据 = phone ? "号码" : "邮箱";

  const 起 = await 分机留存起();
  const 我 = await 限定的我(defaultClient);
  // 团队开了互看：同事的客户看得到、但并不过去（并 = 改那位客户）
  const 读我 = await 读的我(defaultClient);
  const 项目 = await 转项目前查(b, user, lead.ownerId ?? user.id, 跟进);
  if (项目 && "error" in 项目) return { ok: false as const, error: 项目.error };
  const outcome = await prisma.$transaction(async (tx) => {
    // 看全部：同事的客户也算已经有了（团队版业务员，lib/team-scope.ts）
    const dup = await 看全部(async () =>
      tx.customer.findFirst({
        where: phone ? await 同号条件(tx, phone, 起) : await 同邮箱条件(tx, 邮箱!),
        select: { id: true, name: true, salesOwnerId: true, channelOwnerId: true, pool: { select: { customerId: true } }, salesOwner: { select: { name: true } } },
      }),
    );
    if (dup) {
      /*
        原来只报「请勿重复建档」，这条线索就永远转不了（J-024）。现在说清撞的是谁、给一条路：
        看得到那位就能并过去；看不到（业务员撞同事的）指路——线索负责人改成那位同事由他来并，或者请老板并
      */
      const 能并 = 看得到(dup, 我);
      const 负责人 = dup.salesOwner.name;
      return {
        ok: false as const,
        error: 能并
          ? `${phone ? "电话" : "邮箱"}已经是${b.customer}「${dup.name}」（负责人：${负责人}）的${依据}，可以把这条线索并到这位${b.customer}，不用另建档案`
          : 看得到(dup, 读我)
          ? `${phone ? "电话" : "邮箱"}已经是同事 ${负责人} 的${b.customer}「${dup.name}」的${依据}。同事的${b.customer}只能看，并不过去：可以把线索负责人改成 ${负责人} 由他来并，或者请老板并`
          : `${phone ? "电话" : "邮箱"}已经是同事 ${负责人} 名下一位${b.customer}的${依据}。你看不到这位${b.customer}，并不过去：可以把线索负责人改成 ${负责人} 由他来并，或者请老板并`,
        撞号: { 客户名: 能并 ? dup.name : null, 负责人, customerId: 能并 ? dup.id : null, 能并 } satisfies 线索撞号,
      };
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
    const 档案 = 线索转档案(lead, b.fields, b.template === "trade");
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
                phone: phone || null,
                email: lead.email,
                isPrimary: true,
              },
            }
          : undefined,
      },
    });

    // 外贸模版：来源、邮箱进客户的外贸档案（2026-10-05）。规整不过（邮箱格式怪）就不带那一格，原文还在线索上
    if (b.template === "trade") {
      const 规 = 规整外贸档案(档案.档案);
      await 写外贸档案(tx, customer.id, 规.ok ? 规.data : { source: 规整外贸档案({ source: 档案.档案.source }).ok ? 档案.档案.source : null }, false);
    }
    await tx.lead.update({ where: { id }, data: { customerId: customer.id } });
    const projectId = 项目 ? await 线索建项目(tx, { 线索名: lead.name, leadId: id, customerId: customer.id, ownerId: lead.ownerId ?? user.id, creatorId: user.id, 跟进: 项目.跟进 }) : undefined;
    return { ok: true as const, customerId: customer.id, projectId };
  });

  if (!outcome.ok) return outcome;

  await recordAudit({
    user, action: "convert", entity: "Lead", entityId: id,
    summary: `线索「${lead.name}」转为${b.customer}`,
    detail: { leadId: id, customerId: outcome.customerId, phone },
  });
  await 转项目之后(user, lead, outcome.customerId, outcome.projectId);

  revalidatePath("/leads");
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return outcome;
}

/**
 * 把线索并到已有的那位客户（J-024）：线索标成已转化、关联过去，**不另建档案、不改那位客户的资料**。
 *
 * 只能并到电话对得上的那位（就是转客户时撞上的那位），只有看得到那位客户的人能并——
 * 限定层（lib/team-scope.ts）下业务员按 id 找同事的客户本来就是 null，这里就照「看不到」答。
 *
 * Lead.customerId 是唯一的：那位客户已经关联着另一条线索（同一个人从两个渠道来过）时，
 * 原来那条的关联不动，这一条只标已转化、备注里写明并到了谁。
 */
export async function mergeLeadInto(leadId: string, customerId: string, 跟进?: 向导跟进): Promise<{ ok: true; customerId: string; projectId?: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const b = await getBusiness();
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "线索不存在" };
  if (lead.customerId || lead.status === "已转化") return { ok: false, error: "该线索已转化" };
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
  if (!customer) return { ok: false, error: `你看不到这位${b.customer}，并不过去：请找负责人或老板` };
  const 邮箱 = 线索认人邮箱(lead, b.template === "trade");
  const 电话 = 查电话(lead.phone, { 必填: true });
  const 条件 = 邮箱 ? await 同邮箱条件(prisma, 邮箱) : 电话.ok ? await 同号条件(prisma, 电话.phone, await 分机留存起()) : null;
  const 对得上 = 条件 !== null && (await prisma.customer.count({ where: { AND: [{ id: customerId }, 条件] } })) > 0;
  if (!对得上) return { ok: false, error: `线索${邮箱 ? "邮箱" : "电话"}和${b.customer}「${customer.name}」对不上，不能并` };
  const 项目 = await 转项目前查(b, user, lead.ownerId ?? user.id, 跟进);
  if (项目 && "error" in 项目) return { ok: false, error: 项目.error };

  const 结果 = await prisma.$transaction(async (tx) => {
    // 唯一约束不分人：要看全部（关联着那位的线索可能是同事的）
    const 已关联 = await 看全部(() => tx.lead.findFirst({ where: { customerId }, select: { id: true } }));
    const 备注 = 已关联 ? [lead.remark?.trim(), `已并入${b.customer}「${customer.name}」`].filter(Boolean).join("\n") : undefined;
    // 闸门：只有把线索从「没转化」翻过来的那一次算数（两个人同时点，和 convertLead 一个道理）
    const gate = await tx.lead.updateMany({
      where: { id: leadId, customerId: null, status: { not: "已转化" } },
      data: { status: "已转化", convertedAt: new Date(), ...(已关联 ? { remark: 备注 } : { customerId }) },
    });
    if (!gate.count) return null;
    return { projectId: 项目 ? await 线索建项目(tx, { 线索名: lead.name, leadId, customerId, ownerId: lead.ownerId ?? user.id, creatorId: user.id, 跟进: 项目.跟进 }) : undefined };
  });
  if (!结果) return { ok: false, error: "这条线索刚刚已经转化过了，刷新看看" };

  await recordAudit({
    user, action: "convert", entity: "Lead", entityId: leadId,
    summary: `线索「${lead.name}」并入${b.customer}「${customer.name}」`,
    detail: { leadId, customerId, 并入: true },
  });
  await 转项目之后(user, lead, customerId, 结果.projectId);
  revalidatePath("/leads");
  revalidatePath("/customers");
  revalidatePath(`/customers/${customerId}`);
  return { ok: true, customerId, projectId: 结果.projectId };
}
