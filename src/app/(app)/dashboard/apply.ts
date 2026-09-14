"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { buildProposal, missingFields, summarizeApplied, type Proposal, type 一处改动 } from "@/lib/agent/proposals";
import { patchCustomer, saveCustomer, saveContract } from "../customers/actions";
import { saveFollowUp, savePlan } from "../customers/[id]/actions";
import { saveLead } from "../leads/actions";
import { saveOpportunity } from "../opportunities/actions";
import { saveChannel } from "../channels/actions";
import { 可担任负责人 } from "@/lib/constants";

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * 确认一张 AI 建议卡，把它真的写进去。
 *
 * 这是 AI 参与写入的唯一入口，也是唯一一处「模型的输出会落库」的地方，所以两条铁律：
 *   1. 传进来的东西一律不可信——卡片上的值人可以随便改，所以在这里用和生成时同一套
 *      校验（buildProposal）重新收一遍，而不是信前端说它合法
 *   2. 真正的写入仍然走原有的 server action，权限、查重、留痕、revalidate 全部复用，
 *      不给 AI 开任何旁路
 * 落库后额外记一条 ai_apply，和 ai_use 分开：一个是"调了模型"，一个是"人批准了模型的建议"。
 */
/**
 * 改档案。
 *
 * 关键是**不自己写库**，而是把改动合并进整份记录再交给 saveCustomer——
 * 手机号查重、推荐链成环检查、归属字段重算（resolveAttribution）、
 * 乐观锁、逐字段留痕、revalidate，全在那里面，一个都不能绕过去。
 * 绕过去的那一刻，AI 改出来的数据就和人改出来的不是一回事了。
 *
 * 注意**不做下游归属重算**：那是 attribution.ts 的既定设计（tests/attribution.test.ts
 * 「归属固化」那一组钉着），改上游推荐人不会追溯性改写下游已成交的业绩归属。
 */
async function 改档案(customerId: string, changes: 一处改动[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const cur = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!cur) return { ok: false, error: "记录已被删除" };

  const 取值 = (f: string) => changes.find((c) => c.field === f)?.value;
  const 有 = (f: string) => changes.some((c) => c.field === f);

  // 关系字段：模型给的是名字，这里解析成 id。重名直接报错，绝不猜——
  // 猜错就是把客户挂到别人名下，而且没人会发现
  let salesOwnerId = cur.salesOwnerId;
  if (有("salesOwnerName")) {
    const n = (取值("salesOwnerName") ?? "").trim();
    if (!n) return { ok: false, error: "负责人不能留空" };
    const hit = await prisma.user.findMany({ where: { name: n, ...可担任负责人 }, select: { id: true } });
    if (hit.length === 0) return { ok: false, error: `没有叫「${n}」的在职销售` };
    if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 位同事都叫「${n}」，请到档案页手动指定` };
    salesOwnerId = hit[0].id;
  }

  let channelId = cur.channelId;
  let referrerCustomerId = cur.referrerCustomerId;
  if (有("channelName")) {
    const n = (取值("channelName") ?? "").trim();
    if (!n) channelId = null;
    else {
      const hit = await prisma.channel.findMany({ where: { name: n }, select: { id: true } });
      if (hit.length === 0) return { ok: false, error: `没有叫「${n}」的渠道` };
      if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 个渠道都叫「${n}」，请到档案页手动指定` };
      channelId = hit[0].id;
    }
  }
  if (有("referrerName")) {
    const n = (取值("referrerName") ?? "").trim();
    if (!n) referrerCustomerId = null;
    else {
      const hit = await prisma.customer.findMany({ where: { name: n, id: { not: customerId } }, select: { id: true } });
      if (hit.length === 0) return { ok: false, error: `没有叫「${n}」的记录` };
      if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 位都叫「${n}」，请到档案页手动指定` };
      referrerCustomerId = hit[0].id;
    }
  }

  // 渠道负责人：给了名字就钉死为这个人；给空字符串 = 清掉手工值、恢复按推荐链；没提这个字段 = 不碰
  let channelOwnerId: string | null | undefined = undefined;
  if (有("channelOwnerName")) {
    const n = (取值("channelOwnerName") ?? "").trim();
    if (!n) channelOwnerId = null;
    else {
      const hit = await prisma.user.findMany({ where: { name: n, ...可担任负责人 }, select: { id: true } });
      if (hit.length === 0) return { ok: false, error: `没有叫「${n}」的在职销售` };
      if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 位同事都叫「${n}」，请到档案页手动指定` };
      channelOwnerId = hit[0].id;
    }
  }

  const 文本 = (f: string, 原: string | null) => (有(f) ? (取值(f) || "").trim() || null : 原);
  const 快照 = {
    name: cur.name, phone: cur.phone, school: cur.school, grade: cur.grade, major: cur.major,
    followStatus: cur.followStatus, decisionStatus: cur.decisionStatus,
    expectedSignAt: cur.expectedSignAt, remark: cur.remark,
    salesOwnerId: cur.salesOwnerId, channelId: cur.channelId, referrerCustomerId: cur.referrerCustomerId,
    channelOwnerId: cur.channelOwnerId,
  };

  const r = await saveCustomer({
    id: cur.id,
    // 用库里当前的版本号：卡片不是一个"编辑会话"，人看到的就是此刻的值。
    // 真正的并发保护由 saveCustomer 内部的合并逻辑承担
    updatedAt: cur.updatedAt.toISOString(),
    base: 快照,
    name: 有("name") ? (取值("name") || "").trim() : cur.name,
    phone: 有("phone") ? (取值("phone") || "").trim() : cur.phone,
    school: 文本("school", cur.school),
    grade: 有("grade") ? 取值("grade") || null : cur.grade,
    major: 文本("major", cur.major),
    followStatus: 有("followStatus") ? 取值("followStatus")! : cur.followStatus,
    decisionStatus: 有("decisionStatus") ? 取值("decisionStatus")! : cur.decisionStatus,
    expectedSignAt: 有("expectedSignAt") ? (取值("expectedSignAt") ? new Date(取值("expectedSignAt")!) : null) : cur.expectedSignAt,
    remark: 文本("remark", cur.remark),
    salesOwnerId,
    channelId,
    referrerCustomerId,
    ...(channelOwnerId !== undefined ? { channelOwnerId } : {}),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * 改渠道。走 saveChannel，重名检查和留痕都在那里面。
 *
 * 改渠道负责人会影响这条推荐链上**所有**学员的归属统计（Customer.channelOwnerId
 * 是冗余存储的），所以这张卡的抬头要说清改的是渠道而不是某一位学员。
 */
async function 改渠道(p: { channelName: string; ownerName: string; phone: string; remark: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const hit = await prisma.channel.findMany({ where: { name: p.channelName.trim() }, select: { id: true, name: true, phone: true, remark: true, channelOwnerId: true } });
  if (hit.length === 0) return { ok: false, error: `没有叫「${p.channelName}」的渠道` };
  if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 个渠道都叫「${p.channelName}」，请到渠道页手动指定` };
  const ch = hit[0];

  let channelOwnerId = ch.channelOwnerId;
  if (p.ownerName.trim()) {
    const us = await prisma.user.findMany({ where: { name: p.ownerName.trim(), ...可担任负责人 }, select: { id: true } });
    if (us.length === 0) return { ok: false, error: `没有叫「${p.ownerName}」的在职销售` };
    if (us.length > 1) return { ok: false, error: `有 ${us.length} 位同事都叫「${p.ownerName}」，请到渠道页手动指定` };
    channelOwnerId = us[0].id;
  }

  const r = await saveChannel({
    id: ch.id,
    name: ch.name,
    phone: p.phone.trim() || ch.phone,
    remark: p.remark.trim() || ch.remark,
    channelOwnerId,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function applyProposal(input: Proposal): Promise<ApplyResult> {
  const me = await requireUser();
  const b = await getBusiness();

  // 新建线索不挂在任何客户下，其余三种都必须指到一个还在的客户
  let c = { id: "", name: "" };
  if (input?.kind !== "add_lead" && input?.kind !== "update_channel") {
    const found = await prisma.customer.findUnique({ where: { id: String(input?.customerId ?? "") }, select: { id: true, name: true } });
    if (!found) return { ok: false, error: `这条${b.customer}已被删除` };
    c = found;
  }

  // 人改过的值和模型给的值一样不可信，重新校验一遍
  const checked = buildProposal(input.id, input.kind, c, input as unknown as Record<string, unknown>, b);
  if (!checked.ok) return { ok: false, error: checked.error };
  const p = checked.proposal;

  // 前端禁用按钮不算防线：必填项没填齐就不写
  const miss = missingFields(p);
  if (miss.length) return { ok: false, error: `还差${miss.join("、")}，填好再确认` };

  let done: { ok: true } | { ok: false; error: string };
  if (p.kind === "update_customer") {
    done = await 改档案(p.customerId, p.changes);
  } else if (p.kind === "add_opportunity") {
    const r = await saveOpportunity({
      name: p.name || `${c.name} 的商机`,
      customerId: p.customerId,
      amount: p.amount,
      stage: p.stage,
      status: "OPEN",
      probability: p.probability,
      expectedDealAt: p.expectedDealAt || null,
      remark: p.remark || null,
      // 商机负责人跟着客户的销售负责人走，不另外问——问了也只会填成同一个人
      ownerId: (await prisma.customer.findUnique({ where: { id: p.customerId }, select: { salesOwnerId: true } }))!.salesOwnerId,
    });
    done = r.ok ? { ok: true } : { ok: false, error: r.error };
  } else if (p.kind === "add_contract") {
    const r = await saveContract({
      customerId: p.customerId,
      amount: p.amount,
      signedAt: new Date(p.signedAt),
      remark: p.remark || null,
    });
    done = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "签约没能保存" };
  } else if (p.kind === "update_channel") {
    done = await 改渠道(p);
  } else if (p.kind === "set_status") {
    done = await patchCustomer(p.customerId, p.field, p.to);
  } else if (p.kind === "add_followup") {
    const r = await saveFollowUp({
      customerId: p.customerId,
      type: p.type,
      title: p.title || null,
      content: p.content,
      status: "已完成",
      occurredAt: p.occurredAt,
    });
    done = r.ok ? { ok: true } : { ok: false, error: r.error };
  } else if (p.kind === "add_plan") {
    const r = await savePlan({ customerId: p.customerId, subject: p.subject, plannedAt: p.plannedAt, method: p.method });
    done = r.ok ? { ok: true } : { ok: false, error: "计划没能保存" };
  } else {
    const r = await saveLead({ name: p.name, contact: p.contact || null, phone: p.phone || null, source: p.source, status: p.status, remark: p.remark || null });
    done = r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (!done.ok) return done;

  const summary = summarizeApplied(p, b.customer);
  await recordAudit({ user: me, action: "ai_apply", entity: "Ai", entityId: p.kind, summary, detail: { 对象: c.name || p.customerName, 理由: p.reason } });
  return { ok: true, message: summary.replace("确认 AI 建议：", "已") };
}
