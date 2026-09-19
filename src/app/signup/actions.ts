"use server";

import { headers } from "next/headers";
import { multiTenant } from "@/lib/tenant/context";
import { codeVisibleToClient, sendCode } from "@/lib/tenant/notify";
import { checkPassword, consumeCode, createAccount, findAccountByTarget, isDisposableEmail, issueCode, parseTarget } from "@/lib/tenant/accounts";
import { 自助注册已关闭, 需要验证码, 能收到码, 收不到码的提示 } from "@/lib/tenant/signup-policy";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值, 今日注册数, 记一次注册, 每IP每日注册上限 } from "@/lib/rate-limit";

/**
 * 注册：邮箱 + 验证码 + 密码 + 团队名 → 开一个工作区，试用 7 天。
 *
 * **一个团队一套账号密码，没有第二种凭据。** 早先注册时还认一个「激活码 / 邀请码」
 * ——一次性的、万能的各一种，填了多送 AI 次数。整套已经下线（2026-09-15 用户拍板）：
 * 它让「怎么才能开号」有了好几个说法，而这件事应该只有一个说法。
 * 开出来的第一个账号就是这个工作区的 OWNER，之后加人走应用内的邀请，不走码。
 *
 * **只收邮箱。** 手机号那条路要短信通道，而国内短信签名要域名备案，服务器在境外办不下来；
 * 与其在注册页摆一个填了就被拒的入口，不如不摆。登录仍然认手机号——早先开的账号还在用。
 *
 * 不要姓名：它在「设置管理 → 用户管理」里随时能改，而团队名改不了
 * （它决定了工作区的 slug 和库文件名），所以只留团队名这一个非填不可的。
 *
 * 只在托管版可用。自部署版没有"注册"这回事——那里是管理员建账号。
 *
 * 开不开、要不要验证码、发不发得出码这三个判断在 lib/tenant/signup-policy.ts。
 * 只跳页面不拦动作是不够的：Server Action 是独立端点，绕过页面直接调得到。
 *
 * 桌面端不走另一条路：它的「注册新账号」是开浏览器到这一页。试过在桌面端里直接开
 * 「只有账号没有工作区」的号，结果那种账号进不了网页版，而同一个邮箱又注册不了第二次——
 * 一个账号在两个地方行为不一样，比多点一次浏览器糟得多。
 */

export type SendCodeResult = { ok: true; hint?: string } | { ok: false; error: string };
export type SignupResult = { ok: true } | { ok: false; error: string };

async function ip(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

function 未开放(): { ok: false; error: string } {
  return { ok: false, error: "这个部署没有开放注册" };
}

/**
 * 发注册用的验证码。
 *
 * 和找回密码那边的发码**故意相反**：这里会直说「这个号已经注册过了」。
 * 那不是泄露，是注册页该给的指路——否则人会一直填一个永远开不成的号。
 * （找回密码那条不能这么做，区分开它就成了查号接口，见 lib/tenant/password-reset.ts。）
 */
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

  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经注册过了，直接登录吧" };

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

export async function signup(input: {
  target: string;
  /** 只有打开 SIGNUP_VERIFY 时才要；默认那条路上表单根本不画这一栏 */
  code?: string;
  password: string;
  /** 可选：不填就从邮箱前缀取 */
  name?: string;
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

  try {
    // 建出来就完事：赠送挪到桌面端登录那一刻发（见下），这里不再需要拿着这个账号做什么
    await createAccount({ target: t, password: input.password, name: input.name?.trim() || 从邮箱取名(t.value) });
  } catch {
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  /**
   * 注册**只开账号，不开工作区**（2026-09-16 起）。
   *
   * 账号是给桌面端用的：桌面端本地模式必须先登录云端账号，而注册只有网页这一条路
   * （见 desktop/main.js 顶部）。网页版那边现在只有一个共享工作区、一套固定账号密码，
   * 由我们发给要试用的团队——不再是「谁注册谁得一个」。
   *
   * 所以注册完不再签会话、不再跳 /dashboard：新账号在网页版没有工作区，
   * 跳进去只会撞上「你还没有工作区」。目的地一律是桌面端。
   */
  /*
    **注册这一刻不再发那 30 次**（2026-09-19，用户拍板「同一台电脑不重复赠送」）。

    原来这里直接往账号的赠送账本上记一条 signup。问题是注册在网页上办，
    这里根本不知道人坐在哪台电脑前——于是同一台电脑上注册第二个账号就又是一份 30 次，
    而桌面端登录时再想拦已经晚了：账上那一条已经在了，只加不减的账本不会往回收。

    所以注册赠送整个挪到「桌面端第一次登录」那一刻发（api/account/token →
    lib/tenant/credits.ts 的 结算赠送）：那是唯一一个既必然经过、
    又带着机器标识的地方，一台机器只发一次。

    对正常用户没有差别：这个账号除了桌面端没有别的用处（注册不开工作区，
    网页版是另一套固定账号），额度也只有桌面端看得见——他装上应用登录进去，
    30 次就在那儿。注册页上那句「送 30 次」仍然算数。
  */
  if (from) 记一次注册(from);
  return { ok: true };
}

/** 注册页用它决定要不要画验证码那一栏 */
export async function 注册要验证码(): Promise<boolean> {
  return 需要验证码();
}
