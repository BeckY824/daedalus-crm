/**
 * 开一个**只有账号、没有工作区**的号。桌面端注册走这里。
 *
 * 和网页那条 /signup 的区别只有一处，但这一处是整个方向：
 * 网页注册要开一个工作区（我们服务器上一个业务库文件），因为数据存在我们这儿；
 * 桌面端的数据在用户自己机器上，云端只剩两件事——认领一个账号、借它调模型。
 * 给每个桌面用户在服务器上建一个永远空着的库，既费地方又和本地优先的方向相反。
 *
 * 于是免费次数按**账号**记（AccountAiGrant / AccountAiUsage，规则见 credits.ts），
 * 而不是按工作区。两种归属方共用同一套规则，改定价不会漏一边。
 *
 * 开不开、要不要验证码这些判断和网页共用 tenant/signup-policy.ts：
 * 抄两遍的下场是哪天关掉自助注册，网页关了、桌面端还开着。
 *
 * 邀请码这里**不收**。它是销售工具（预约演示之后发出去、多送 50 次），
 * 绑的是托管版的试用工作区；桌面端要不要给它一条路是产品决定，不是顺手加的功能。
 */

import { sendCode, codeVisibleToClient } from "./notify";
import {
  checkPassword,
  consumeCode,
  createAccount,
  findAccountByTarget,
  isDisposableEmail,
  issueCode,
  parseTarget,
  type AccountView,
} from "./accounts";
import { 结算赠送 } from "./credits";
import { 自助注册已关闭, 需要验证码, 能收到码, 收不到码的提示 } from "./signup-policy";
import { 检查限流, 记一次失败, 解析来源IP, IP阈值, 今日注册数, 记一次注册, 每IP每日注册上限 } from "../rate-limit";

export type 发码结果 = { ok: true; hint?: string } | { ok: false; error: string };
export type 注册结果 = { ok: true; account: AccountView } | { ok: false; error: string };

const 未开放 = { ok: false as const, error: "这个部署没有开放注册" };

/** 把请求头里的 XFF 解析成来源 IP。接口和 Server Action 各自取头，规则只有这一份 */
export function 来源IP(xff: string | null | undefined): string | null {
  return 解析来源IP(xff);
}

/**
 * 注册用的验证码。网页的 requestCode 和桌面端的 /api/account/code 都走这里。
 *
 * 和找回密码那边相反，这里**故意**告诉你「这个号已经注册过了」：
 * 那不是泄露，是注册页该给的指路——否则人会一直填一个永远开不成的号。
 */
export async function 发送注册码(targetRaw: string, from: string | null): Promise<发码结果> {
  if (自助注册已关闭()) return 未开放;
  if (!需要验证码()) return { ok: false, error: "这个部署不需要验证码，直接填密码注册即可" };

  const t = parseTarget(targetRaw);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱" };
  if (isDisposableEmail(t.value)) return { ok: false, error: "请用常用邮箱注册，临时邮箱收不到后续通知" };
  if (!能收到码()) return { ok: false, error: 收不到码的提示() };

  // 按 IP 限流：发码是唯一一个未登录就能触发外部计费动作的接口，不限会被薅
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

/** 没填姓名时从邮箱前缀取一个。之后在设置里随时能改 */
function 从邮箱取名(email: string): string {
  const 前缀 = email.split("@")[0].replace(/[._+-]+/g, " ").trim();
  return (前缀 || "我").slice(0, 20);
}

/**
 * 开号。成功后顺手把注册赠送结上，桌面端第一眼就能看到自己有多少次。
 *
 * 每个 IP 每天仍然最多开 3 个：注册送 30 次 AI，不封顶会被脚本拿去批量开号薅额度。
 * 这个额度和网页注册共用同一个计数——换个客户端不该等于换一份配额。
 */
export async function 注册账号(
  input: { target: string; password: string; code?: string; name?: string; agreed?: boolean },
  from: string | null,
): Promise<注册结果> {
  if (自助注册已关闭()) return 未开放;

  const t = parseTarget(input.target);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱" };
  /**
   * 不验证码的时候，这一条就是挡临时邮箱的唯一一道闸。
   * 注册送 AI 次数之后，临时邮箱就是最省事的刷号入口。
   */
  if (isDisposableEmail(t.value)) return { ok: false, error: "请用常用邮箱注册，临时邮箱收不到后续通知" };
  const pwErr = checkPassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };
  // 客户端的勾选框绕得过，法律意义上的同意绕不过，所以这里也验
  if (!input.agreed) return { ok: false, error: "请先阅读并同意用户协议和隐私政策" };

  if (from) {
    const 还要等 = 检查限流(`signup:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    if (今日注册数(from) >= 每IP每日注册上限) return { ok: false, error: "今天从这个网络注册的账号已经够多了，明天再来" };
  }

  if (需要验证码()) {
    // 客户端绕得过，接口绕不过
    if (!能收到码()) return { ok: false, error: 收不到码的提示() };
    const codeOk = await consumeCode(t.value, input.code ?? "", "signup");
    if (!codeOk.ok) {
      if (from) 记一次失败(`signup:${from}`, Date.now(), IP阈值);
      return codeOk;
    }
  }

  if (await findAccountByTarget(t.value)) return { ok: false, error: "这个号已经注册过了，直接登录吧" };

  let account: AccountView;
  try {
    account = await createAccount({ target: t, password: input.password, name: input.name?.trim() || 从邮箱取名(t.value) });
  } catch {
    // 校验到建号之间还有一个窗口，同一个号并发注册会撞唯一索引，交给数据库判
    return { ok: false, error: "这个号已经注册过了，直接登录吧" };
  }

  if (from) 记一次注册(from);
  await 结算赠送({ kind: "account", id: account.id });
  return { ok: true, account };
}
