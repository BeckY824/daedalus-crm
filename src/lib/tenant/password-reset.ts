/**
 * 找回密码：邮箱 → 验证码 → 设新密码。
 *
 * 这是注册那条路欠下的账。注册默认不要验证码（见 tenant/signup-policy.ts），
 * 代价当时就写明白了：「忘了密码没法自助找回，只能到运营台重置」。
 * 现在邮件通道通了，把这条路补上——运营台重置要我们手动介入，
 * 而人是半夜想起密码忘了的。
 *
 * 规则放在 lib 里而不是 app/forgot/actions.ts 里，因为有两个调用方：
 * 网页的 /forgot（Server Action）和桌面端走的 /api/account/password（HTTP）。
 * 两边只负责把「来源 IP」取出来喂进来，其余一模一样。
 *
 * 三条边界：
 *   **只有托管版有。** 自部署版没有控制面账号，改密是管理员在「用户管理」里的事。
 *   **必须真发得出信。** 没配 SMTP 时 sendCode 会降级成「打进服务端日志」——
 *     那对注册尚可（运维能从日志里把码捞给用户），对找回密码是个死胡同：
 *     人对着空收件箱等，而我们并不知道他在等。宁可整个入口不出现。
 *   **只认邮箱。** 手机号那条要短信，而国内短信签名要域名备案，服务器在境外办不下来。
 *     早年用手机号注册的账号只能找我们人工重置，页面上直说。
 *
 * 通篇不透露「这个号存不存在」：找回密码是未登录就能调的接口，
 * 一旦区分开，它就是一个查号接口——把我们的客户名单送给任何人。
 * 所以不存在的号也照样走一遍发码（只是不发信），连「刚发过了」的节流行为都一致。
 */

import { codeVisibleToClient, sendCode, smtpConfigured } from "./notify";
import { checkPassword, consumeCode, findAccountByTarget, issueCode, parseTarget, updatePassword } from "./accounts";
import { 记一次改密 } from "./session-cutoff";
import { 吊销全部 } from "./device-token";
import { 检查限流, 记一次失败, 清除限流, IP阈值 } from "../rate-limit";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type 发码结果 = { ok: true; hint?: string } | { ok: false; error: string };
export type 重置结果 = { ok: true } | { ok: false; error: string };

const 未开放 = { ok: false as const, error: "这个部署没有开放自助找回密码，请联系我们" };
/** 验证码错、账号不存在、账号停用——对外都是这一句。区分开就是查号接口 */
const 通用失败 = { ok: false as const, error: "验证码不对或已过期，请重新获取" };

/** 这个部署能不能自助找回。页面拿它决定画表单还是画「请联系我们」 */
export function 能找回密码(env: Env = process.env): boolean {
  // 自部署版没有控制面账号，改密是管理员在「设置管理 → 用户管理」里的事。
  // 这里直接看变量而不是调 context.ts 的 multiTenant()，是因为那个只认 process.env，
  // 而这里要能被喂一份假环境；判据是同一条，改一处记得改另一处
  if (env.MULTI_TENANT !== "1") return false;
  // 开发环境不判通道：那里验证码直接回显在页面上，见 notify.ts 的 codeVisibleToClient
  if (env.NODE_ENV !== "production") return true;
  return smtpConfigured(env);
}

/**
 * 第一步：把码发到邮箱。
 *
 * 无论这个邮箱有没有注册过，返回的都是同一句成功。差别只在有没有真的发信。
 * 节流（同一邮箱 60 秒一次）交给 issueCode，所以不存在的号也要走一遍它——
 * 少走这一步，连点两次时「刚发过了」只会出现在真实账号上，等于把号查出来了。
 *
 * `from` 是调用方解析好的来源 IP（拿不到就给 null）：网页那边从 headers() 取，
 * 接口那边从请求头取，规则本身不该知道自己跑在哪种入口里。
 */
export async function 发送重置码(targetRaw: string, from: string | null): Promise<发码结果> {
  if (!能找回密码()) return 未开放;

  const t = parseTarget(targetRaw);
  if (!t) return { ok: false, error: "请填写正确的邮箱" };
  if (t.kind !== "email") {
    // 手机号是唯一一种「说清楚反而更好」的情况：不说的话他会一直等一条永远不会来的短信
    return { ok: false, error: "现在只能用邮箱找回。手机号注册的账号请联系我们人工重置" };
  }

  // 发信要花钱，且这是未登录就能触发的外部动作，按 IP 拦一道
  if (from) {
    const 还要等 = 检查限流(`reset:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
    记一次失败(`reset:${from}`, Date.now(), IP阈值);
  }

  const r = await issueCode(t.value, "reset");
  if (!r.ok) return r;

  const account = await findAccountByTarget(t.value);
  /**
   * 号不存在或已停用：码照存不照发。对方看到的和正常情况一模一样。
   *
   * **不等发信结果**。等的话就成了一个按耗时查号的接口：真账号要跑一趟 SMTP
   * （几百毫秒到几秒），假账号立刻返回——返回体一样，时间不一样，一样能把
   * 我们的客户名单问出来。发不出去也照样算成功，只把原因记进日志：
   * 把发信失败吐回页面同样只会出现在真账号上。
   */
  if (account?.active) {
    void sendCode(t.value, r.code)
      .then((sent) => {
        if (!sent.ok) console.error("[reset] 验证码发送失败：", sent.error);
      })
      .catch((e) => console.error("[reset] 验证码发送异常：", e));
  }

  return { ok: true, hint: codeVisibleToClient() && account?.active ? `开发环境验证码：${r.code}` : undefined };
}

/**
 * 第二步：验码 + 设新密码。
 *
 * 成功之后做两件容易漏的事：
 *   作废旧会话——JWT 收不回来，不记这条线的话，拿着旧 Cookie 的人还能再用 7 天；
 *   清掉登录限流——会走到这一页的人多半刚把密码试错到冷却，
 *   不清的话他拿着刚设好的新密码还要再等 5 分钟，这体验说不通。
 */
export async function 重置密码(
  input: { target: string; code: string; password: string },
  from: string | null,
): Promise<重置结果> {
  if (!能找回密码()) return 未开放;

  const t = parseTarget(input.target);
  if (!t || t.kind !== "email") return { ok: false, error: "请填写正确的邮箱" };

  const pwErr = checkPassword(input.password);
  if (pwErr) return { ok: false, error: pwErr };

  if (from) {
    const 还要等 = 检查限流(`reset:${from}`);
    if (还要等 != null) return { ok: false, error: `操作太频繁，请 ${还要等} 秒后再试` };
  }

  // 验证码本身有一次性、10 分钟有效、5 次尝试三道；这里再按 IP 记一次，挡住换着邮箱慢速试的
  const codeOk = await consumeCode(t.value, input.code, "reset");
  if (!codeOk.ok) {
    if (from) 记一次失败(`reset:${from}`, Date.now(), IP阈值);
    return codeOk;
  }

  const account = await findAccountByTarget(t.value);
  if (!account?.active) return 通用失败;

  await updatePassword(account.id, input.password);
  // 改密码 = 到处都要重新登录：网页会话作废，桌面端那几枚设备令牌也一起吊掉
  await 记一次改密(account.id);
  await 吊销全部(account.id);
  清除限流(`u:${t.value}`);
  return { ok: true };
}
