"use server";

import { headers } from "next/headers";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { control } from "@/lib/tenant/control";
import { createWorkspace, TRIAL_DAYS } from "@/lib/tenant/workspaces";
import { codeVisibleToClient, sendCode } from "@/lib/tenant/notify";
import {
  checkPassword,
  consumeCode,
  createAccount,
  findAccountByTarget,
  issueCode,
  parseTarget,
} from "@/lib/tenant/accounts";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值 } from "@/lib/rate-limit";

/**
 * 注册：手机号（或邮箱）+ 验证码 + 密码 + 团队名 → 开一个工作区，试用 7 天。
 *
 * 只在托管版可用。自部署版没有"注册"这回事——那里是管理员建账号。
 *
 * **配了 SIGNUP_REDIRECT 就等于关闭自助注册**：页面跳去咨询页，这里的两个动作
 * 一律拒绝。留着而不是删掉，是因为关闭注册是个阶段性决定——没有发码通道
 * （短信要备案、邮件还没接）时走人工开号，通道通了把这个变量去掉就回来了。
 * 只跳页面不拦动作是不够的：Server Action 是独立端点，绕过页面直接调得到。
 */
function 自助注册已关闭(): boolean {
  return Boolean(process.env.SIGNUP_REDIRECT?.trim());
}

export type SendCodeResult = { ok: true; hint?: string } | { ok: false; error: string };
export type SignupResult = { ok: true } | { ok: false; error: string };

async function ip(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

function 未开放(): { ok: false; error: string } {
  return { ok: false, error: "这个部署没有开放注册" };
}

export async function requestCode(targetRaw: string): Promise<SendCodeResult> {
  if (!multiTenant() || 自助注册已关闭()) return 未开放();
  const t = parseTarget(targetRaw);
  if (!t) return { ok: false, error: "请填写正确的手机号或邮箱" };

  // 按 IP 限流：发码是唯一一个未登录就能触发外部计费动作的接口，不限会被薅
  const from = await ip();
  if (from) {
    const 还要等 = 检查限流(`code:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    记一次失败(`code:${from}`, Date.now(), IP阈值);
  }

  if (await findAccountByTarget(t.value)) {
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  const r = await issueCode(t.value, "signup");
  if (!r.ok) return r;
  const sent = await sendCode(t.value, r.code);
  if (!sent.ok) return { ok: false, error: sent.error };
  // 开发环境把码直接给回去，省得翻日志；线上永远不回显
  return { ok: true, hint: codeVisibleToClient() ? `开发环境验证码：${r.code}` : undefined };
}

export async function signup(input: {
  target: string;
  code: string;
  password: string;
  name: string;
  workspace: string;
}): Promise<SignupResult> {
  if (!multiTenant() || 自助注册已关闭()) return 未开放();

  const t = parseTarget(input.target);
  if (!t) return { ok: false, error: "请填写正确的手机号或邮箱" };
  if (!input.name.trim()) return { ok: false, error: "请填写你的姓名" };
  if (!input.workspace.trim()) return { ok: false, error: "请填写团队名称" };
  const pwErr = checkPassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };

  const codeOk = await consumeCode(t.value, input.code, "signup");
  if (!codeOk.ok) return codeOk;

  // 验证码校验通过到建账号之间还有一个窗口，同一个号并发注册会撞唯一索引，
  // 交给数据库判，不自己抢
  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经注册过了，直接登录吧" };

  let account;
  try {
    account = await createAccount({ target: t, password: input.password, name: input.name });
  } catch {
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  try {
    const ws = await createWorkspace({ name: input.workspace, account });
    await createSession(account.id, ws.id);
    return { ok: true };
  } catch (e) {
    // 工作区没开成，账号留着也没用，清掉免得这个号再也注册不了
    await control.account.delete({ where: { id: account.id } }).catch(() => {});
    console.error("开工作区失败：", e);
    return { ok: false, error: "开通失败，请稍后重试" };
  }
}

export async function trialDays(): Promise<number> {
  return TRIAL_DAYS;
}
