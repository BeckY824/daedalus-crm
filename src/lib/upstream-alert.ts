/**
 * 中转站余额不足的告警（10-17：AC 回放实验用的是正式服务器那把 Key，把中转站余额花光，线上 AI 停了一阵，没人第一时间知道）。
 *
 * 中转站余额不足回的是 **400**（b.ai：`insufficient_user_quota` / `credit insufficient balance: balance=… required=…`），
 * 不是 402——原来网关按「400 是请求本身的毛病」处理：不退用户次数、英文原文直接甩到界面上、日志里也不醒目。
 * 现在认出来就当成我们这边的问题（退次数、背调记失败），并且：
 *   - 每次都打一行 `[告警][中转站余额不足]`，运维 grep 告警 就能捞到；
 *   - 配了 SMTP 的，最多每 30 分钟发一封告警邮件给 ALERT_TO（没配就发给线索邮箱，lib/lead.ts 的 收件人）。
 */
import { smtpConfigured, 建立SMTP } from "./tenant/notify";
import { 收件人 } from "./lead";

/** 各家中转站 / OpenAI 兼容接口说「钱不够了」的几种说法 */
const 余额不足的说法 = /insufficient[_ ]user[_ ]quota|insufficient[_ ](balance|quota|credit)|credit insufficient|exceeded your current quota|quota (has been )?exceeded|余额不足|额度不足/i;

export function 是余额不足(text: string): boolean {
  return 余额不足的说法.test(text);
}

const 邮件间隔毫秒 = 30 * 60_000;
let 上次发信 = 0;

type 发信 = (m: { to: string; subject: string; text: string }) => Promise<void>;
const 默认发信: 发信 = async (m) => {
  const t = await 建立SMTP();
  await t.sendMail({ from: process.env.SMTP_FROM!, ...m });
};
let 当前发信: 发信 = 默认发信;

/** 测试用：换掉真正的 SMTP、清掉节流。传 null 恢复默认 */
export function 设置告警发信(fn: 发信 | null) {
  当前发信 = fn ?? 默认发信;
  上次发信 = 0;
}

/**
 * 记告警。哪 = 在哪儿撞上的（gateway / research/search），原文 = 已经抹掉密钥的上游回应。
 * 发信失败不影响这次请求，只记日志
 */
export async function 余额告警(哪: string, 原文: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.error(`[告警][中转站余额不足] ${哪}：线上 AI 用不了了，赶紧给中转站充值。上游原文：${原文.slice(0, 300)}`);
  if (!smtpConfigured(env) || now - 上次发信 < 邮件间隔毫秒) return;
  上次发信 = now;
  try {
    await 当前发信({
      to: env.ALERT_TO?.trim() || 收件人(env),
      subject: "【告警】中转站余额不足，线上 AI 停了",
      text: `${new Date(now).toISOString()} ${哪} 撞上中转站余额不足，用户这边的 AI 次数照退，但线上 AI 用不了，请尽快充值。\n\n上游原文：${原文.slice(0, 500)}\n\n（30 分钟内不再重复发信，日志里每次都有 [告警][中转站余额不足]）`,
    });
  } catch (e) {
    console.error("[告警] 余额告警邮件发不出去：", e instanceof Error ? e.message : e);
  }
}
