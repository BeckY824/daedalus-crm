"use server";

import { scheduleValue } from "@/lib/schedule-date";

import { 读现值 } from "@/lib/agent/current-values";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { 认回打码号 } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { recordAudit } from "@/lib/audit";
import { buildProposal, missingFields, summarizeApplied, 可改字段表, type Proposal, type 一处改动 } from "@/lib/agent/proposals";
import { statusLabel, type BusinessConfig } from "@/lib/business-config";
import { patchCustomer, saveCustomer, saveContract } from "../customers/actions";
import { saveFollowUp, savePlan, deleteFollowUp } from "../customers/[id]/actions";
import { saveLead } from "../leads/actions";
import { saveOpportunity } from "../opportunities/actions";
import { saveChannel } from "../channels/actions";
import { 按名字找负责人 } from "@/lib/owners";

/**
 * 确认之后怎么撤回去。只给能**干净还原**的两种：记了一条跟进（删掉它）、改了一个状态（改回原值）。
 * 别的几种撤回会牵连别处——签约会顺手把客户改成「已签约」，排计划会顶掉原来那条计划，
 * 删掉新建的商机或线索前还可能已经被人接着改过——这些要各自想清楚再开，不在这里凑合。
 */
export type 撤销凭据 =
  | { kind: "add_followup"; customerId: string; id: string }
  /**
   * to = 改回去的原值；改成 = 卡片当时改成的值（2026-10-04 J-172）。
   * 撤销前拿它和库里现在的值比：不一样就是确认之后有人（同事或自己）又改过，撤销不能盖掉那次改动
   */
  | { kind: "set_status"; customerId: string; field: "followStatus" | "decisionStatus"; to: string; 改成: string };

export type ApplyResult = { ok: true; message: string; 撤销?: 撤销凭据 } | { ok: false; error: string };

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
    const hit = await 按名字找负责人(n);
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
  /*
    推荐人和渠道是两档，和表单一样互斥（lib/referrer-kind.ts）：
      改成某位推荐人 → 渠道交给推荐链去推（channelId 是链顶继承的派生值），不能带着原来的渠道一起交
      改成某个渠道   → 推荐人清空，算渠道直荐
    原来两个都原样带着：推荐人记成了 X，归属却还按原来的渠道算（2026-10-01 排查 A6）。两样都给了，以推荐人为准。
  */
  if (有("referrerName") && referrerCustomerId) channelId = null;
  else if (有("channelName") && channelId) referrerCustomerId = null;

  // 渠道负责人：给了名字就钉死为这个人；给空字符串 = 清掉手工值、恢复按推荐链；没提这个字段 = 不碰
  let channelOwnerId: string | null | undefined = undefined;
  if (有("channelOwnerName")) {
    const n = (取值("channelOwnerName") ?? "").trim();
    if (!n) channelOwnerId = null;
    else {
      const hit = await 按名字找负责人(n);
      if (hit.length === 0) return { ok: false, error: `没有叫「${n}」的在职销售` };
      if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 位同事都叫「${n}」，请到档案页手动指定` };
      channelOwnerId = hit[0].id;
    }
  }

  const 文本 = (f: string, 原: string | null) => (有(f) ? (取值(f) || "").trim() || null : 原);
  const 快照 = {
    name: cur.name, phone: cur.phone, school: cur.school, grade: cur.grade, major: cur.major,
    followStatus: cur.followStatus, decisionStatus: cur.decisionStatus,
    expectedSignAt: scheduleValue(cur.expectedSignAt, cur.expectedSignOn), remark: cur.remark,
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
    expectedSignAt: 有("expectedSignAt") ? 取值("expectedSignAt") ?? null : scheduleValue(cur.expectedSignAt, cur.expectedSignOn),
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
 * 改渠道负责人**只影响之后新来的学员**，已有学员的归属不追溯改写（09 月拍板「归属固化」）。
 * 卡片抬头仍要说清改的是渠道而不是某一位学员。
 */
async function 改渠道(p: { channelName: string; ownerName: string; phone: string; remark: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const hit = await prisma.channel.findMany({ where: { name: p.channelName.trim() }, select: { id: true, name: true, phone: true, remark: true, channelOwnerId: true } });
  if (hit.length === 0) return { ok: false, error: `没有叫「${p.channelName}」的渠道` };
  if (hit.length > 1) return { ok: false, error: `有 ${hit.length} 个渠道都叫「${p.channelName}」，请到渠道页手动指定` };
  const ch = hit[0];

  let channelOwnerId = ch.channelOwnerId;
  if (p.ownerName.trim()) {
    const us = await 按名字找负责人(p.ownerName);
    if (us.length === 0) return { ok: false, error: `没有叫「${p.ownerName}」的在职销售` };
    if (us.length > 1) return { ok: false, error: `有 ${us.length} 位同事都叫「${p.ownerName}」，请到渠道页手动指定` };
    channelOwnerId = us[0].id;
  }

  const r = await saveChannel({
    id: ch.id,
    name: ch.name,
    // 卡上的现值是打过码的（共享试用区）：交回来的若正是原号打码的样子，认回原号，不把星号写进库
    phone: 认回打码号(p.phone.trim(), ch.phone) || ch.phone,
    remark: p.remark.trim() || ch.remark,
    channelOwnerId,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 「这张卡出来之后有人改过」那句话里用：字段怎么叫、值怎么显示（状态按设置里改过的显示名） */
function 字段名(f: string, b: BusinessConfig): string {
  if (f === "followStatus") return "跟进状态";
  if (f === "decisionStatus") return "决策状态";
  return (可改字段表(b) as Record<string, { label: string }>)[f]?.label ?? f;
}
function 显示值(f: string, v: string, b: BusinessConfig): string {
  return f === "followStatus" || f === "decisionStatus" ? statusLabel(b, v) : v;
}

const 确认过的卡 = new Map<string, number>();
const 卡记多久 = 10 * 60_000;
function 记下确认过(k: string) {
  const now = Date.now();
  if (确认过的卡.size > 2000) for (const [key, t] of 确认过的卡) if (now - t > 卡记多久) 确认过的卡.delete(key);
  确认过的卡.set(k, now);
}
/** 撤销凭据 → 那张卡的占位。撤销成功就把位让出来：撤完卡又回到能确认的样子，再点不该被说「已经确认过了」（第三轮 B7） */
const 凭据对应卡 = new Map<string, string>();
const 凭据键 = (userId: string, u: unknown) => `${userId}:${JSON.stringify(u)}`;

export async function applyProposal(input: Proposal): Promise<ApplyResult> {
  const me = await requireUser();
  /*
    同一张卡确认第二次：不再做一遍（第二轮 AI）。原来只靠前端按钮变灰，网慢时连点、或者刷新后又点一次，
    记跟进卡就记成两条。按「谁 + 卡的内容」认，10 分钟内同样的一张算同一张。
    **一进来就占位**（两次几乎同时到时，后到的那次也看得见），没做成就把位让出来
  */
  const 卡键 = `${me.id}:${JSON.stringify({ ...input, 现值: undefined })}`;
  const 上次 = 确认过的卡.get(卡键);
  if (上次 && Date.now() - 上次 < 卡记多久) return { ok: false, error: "这张卡刚刚已经确认过了，没有再做一次" };
  记下确认过(卡键);
  let r: ApplyResult | undefined;
  try {
    r = await 做这张卡(input, me);
    return r;
  } finally {
    if (!r?.ok) 确认过的卡.delete(卡键);
    else if (r.撤销) {
      if (凭据对应卡.size > 2000) 凭据对应卡.clear();
      凭据对应卡.set(凭据键(me.id, r.撤销), 卡键);
    }
  }
}

async function 做这张卡(input: Proposal, me: Awaited<ReturnType<typeof requireUser>>): Promise<ApplyResult> {
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
  const miss = missingFields(p, b);
  if (miss.length) return { ok: false, error: `还差${miss.join("、")}，填好再确认` };

  /*
    卡片出来之后，要改的那几格有没有被同事改过（2026-10-01 排查 D4）。
    卡上记着生成那一刻的值（现值）；原来落库时拿「此刻库里的值」当基准，于是卡上建议「→ 意向较高」，
    期间同事已经改成「已签约」，一点确认就被改回去，不报冲突。现在比一下：动过就不落库，说清是哪一格。
    现值是前端交回来的，可能被人改过——只用来判断「是不是过时了」，不拿它写库。
  */
  if ((p.kind === "update_customer" || p.kind === "set_status") && input.现值) {
    const 此刻原样 = await 读现值(c.id);
    // 卡上的现值电话是打过码的（共享试用区），比对时这边也按同样的打码比
    const 号 = await 号码脱敏器();
    const 此刻: Record<string, string> | null = 此刻原样 ? { ...此刻原样, phone: 号(此刻原样.phone) } : null;
    const 要改 = p.kind === "set_status" ? [p.field] : p.changes.map((x) => x.field);
    const 动过 = 要改.filter((f) => f in input.现值! && 此刻 && 此刻[f] !== input.现值![f]);
    if (此刻 && 动过.length) {
      const 说 = 动过.map((f) => `「${字段名(f, b)}」已经是「${显示值(f, 此刻[f], b) || "空"}」`).join("，");
      // 不说「有人改过」：桌面端一个人也会撞上（同一轮两张卡都动了同一格，或出卡后自己去档案页改了）
      return { ok: false, error: `这张卡出来之后，${说}。为了不盖掉，这次没保存——重新问一次再确认` };
    }
  }

  /*
    改渠道卡也核对（第二轮 AI A3）：卡上记着电话 / 备注的「现在」，期间人在渠道页刚改过要改的那一格，就不拿卡上的旧判断盖回去
  */
  if (p.kind === "update_channel" && input.现值) {
    const 渠道们 = await prisma.channel.findMany({ where: { name: p.channelName.trim() }, select: { phone: true, remark: true }, take: 2 });
    if (渠道们.length === 1) {
      const 号 = await 号码脱敏器();
      const 此刻 = { phone: 号(渠道们[0].phone ?? ""), remark: 渠道们[0].remark ?? "" };
      const 动过 = (["phone", "remark"] as const).filter((f) => p[f].trim() && f in input.现值! && 此刻[f] !== input.现值![f]);
      if (动过.length) {
        const 说 = 动过.map((f) => `「${f === "phone" ? "电话" : "备注"}」已经是「${此刻[f] || "空"}」`).join("，");
        return { ok: false, error: `这张卡出来之后，${说}。为了不盖掉，这次没保存——重新问一次再确认` };
      }
    }
  }

  let done: { ok: true } | { ok: false; error: string };
  let 撤销: 撤销凭据 | undefined;
  if (p.kind === "update_customer") {
    done = await 改档案(p.customerId, p.changes);
  } else if (p.kind === "add_opportunity") {
    const r = await saveOpportunity({
      name: p.name || `${c.name} 的商机`,
      customerId: p.customerId,
      amount: p.amount,
      // 老建议卡没有币种：不传，saveOpportunity 用本位币
      currency: p.currency || undefined,
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
      currency: p.currency || undefined,
      signedAt: new Date(p.signedAt),
      remark: p.remark || null,
    });
    done = r.ok ? { ok: true } : { ok: false, error: "error" in r ? r.error : "签约没能保存" };
  } else if (p.kind === "update_channel") {
    done = await 改渠道(p);
  } else if (p.kind === "set_status") {
    // 改之前记下原值：撤销就是把它改回去
    const 原 = await prisma.customer.findUnique({ where: { id: p.customerId }, select: { followStatus: true, decisionStatus: true } });
    done = await patchCustomer(p.customerId, p.field, p.to);
    if (done.ok && 原) 撤销 = { kind: "set_status", customerId: p.customerId, field: p.field, to: 原[p.field], 改成: p.to };
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
    if (r.ok) 撤销 = { kind: "add_followup", customerId: p.customerId, id: r.id };
  } else if (p.kind === "add_plan") {
    const r = await savePlan({ customerId: p.customerId, subject: p.subject, plannedAt: p.plannedAt, method: p.method });
    done = r.ok ? { ok: true } : { ok: false, error: "计划没能保存" };
  } else {
    const r = await saveLead({ name: p.name, contact: p.contact || null, phone: p.phone || null, source: p.source, status: p.status, remark: p.remark || null });
    done = r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  if (!done.ok) return done;

  const summary = summarizeApplied(p, b.customer, b);
  await recordAudit({ user: me, action: "ai_apply", entity: "Ai", entityId: p.kind, summary, detail: { 对象: c.name || p.customerName, 理由: p.reason } });
  return { ok: true, message: summary.replace("确认 AI 建议：", "已"), 撤销 };
}

/**
 * 撤回刚确认的那张卡。凭据是前端带回来的，和卡片一样不可信：
 * 只认上面两种形状，而且照样走原有的删除 / 改状态动作——权限、留痕、「最近跟进」重算都在那里面。
 */
export async function undoProposal(u: 撤销凭据): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  const 名 = await prisma.customer.findUnique({ where: { id: String(u?.customerId ?? "") }, select: { name: true } });
  if (!名) return { ok: false, error: "这条记录已被删除，没法撤销" };

  if (u.kind === "add_followup") {
    // 只删这位客户名下的那一条：凭据里的 id 对不上客户就不动
    const f = await prisma.followUp.findFirst({ where: { id: String(u.id), customerId: u.customerId }, select: { id: true } });
    if (!f) return { ok: false, error: "那条跟进已经不在了，可能已被删掉" };
    await deleteFollowUp(f.id, u.customerId);
  } else if (u.kind === "set_status" && (u.field === "followStatus" || u.field === "decisionStatus")) {
    /*
      2026-10-04 J-172：先核对现在还是不是卡片改成的那个值。原来直接写回原值——确认之后同事改成了「已签约」，
      点撤销会悄悄盖回去。凭据里没有「改成」（老凭据 / 被人改过）也一样不动：核对不了就不撤。
    */
    const 现在 = await prisma.customer.findUnique({ where: { id: u.customerId }, select: { followStatus: true, decisionStatus: true } });
    if (typeof u.改成 !== "string" || 现在?.[u.field] !== u.改成) {
      return { ok: false, error: "确认之后又改过，没撤（撤回去会盖掉后来那次改动）" };
    }
    const r = await patchCustomer(u.customerId, u.field, String(u.to ?? ""));
    if (!r.ok) return r;
  } else {
    return { ok: false, error: "这张卡不支持撤销" };
  }
  const 卡 = 凭据对应卡.get(凭据键(me.id, u));
  if (卡) {
    确认过的卡.delete(卡);
    凭据对应卡.delete(凭据键(me.id, u));
  }
  await recordAudit({ user: me, action: "ai_undo", entity: "Ai", entityId: u.kind, summary: `撤销 AI 建议：${名.name}的${u.kind === "add_followup" ? "一条跟进" : "状态改动"}` });
  return { ok: true };
}
