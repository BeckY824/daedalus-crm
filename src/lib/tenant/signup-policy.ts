/**
 * 注册这件事**这个部署开不开、要不要验证码、发不发得出码**。
 *
 * 单独一个文件，因为同一套判断现在有两个调用方：网页的 /signup（Server Action）
 * 和桌面端走的 /api/account/*（HTTP）。抄两遍的下场是可预料的——
 * 哪天关掉自助注册，网页关了、桌面端还开着，那就是一个谁都能进的后门。
 *
 * 收 env 参数的理由同 lib/secret.ts：要验「生产环境没配通道时的行为」，
 * 而 vitest 里改不动真的 NODE_ENV。
 */

import { smtpConfigured } from "./notify";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * **配了 SIGNUP_REDIRECT 就等于关闭自助注册**：网页跳去咨询页，两个 Server Action
 * 和桌面端那几个接口一律拒绝。留着而不是删掉，是因为关闭注册是个阶段性决定——
 * 发码通道断了时走人工开号，通道通了把这个变量去掉就回来了。
 *
 * 空字符串不算关闭：.env 里留个空值不该把注册莫名其妙关掉。
 */
export function 自助注册已关闭(env: Env = process.env): boolean {
  return Boolean(env.SIGNUP_REDIRECT?.trim());
}

/**
 * 要不要验证码。**默认不要**：填个账号和密码就能注册。
 *
 * 验证码的作用是证明"这个邮箱是你的"，代价是必须有一条发码通道，
 * 而通道是要等的——短信签名要备案，邮件要域名验证。为了这个把注册挡在门外，
 * 换来的安全性并不值：这是个 7 天试用的 CRM，不是银行。
 *
 * 不验证的代价写明白：注册时填的联系方式可能是假的，那样找回密码那条路也走不通；
 * 一个人也可以多注册几个号来多薅免费 AI 次数——后者由「每个 IP 每天最多开 3 个」兜着。
 *
 * 通道配好之后把 SIGNUP_VERIFY=1 打开就恢复验证，代码不用动。
 * scripts/enable-email-signup.sh 会顺手打开它。
 */
export function 需要验证码(env: Env = process.env): boolean {
  return env.SIGNUP_VERIFY === "1";
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
export function 能收到码(env: Env = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return smtpConfigured(env);
}

export function 收不到码的提示(): string {
  return "邮箱注册暂时不可用（发信通道未配置），请联系我们";
}
