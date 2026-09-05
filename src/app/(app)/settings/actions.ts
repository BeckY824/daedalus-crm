"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { ROLES } from "@/lib/constants";
import { recordAudit } from "@/lib/audit";
import { saveLlmConfig, clearLlmConfig, resolveLlmConfigForTest, testLlm } from "@/lib/llm";
import { getBusiness, saveBusiness, mergeBusiness, type BusinessConfig } from "@/lib/business";

/** 密码最短长度。界面上有校验，但接口直调能绕开，空密码会让任何人登进来 */
const MIN_PASSWORD = 8;

/**
 * 登录用户名的格式。**这个字段存的是登录名，不是邮箱**——
 * 界面上填什么、登录页就用什么登，既有账号是 admin / zhangsan / lisi。
 * 登录时会 toLowerCase 后比对，所以这里只收小写，避免填了 LiSi 却登不进去。
 */
const 用户名格式 = /^[a-z0-9._-]{2,32}$/;

/** 命中同名在职成员时回传，供界面弹窗让人确认 */
export type NameDuplicate = { name: string; email: string; title: string };

async function requireAdmin() {
  const me = await requireUser();
  if (me.role !== "ADMIN") throw new Error("FORBIDDEN");
  return me;
}

/**
 * 拦住「把最后一个管理员弄没」的操作。
 *
 * 停用自己、或把自己降成销售，在只剩一个管理员时会让整个系统再也没人能管成员、
 * 改角色、做数据转交——只能改库才能救回来。这类操作界面上完全允许，
 * 而且做完当场看不出问题，下次要加人时才发现。
 */
async function wouldLoseLastAdmin(targetId: string): Promise<boolean> {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true, active: true } });
  if (!target || target.role !== "ADMIN" || !target.active) return false;
  const others = await prisma.user.count({
    where: { id: { not: targetId }, role: "ADMIN", active: true },
  });
  return others === 0;
}

export async function saveUser(input: {
  id?: string;
  name: string;
  email: string;
  title: string;
  role: string;
  password?: string | null;
  active: boolean;
  /** 用户已在弹窗里确认「确实是另一个人」 */
  force?: boolean;
}): Promise<
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; duplicateName: NameDuplicate }
> {
  const me = await requireAdmin();

  if (!ROLES.some((r) => r.value === input.role)) {
    return { ok: false as const, error: `角色「${input.role}」不是合法取值` };
  }
  const 登录名 = input.email.trim().toLowerCase();
  if (!用户名格式.test(登录名)) {
    return {
      ok: false as const,
      error: "登录用户名只能用小写字母、数字和 . _ -，长度 2–32 位",
    };
  }
  if (input.password && input.password.length < MIN_PASSWORD) {
    return { ok: false as const, error: `密码至少 ${MIN_PASSWORD} 位` };
  }
  if (input.id && (input.role !== "ADMIN" || !input.active) && (await wouldLoseLastAdmin(input.id))) {
    return {
      ok: false as const,
      error: "这是系统里最后一个管理员，不能停用或降级，否则将无人可以管理成员。请先指定另一位管理员。",
    };
  }
  /**
   * 停用必须走「停用并转交」，不能在编辑框里勾掉。
   * 直接勾掉的话名下学员、商机、待办全留在一个已停用的人名下，
   * 而各处下拉只列在职成员，这些数据的负责人就变成一个选不出来的空值。
   */
  if (input.id && !input.active) {
    const before = await prisma.user.findUnique({ where: { id: input.id }, select: { active: true } });
    if (before?.active) {
      return { ok: false as const, error: "请使用「停用」按钮，停用时需要指定名下数据转交给谁" };
    }
  }

  /**
   * 同名成员不硬拦——同名同事在真实团队里很正常，拦下来管理员就建不了人。
   * 但重名之后各处负责人下拉会出现两个一样的选项，所以要确认一次；
   * 确认过就照建，下拉那边会自动把登录名带出来做区分。
   */
  if (!input.force) {
    const 同名 = await prisma.user.findFirst({
      where: {
        name: input.name.trim(),
        active: true,
        ...(input.id ? { id: { not: input.id } } : {}),
      },
      select: { name: true, email: true, title: true },
    });
    if (同名) return { ok: false as const, duplicateName: 同名 };
  }

  const base = {
    name: input.name.trim(),
    email: 登录名,
    title: input.title,
    role: input.role,
    active: input.active,
  };

  if (input.id) {
    await prisma.user.update({
      where: { id: input.id },
      data: input.password
        ? { ...base, password: await bcrypt.hash(input.password, 10) }
        : base,
    });
  } else {
    if (!input.password) return { ok: false as const, error: "新成员必须设置初始密码" };
    const exists = await prisma.user.findUnique({ where: { email: base.email } });
    if (exists) return { ok: false as const, error: "该登录用户名已被占用" };
    await prisma.user.create({
      data: { ...base, password: await bcrypt.hash(input.password, 10) },
    });
  }

  await recordAudit({
    user: me, action: input.id ? "update" : "create", entity: "User", entityId: input.id ?? null,
    summary: `${input.id ? "修改" : "新建"}成员「${base.name}」（${base.role}）` +
      (input.password ? "，并重置了密码" : "") +
      (input.force ? "（已确认与既有同名成员不是同一人）" : ""),
    detail: { name: base.name, email: base.email, role: base.role, active: base.active },
  });

  revalidatePath("/settings");
  return { ok: true as const };
}

/** 停用成员前先把名下数据转交他人 */
export async function deactivateUser(id: string, transferToId: string) {
  const me = await requireAdmin();
  if (id === transferToId) return { ok: false as const, error: "不能转交给自己" };

  const receiver = await prisma.user.findUnique({
    where: { id: transferToId },
    select: { active: true },
  });
  // 转交给一个已停用的人等于把数据丢进黑洞：各处下拉只列在职成员，之后谁都选不到
  if (!receiver?.active) {
    return { ok: false as const, error: "接收人不存在或已停用，请选择一位在职成员" };
  }
  if (await wouldLoseLastAdmin(id)) {
    return {
      ok: false as const,
      error: "这是系统里最后一个管理员，停用后将无人可以管理成员。请先指定另一位管理员。",
    };
  }

  await prisma.$transaction([
    prisma.customer.updateMany({ where: { salesOwnerId: id }, data: { salesOwnerId: transferToId } }),
    prisma.opportunity.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.task.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.followPlan.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    /**
     * 这两类原本漏了转交：
     *   线索      —— 留在停用的人名下，列表按负责人筛选时谁都看不到，等于丢了
     *   渠道负责人 —— Channel.channelOwnerId 还指着停用的人，
     *                之后这个渠道新带来的学员会继续算到一个离职的人头上
     * 学员身上冗余的 channelOwnerId 也要跟着改，否则筛选统计对不上。
     */
    prisma.lead.updateMany({ where: { ownerId: id }, data: { ownerId: transferToId } }),
    prisma.channel.updateMany({ where: { channelOwnerId: id }, data: { channelOwnerId: transferToId } }),
    prisma.customer.updateMany({ where: { channelOwnerId: id }, data: { channelOwnerId: transferToId } }),
    prisma.user.update({ where: { id }, data: { active: false } }),
  ]);

  const [被停, 接手] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: transferToId }, select: { name: true } }),
  ]);
  await recordAudit({
    user: me, action: "deactivate", entity: "User", entityId: id,
    summary: `停用成员「${被停?.name ?? id}」，名下数据转交给「${接手?.name ?? transferToId}」`,
    detail: { userId: id, transferToId },
  });

  revalidatePath("/settings");
  revalidatePath("/customers");
  revalidatePath("/leads");
  revalidatePath("/channels");
  return { ok: true as const };
}

export async function reactivateUser(id: string) {
  const me = await requireAdmin();
  const u = await prisma.user.update({ where: { id }, data: { active: true } });
  await recordAudit({
    user: me, action: "reactivate", entity: "User", entityId: id,
    summary: `恢复成员「${u.name}」`,
  });
  revalidatePath("/settings");
  return { ok: true as const };
}

/** 任何人都可以改自己的密码 */
export async function changeMyPassword(oldPwd: string, newPwd: string) {
  const me = await requireUser();
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) return { ok: false as const, error: "用户不存在" };
  if (!(await bcrypt.compare(oldPwd, user.password))) {
    return { ok: false as const, error: "原密码错误" };
  }
  // 界面上有长度校验，但接口直调能绕开——空密码会让任何人用这个账号登进来
  if (!newPwd || newPwd.length < MIN_PASSWORD) {
    return { ok: false as const, error: `新密码至少 ${MIN_PASSWORD} 位` };
  }
  if (newPwd === oldPwd) {
    return { ok: false as const, error: "新密码不能与原密码相同" };
  }
  await prisma.user.update({
    where: { id: me.id },
    data: { password: await bcrypt.hash(newPwd, 10) },
  });
  // 只记「改过密码」这件事，不记任何密码内容
  await recordAudit({
    user: me, action: "password", entity: "User", entityId: me.id,
    summary: `${me.name} 修改了自己的登录密码`,
  });
  return { ok: true as const };
}

/* ---------- AI 接入 ---------- */

/**
 * 保存 AI 接入配置。只有管理员能改；日志只记"改了"，不记任何值——
 * 地址与模型名无所谓，但同一条日志里不能出现 key，哪怕是尾号。
 */
export async function saveLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null }) {
  const me = await requireAdmin();
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  }
  if (!input.model.trim()) return { ok: false as const, error: "请填写模型名" };
  await saveLlmConfig(input);
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "修改了 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function clearLlmSettings() {
  const me = await requireAdmin();
  await clearLlmConfig();
  await recordAudit({ user: me, action: "update", entity: "Setting", entityId: "llm", summary: "清除了界面里的 AI 接入配置" });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

/** 用表单里当前填的值发一次最小请求；key 留空则用已保存的 */
export async function testLlmSettings(input: { baseUrl: string; model: string; apiKey?: string | null }) {
  await requireAdmin();
  if (!/^https?:\/\//.test(input.baseUrl.trim())) {
    return { ok: false as const, error: "接口地址要以 http:// 或 https:// 开头" };
  }
  const cfg = await resolveLlmConfigForTest(input);
  if (!cfg) return { ok: false as const, error: "还没有 API Key：请先填写" };
  return testLlm(cfg);
}

/* ---------- 业务配置 ---------- */

export async function saveBusinessSettings(cfg: BusinessConfig) {
  const me = await requireAdmin();
  const merged = mergeBusiness(cfg);
  if (merged.customer.length > 6) return { ok: false as const, error: "核心名词请控制在 6 个字以内，它会出现在表头和按钮上" };
  if (merged.brief.length > 500) return { ok: false as const, error: "业务简介请控制在 500 字以内" };
  const before = await getBusiness();
  await saveBusiness(merged);
  const changed = (Object.keys(merged) as (keyof BusinessConfig)[]).filter(
    (k) => JSON.stringify(merged[k]) !== JSON.stringify(before[k]),
  );
  await recordAudit({
    user: me, action: "update", entity: "Setting", entityId: "business",
    summary: `修改了业务配置：${changed.length ? changed.map((k) => BUSINESS_FIELD_LABELS[k]).join("、") : "无实际变化"}`,
    detail: Object.fromEntries(changed.map((k) => [BUSINESS_FIELD_LABELS[k], { 改前: before[k], 改后: merged[k] }])),
  });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

const BUSINESS_FIELD_LABELS: Record<keyof BusinessConfig, string> = {
  brief: "业务简介", customer: "核心名词", fields: "档案字段名", grades: "年级选项", sources: "线索来源", industries: "行业选项",
};
