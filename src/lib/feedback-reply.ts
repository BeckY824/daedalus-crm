import { isEmail } from "./tenant/accounts";
import { 建立SMTP, smtpConfigured } from "./tenant/notify";
import { 收件人 } from "./lead";

/**
 * 运营台回复反馈（2026-10-02）：运营台里写，用邮件发到对方邮箱。
 *
 * 发件地址还是 no-reply@（阿里那边的触发类型地址，收不了信），所以 **Reply-To 一定要设**：
 * 设成回信的那个运营的邮箱，对方在邮箱里点「回复」就直接到人手上，来回几封都不用再进运营台。
 *
 * 信里带上他当时的原话：隔了几天收到一封「已经修好了」，不附原话谁也想不起是哪件事。
 */

export const 回复上限 = 4000;

export type 回复邮件 = { to: string; replyTo: string; subject: string; text: string };

export type 回复检查 = { ok: true; to: string; body: string } | { ok: false; error: string };

/** 收件人和正文先过一遍：邮箱要像邮箱，正文不能空 */
export function 查回复(to: string, body: string): 回复检查 {
  const 邮箱 = to.trim();
  const 正文 = body.trim();
  if (!邮箱) return { ok: false, error: "填一个收件邮箱" };
  if (!isEmail(邮箱)) return { ok: false, error: "收件邮箱格式不对" };
  if (!正文) return { ok: false, error: "写一句再发" };
  if (正文.length > 回复上限) return { ok: false, error: `太长了，${回复上限} 字以内` };
  return { ok: true, to: 邮箱, body: 正文 };
}

/**
 * 对方点「回复」会到哪：配了 FEEDBACK_REPLY_TO 用它；否则是回信的运营本人；
 * 用网址口令进来的（不知道是谁）落到收线索的那个邮箱。
 */
export function 回信地址(运营邮箱: string | null, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return env.FEEDBACK_REPLY_TO?.trim() || 运营邮箱?.trim() || 收件人(env as NodeJS.ProcessEnv);
}

export function 组回复邮件(
  input: { to: string; body: string; 原话: string; 原话时间: Date; replyTo: string },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): 回复邮件 {
  const 产品 = env.SMTP_PRODUCT_NAME ?? "Daedalus CRM";
  const 时间 = 北京时间(input.原话时间);
  const 引用 = input.原话
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return {
    to: input.to,
    replyTo: input.replyTo,
    subject: `回复你的 ${产品} 反馈`,
    text: `${input.body.trim()}\n\n——\n你 ${时间} 的反馈：\n${引用}\n\n直接回复这封邮件就能接着说。`,
  };
}

/** 服务器跑在 UTC，信里写的是用户那边的钟点 */
function 北京时间(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${t.slice(5, 7)}-${t.slice(8, 10)} ${t.slice(11, 16)}`;
}

type 发送器 = (m: 回复邮件) => Promise<void>;

async function 默认发送(m: 回复邮件): Promise<void> {
  const transport = await 建立SMTP();
  await transport.sendMail({ from: process.env.SMTP_FROM!, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text });
}

let 当前发送器: 发送器 = 默认发送;

/** 测试用：换掉真正的 SMTP。传 null 恢复默认 */
export function 设置回复发送器(fn: 发送器 | null) {
  当前发送器 = fn ?? 默认发送;
}

export function 回复通道可用(): boolean {
  return 当前发送器 !== 默认发送 || smtpConfigured();
}

export function 发回复(m: 回复邮件): Promise<void> {
  return 当前发送器(m);
}
