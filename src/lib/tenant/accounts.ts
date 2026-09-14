import bcrypt from "bcryptjs";
import { control } from "./control";

/**
 * 托管版的账号：注册、登录、验证码。
 *
 * 和业务库里的 User 是两回事：Account 是「一个真人」，可以属于多个工作区；
 * User 是「这个人在某个工作区里的身份」，带角色和业绩归属。登录校验只看 Account，
 * 业务库里那条 User 的 password 字段存的是不可用的占位符，防止有人绕开控制面登进去。
 */

/** 验证码有效期与尝试上限。短到够用、长到能收到短信 */
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** 同一目标两次发码的最小间隔，防刷 */
const RESEND_MS = 60 * 1000;

export type AccountView = { id: string; name: string; phone: string | null; email: string | null };

export function normalizePhone(v: string): string {
  return v.replace(/[\s-]/g, "").trim();
}

/** 只认中国大陆手机号。放宽格式等于给刷码留口子 */
export function isPhone(v: string): boolean {
  return /^1[3-9]\d{9}$/.test(normalizePhone(v));
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/**
 * 常见的一次性邮箱域名。注册送 AI 次数之后，临时邮箱就是最省事的刷号入口。
 * 不求全——求全的名单有几千行且天天变；挡住最顺手的那几个就够让人换个办法。
 */
const 临时邮箱域名 = new Set([
  "10minutemail.com", "guerrillamail.com", "guerrillamail.net", "mailinator.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "throwawaymail.com", "getnada.com", "dispostable.com", "trashmail.com", "sharklasers.com",
  "maildrop.cc", "fakeinbox.com", "mohmal.com", "linshiyouxiang.net", "24mail.chacuo.net", "bccto.me",
]);
export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return 临时邮箱域名.has(domain);
}

/** 登录标识：手机号或邮箱，两者都不像就拒 */
export function parseTarget(v: string): { kind: "phone" | "email"; value: string } | null {
  const t = v.trim();
  if (isPhone(t)) return { kind: "phone", value: normalizePhone(t) };
  if (isEmail(t)) return { kind: "email", value: t.toLowerCase() };
  return null;
}

export function checkPassword(v: string): string | null {
  if (v.length < 8) return "密码至少 8 位";
  if (v.length > 72) return "密码太长了";
  // bcrypt 只看前 72 字节，更长的部分被静默忽略，会让人误以为设了很强的密码
  if (!/[a-zA-Z]/.test(v) || !/\d/.test(v)) return "密码要同时含字母和数字";
  return null;
}

/**
 * 生成并存一个验证码。返回码本身，由调用方决定怎么送出去（短信 / 邮件 / 开发期直接打印）。
 * 频繁请求直接拒，不给爆破和短信轰炸留口子。
 */
export async function issueCode(target: string, purpose = "signup"): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const recent = await control.verifyCode.findFirst({
    where: { target, purpose, createdAt: { gt: new Date(Date.now() - RESEND_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) return { ok: false, error: "刚发过了，请稍后再试" };

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await control.verifyCode.create({
    data: { target, code, purpose, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return { ok: true, code };
}

/**
 * 校验验证码。成功即作废，失败累计次数，超限后这一条直接失效。
 * 一次性使用很重要：否则一个码在有效期内能反复用来注册或改密码。
 */
export async function consumeCode(target: string, code: string, purpose = "signup"): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await control.verifyCode.findFirst({
    where: { target, purpose, usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { ok: false, error: "请先获取验证码" };
  if (row.expiresAt < new Date()) return { ok: false, error: "验证码已过期，请重新获取" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "尝试次数过多，请重新获取验证码" };
  if (row.code !== code.trim()) {
    await control.verifyCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: "验证码不对" };
  }
  await control.verifyCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return { ok: true };
}

export async function findAccountByTarget(target: string) {
  const t = parseTarget(target);
  if (!t) return null;
  return control.account.findFirst({
    where: t.kind === "phone" ? { phone: t.value } : { email: t.value },
  });
}

export async function createAccount(input: {
  target: { kind: "phone" | "email"; value: string };
  password: string;
  name: string;
}): Promise<AccountView> {
  const hash = await bcrypt.hash(input.password, 10);
  const a = await control.account.create({
    data: {
      phone: input.target.kind === "phone" ? input.target.value : null,
      email: input.target.kind === "email" ? input.target.value : null,
      password: hash,
      name: input.name.trim().slice(0, 20),
    },
  });
  return { id: a.id, name: a.name, phone: a.phone, email: a.email };
}

/** 校验账号密码。账号不存在与密码错给同一个提示，不泄露某个号是否注册过 */
export async function verifyAccount(target: string, password: string): Promise<AccountView | null> {
  const a = await findAccountByTarget(target);
  if (!a || !a.active) return null;
  const ok = await bcrypt.compare(password, a.password);
  if (!ok) return null;
  await control.account.update({ where: { id: a.id }, data: { lastLoginAt: new Date() } });
  return { id: a.id, name: a.name, phone: a.phone, email: a.email };
}

/**
 * 改密码。找回密码走这里，将来「设置里改密码」也走这里。
 *
 * 只改控制面的 Account——业务库里那条 User.password 存的是不可用的占位符，
 * 登录校验根本不看它，跟着改反而会让人以为那边也是一把真钥匙。
 *
 * 作废旧会话是调用方的事（见 lib/tenant/session-cutoff.ts）：
 * 那一步要写另一张表，放在这里会让「桌面端改密码」这类还没有会话的调用方
 * 平白依赖一套会话机制。
 */
export async function updatePassword(accountId: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  await control.account.update({ where: { id: accountId }, data: { password: hash } });
}
