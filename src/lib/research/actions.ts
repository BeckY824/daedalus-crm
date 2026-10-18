"use server";

/**
 * 背调卡上那几个按钮背后的动作。**AI 不自己写库**（10-14 用户定：增删改查不靠 AI），
 * 这里每一个都是人点了按钮才调。
 *
 *   背调价目        开跑前问一句：这台机器能不能背调、扣几次、还剩几次（确认卡上那句「背调要 60 次，你还剩 N 次」）
 *   存背调到客户    存成那位客户时间线上的一条「其他记录」，标题以「背调｜」开头，正文是整份报告 + 来源链接
 *   新建客户并存背调 公司还不在 CRM 里：按查到的名字 / 国家 / 联系方式建档，再存报告
 *   找同名客户      「存进客户」先看看库里是不是已经有这家，有就让人选，不自己猜着合并
 *   最近背调        客户详情页那块「背调」：最近一次的标题、时间、正文
 *   认号码动作      只有人名 + 电话时，开跑前在本机判号码（哪国、手机还是固话）：不联网、不花钱、不扣次数
 *
 * 为什么存成跟进记录而不是新开一张表：跟进记录团队版本来就同步，老版本的同事那边也照样显示
 * （「其他记录」类型）；新开一张表要改同步协议、要等所有人升级。
 * 报告正文由这里按状态重新生成（report.ts），不收浏览器交上来的文字。
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "../auth";
import { prisma } from "../prisma";
import { saveFollowUp } from "@/app/(app)/customers/[id]/actions";
import { saveCustomer } from "@/app/(app)/customers/actions";
import { 选通道 } from "./channel";
import { 认背调状态 } from "./state";
import { 报告文本, 背调标题, 背调标题前缀 } from "./report";
import { 认号码, type 号码信息 } from "./person";

export async function 背调价目(): Promise<{ 可用: true; 扣次: number; 还剩: number | null; 模拟: boolean } | { 可用: false; 原因: string }> {
  await requireUser();
  const r = await 选通道();
  if (!r.ok) return { 可用: false, 原因: r.error };
  // 扣几次、还剩几次都问服务器（扣几次是服务器的配置，改价不用等发版）。自己填了 Key 的也照扣，所以不看本机的计次
  try {
    const p = await r.通道.价目();
    return { 可用: true, 扣次: p.扣次, 还剩: p.还剩, 模拟: r.通道.名 === "模拟" };
  } catch (e) {
    return { 可用: false, 原因: e instanceof Error ? e.message : "问不到背调的价目，稍后再试" };
  }
}

export async function 认号码动作(电话: string): Promise<号码信息 | null> {
  await requireUser();
  return typeof 电话 === "string" ? 认号码(电话.slice(0, 40)) : null;
}

export async function 存背调到客户(customerId: string, 状态原始: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await requireUser();
  const s = 认背调状态(状态原始);
  if (!s || !s.done) return { ok: false, error: "这份背调还没跑完，等它跑完再存" };
  if (typeof customerId !== "string" || !customerId) return { ok: false, error: "要存到哪位客户？" };
  const r = await saveFollowUp({
    customerId,
    type: "OTHER",
    title: 背调标题(s).slice(0, 120),
    content: 报告文本(s),
    status: "已完成",
    occurredAt: new Date().toISOString(),
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/customers/${customerId}`);
  return { ok: true, id: customerId };
}

/** 查到的「公开联系方式」那一格里认出邮箱和电话；认不出就空着，人在表单里补 */
export async function 认联系方式(s: string | undefined): Promise<{ email: string; phone: string }> {
  const t = s ?? "";
  const email = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  const phone = t.match(/\+?\d[\d\s()-]{6,}\d/)?.[0]?.replace(/[\s()-]/g, "") ?? "";
  return { email, phone };
}

export async function 新建客户并存背调(
  input: { name: string; country?: string; email?: string; phone?: string },
  状态原始: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireUser();
  const s = 认背调状态(状态原始);
  if (!s || !s.done) return { ok: false, error: "这份背调还没跑完，等它跑完再存" };
  const 官网 = s.fields.site?.value;
  // 「德国·汉堡」「Germany, Hamburg」只要国家那一截；国家的规整（中文名）交给 saveCustomer 里的 认国家
  const 国家 = (input.country ?? s.fields.country?.value ?? "").split(/[·,，、/]/)[0].trim();
  const 建 = await saveCustomer({
    name: (input.name || s.目标.name).trim(),
    phone: (input.phone ?? "").trim(),
    school: null,
    grade: null,
    major: null,
    followStatus: "待跟进",
    decisionStatus: "了解中",
    expectedSignAt: null,
    remark: 官网 ? `官网 ${官网}` : null,
    // 谁背调的归谁：和人在表单里新建时默认选自己一样（团队版里不会挂到别人名下）
    salesOwnerId: me.id,
    channelId: null,
    referrerCustomerId: null,
    extra: { country: 国家 || null, email: (input.email ?? "").trim() || null, source: "AI 背调" },
  });
  if (!建.ok) return { ok: false, error: 建.error };
  const 存 = await 存背调到客户(建.id, s);
  return 存.ok ? { ok: true, id: 建.id } : { ok: false, error: `客户建好了，但报告没存上：${存.error}` };
}

/** 名字像的前 5 位（包含关系，不分大小写）。看不到的人本来就查不到（prisma 按当前用户限定） */
export async function 找同名客户(name: string): Promise<{ id: string; name: string }[]> {
  await requireUser();
  const 词 = (name ?? "").trim().replace(/\s+(gmbh|ltd|limited|inc|llc|co\.?|corp\.?|s\.?a\.?|b\.?v\.?|ag|plc)\.?$/i, "").slice(0, 60);
  if (词.length < 2) return [];
  return prisma.customer.findMany({ where: { name: { contains: 词 } }, select: { id: true, name: true }, take: 5, orderBy: { updatedAt: "desc" } });
}

export async function 最近背调(customerId: string): Promise<{ id: string; title: string; content: string; at: string } | null> {
  await requireUser();
  const f = await prisma.followUp.findFirst({
    where: { customerId, type: "OTHER", title: { startsWith: 背调标题前缀 } },
    orderBy: { occurredAt: "desc" },
    select: { id: true, title: true, content: true, occurredAt: true },
  });
  return f ? { id: f.id, title: f.title, content: f.content, at: f.occurredAt.toISOString() } : null;
}
