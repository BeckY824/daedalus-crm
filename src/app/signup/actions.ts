"use server";

import { headers } from "next/headers";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { control } from "@/lib/tenant/control";
import { createWorkspace, TRIAL_DAYS } from "@/lib/tenant/workspaces";
import { checkPassword, createAccount, findAccountByTarget, parseTarget } from "@/lib/tenant/accounts";
import { 占用, 释放, 记工作区 } from "@/lib/tenant/activation";
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

export type SignupResult = { ok: true } | { ok: false; error: string };

async function ip(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

function 未开放(): { ok: false; error: string } {
  return { ok: false, error: "这个部署没有开放注册" };
}

/**
 * 注册：团队名 + 姓名 + 手机/邮箱 + **激活码** + 密码 → 开一个工作区。
 *
 * 激活码替代了原来的短信/邮件验证码：码本身就是授权凭证，不需要发码通道。
 * 顺序要紧：**先占码再建号**。占码是原子的（updateMany 只改 usedAt 为空的那行），
 * 两个人同时用同一个码只有一个能成；建号失败就把码还回去，别让人白丢一个。
 */
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

  // 按 IP 限流：激活码是唯一一个未登录就能反复试的入口，不限会被拿来猜码
  const from = await ip();
  if (from) {
    const 还要等 = 检查限流(`signup:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
  }

  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经注册过了，直接登录吧" };

  // 先占码。失败计一次限流，让猜码的人越猜越慢
  const 占 = await 占用(input.code, "pending");
  if (!占.ok) {
    if (from) 记一次失败(`signup:${from}`, Date.now(), IP阈值);
    return 占;
  }

  let account;
  try {
    account = await createAccount({ target: t, password: input.password, name: input.name });
  } catch {
    await 释放(占.code);
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  try {
    const ws = await createWorkspace({ name: input.workspace, account });
    await 记工作区(占.code, ws.id);
    await control.activationCode.update({ where: { code: 占.code }, data: { usedBy: account.id } });
    await createSession(account.id, ws.id);
    return { ok: true };
  } catch (e) {
    // 工作区没开成：账号删掉、码还回去，让这个人能用同一个码再试一次
    await control.account.delete({ where: { id: account.id } }).catch(() => {});
    await 释放(占.code);
    console.error("开工作区失败：", e);
    return { ok: false, error: "开通失败，请稍后重试" };
  }
}

export async function trialDays(): Promise<number> {
  return TRIAL_DAYS;
}
