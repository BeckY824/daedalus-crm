"use server";

import { headers } from "next/headers";
import { createSession } from "@/lib/auth";
import { multiTenant } from "@/lib/tenant/context";
import { control } from "@/lib/tenant/control";
import { createWorkspace, TRIAL_DAYS } from "@/lib/tenant/workspaces";
import { codeVisibleToClient, sendCode, smtpConfigured } from "@/lib/tenant/notify";
import { checkPassword, consumeCode, createAccount, findAccountByTarget, isDisposableEmail, issueCode, parseTarget } from "@/lib/tenant/accounts";
import { 占用, 释放, 记工作区, 核验万能码, 归一化 } from "@/lib/tenant/activation";
import { 赠送, 邀请码赠送, 注册赠送 } from "@/lib/tenant/ai-allowance";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值, 今日注册数, 记一次注册, 每IP每日注册上限 } from "@/lib/rate-limit";

/**
 * 注册：邮箱 + 验证码 + 密码 + 团队名（+ 可选邀请码）→ 开一个工作区，试用 7 天。
 *
 * **只收邮箱。** 手机号那条路要短信通道，而国内短信签名要域名备案，服务器在境外办不下来；
 * 与其在注册页摆一个填了就被拒的入口，不如不摆。登录仍然认手机号——早先开的账号还在用。
 *
 * 不要姓名：它在「设置管理 → 用户管理」里随时能改，而团队名改不了
 * （它决定了工作区的 slug 和库文件名），所以只留团队名这一个非填不可的。
 *
 * 只在托管版可用。自部署版没有"注册"这回事——那里是管理员建账号。
 *
 * **配了 SIGNUP_REDIRECT 就等于关闭自助注册**：页面跳去咨询页，这里的两个动作
 * 一律拒绝。留着而不是删掉，是因为关闭注册是个阶段性决定——发码通道断了时
 * 走人工开号，通道通了把这个变量去掉就回来了。
 * 只跳页面不拦动作是不够的：Server Action 是独立端点，绕过页面直接调得到。
 */
function 自助注册已关闭(): boolean {
  return Boolean(process.env.SIGNUP_REDIRECT?.trim());
}

/**
 * 要不要验证码。**默认不要**：填个账号和密码就能注册。
 *
 * 验证码的作用是证明"这个手机号/邮箱是你的"，代价是必须有一条发码通道，
 * 而通道是要等的——短信签名要备案，邮件要域名验证。为了这个把注册挡在门外，
 * 换来的安全性并不值：这是个 7 天试用的 CRM，不是银行。
 *
 * 不验证的代价写明白：注册时填的联系方式可能是假的，忘了密码没法自助找回
 * （只能到运营台重置）；一个人也可以多注册几个号来多薅免费 AI 次数——
 * 后者由「每个 IP 每天最多开 3 个」兜着，见下面。
 *
 * 通道配好之后把 SIGNUP_VERIFY=1 打开就恢复验证，代码不用动。
 * scripts/enable-email-signup.sh 会顺手打开它。
 */
function 需要验证码(): boolean {
  return process.env.SIGNUP_VERIFY === "1";
}

/**
 * 要验证码的时候，这个号收得到码吗。
 *
 * 短信要备案、邮件要域名验证，两条通道多半不是同时到位的。只配了邮件却让人填手机号，
 * 他会点「获取验证码」然后永远等不到——码其实只打进了容器日志。
 * 宁可在门口就说清楚「现在只支持邮箱」，也不要让人对着一个空收件箱等。
 *
 * 开发环境不判：那里码直接回显在页面上，见 notify.ts 的 codeVisibleToClient。
 */
function 能收到码(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return smtpConfigured();
}

function 收不到码的提示(): string {
  return "邮箱注册暂时不可用（发信通道未配置），请联系我们";
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
  if (!需要验证码()) return { ok: false, error: "这个部署不需要验证码，直接填密码注册即可" };
  const t = parseTarget(targetRaw);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱" };
  if (isDisposableEmail(t.value)) return { ok: false, error: "请用常用邮箱注册，临时邮箱收不到后续通知" };
  if (!能收到码()) return { ok: false, error: 收不到码的提示() };

  // 按 IP 限流：发码是唯一一个未登录就能触发外部计费动作的接口，不限会被薅
  const from = await ip();
  if (from) {
    const 还要等 = 检查限流(`code:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    记一次失败(`code:${from}`, Date.now(), IP阈值);
    if (今日注册数(from) >= 每IP每日注册上限) return { ok: false, error: "今天从这个网络注册的账号已经够多了，明天再来" };
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

/** 没填姓名时从邮箱前缀取一个。之后在「设置管理 → 用户管理」里随时能改 */
function 从邮箱取名(email: string): string {
  const 前缀 = email.split("@")[0].replace(/[._+-]+/g, " ").trim();
  return (前缀 || "我").slice(0, 20);
}

/**
 * 邀请码是**可选**的：不填也能注册，填了多送 AI 次数。
 * 认两种：万能码（预约演示后发给客户的那一个，可反复用、运营台一键更换）
 * 和旧的一次性激活码（旧批次仍然有效，用一次作废）。
 * 填了但不对要报错而不是静默忽略——人是冲着多送的次数填的。
 */
async function 预检邀请码(raw: string): Promise<{ ok: true; kind: "master" | "once" | "none"; code: string | null } | { ok: false; error: string }> {
  const s = raw.trim();
  if (!s) return { ok: true, kind: "none", code: null };
  if (await 核验万能码(s)) return { ok: true, kind: "master", code: 归一化(s) };
  const code = 归一化(s);
  if (code) {
    const row = await control.activationCode.findUnique({ where: { code } });
    if (row && !row.usedAt) return { ok: true, kind: "once", code };
  }
  return { ok: false, error: "邀请码无效或已被使用。不填也能注册，只是少送一些 AI 次数" };
}

export async function signup(input: {
  target: string;
  /** 只有打开 SIGNUP_VERIFY 时才要；默认那条路上表单根本不画这一栏 */
  code?: string;
  password: string;
  /** 可选：不填就从邮箱前缀取 */
  name?: string;
  workspace: string;
  invite?: string;
  agreed?: boolean;
}): Promise<SignupResult> {
  if (!multiTenant() || 自助注册已关闭()) return 未开放();

  const t = parseTarget(input.target);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱" };
  /**
   * 不验证码的时候，这一条就是挡临时邮箱的唯一一道闸，必须在这里判——
   * 原来只在发码那一步判，而现在发码那一步可能整个不走。
   */
  if (isDisposableEmail(t.value)) return { ok: false, error: "请用常用邮箱注册，临时邮箱收不到后续通知" };
  if (!input.workspace.trim()) return { ok: false, error: "请填写团队名称" };
  const pwErr = checkPassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };
  // 服务端也要验勾选：表单上的勾选框绕得过，法律意义上的同意绕不过
  if (!input.agreed) return { ok: false, error: "请先阅读并同意用户协议和隐私政策" };

  const from = await ip();
  if (from) {
    const 还要等 = 检查限流(`signup:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    if (今日注册数(from) >= 每IP每日注册上限) return { ok: false, error: "今天从这个网络注册的账号已经够多了，明天再来" };
  }

  // 邀请码在消耗验证码**之前**预检：验证码一次性，先花掉再报邀请码不对，人得重新收一次码
  // （不要验证码时这个顺序无所谓，但留着，省得哪天打开验证又踩一遍）
  const 邀请 = await 预检邀请码(input.invite ?? "");
  if (!邀请.ok) {
    if (from) 记一次失败(`signup:${from}`, Date.now(), IP阈值);
    return 邀请;
  }

  if (需要验证码()) {
    // 表单绕得过，Server Action 绕不过
    if (!能收到码()) return { ok: false, error: 收不到码的提示() };
    const codeOk = await consumeCode(t.value, input.code ?? "", "signup");
    if (!codeOk.ok) {
      if (from) 记一次失败(`signup:${from}`, Date.now(), IP阈值);
      return codeOk;
    }
  }

  // 验证码校验通过到建账号之间还有一个窗口，同一个号并发注册会撞唯一索引，交给数据库判
  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经注册过了，直接登录吧" };

  // 一次性邀请码：原子占用，两个人同时用同一个码只有一个能拿到赠送
  let 一次性: string | null = null;
  if (邀请.kind === "once" && 邀请.code) {
    const 占 = await 占用(邀请.code, "pending");
    if (占.ok) 一次性 = 占.code;
  }

  let account;
  try {
    account = await createAccount({ target: t, password: input.password, name: input.name?.trim() || 从邮箱取名(t.value) });
  } catch {
    if (一次性) await 释放(一次性);
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  try {
    const ws = await createWorkspace({ name: input.workspace, account });
    // 注册赠送。查额度时也会补，这里先记上是为了首页第一眼就显示对
    await 赠送({ workspaceId: ws.id, amount: 注册赠送, reason: "signup", key: `${ws.id}:signup` });
    if (邀请.kind === "master") {
      await 赠送({ workspaceId: ws.id, amount: 邀请码赠送, reason: "invite", key: `${ws.id}:invite`, note: "万能码" });
    } else if (一次性) {
      await 记工作区(一次性, ws.id);
      await control.activationCode.update({ where: { code: 一次性 }, data: { usedBy: account.id } });
      await 赠送({ workspaceId: ws.id, amount: 邀请码赠送, reason: "invite", key: `${ws.id}:invite`, note: 一次性 });
    }
    if (from) 记一次注册(from);
    await createSession(account.id, ws.id);
    return { ok: true };
  } catch (e) {
    // 工作区没开成：账号删掉、一次性码还回去，让这个人能用同一个码再试一次
    await control.account.delete({ where: { id: account.id } }).catch(() => {});
    if (一次性) await 释放(一次性);
    console.error("开工作区失败：", e);
    return { ok: false, error: "开通失败，请稍后重试" };
  }
}

export async function trialDays(): Promise<number> {
  return TRIAL_DAYS;
}

/** 注册页用它决定要不要画验证码那一栏 */
export async function 注册要验证码(): Promise<boolean> {
  return 需要验证码();
}
