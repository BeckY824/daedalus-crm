/**
 * 官网「预约演示」表单的后端：把访客填的东西直接发到我们的邮箱。
 *
 * 之前官网是纯静态，表单靠 mailto 让访客用自己的邮箱发——链条断在哪一环
 * （没装邮件客户端、弹出来没点发送、手机浏览器不认 mailto）我们都不知道，
 * 访客以为发了，我们什么都没收到。现在由服务器替他发；发不出去官网会落回那个
 * 复制粘贴的面板，所以最坏也只是回到从前，不会更糟。
 *
 * 这是个**不需要凭证、会花我们邮件额度**的公开接口（阿里邮件推送 200 封/天，
 * 注册验证码也从这条通道出）。所以有四道闸：只认官网的 Origin、藏一个蜜罐字段、
 * 每个 IP 每天几条、全站每天封顶——宁可让真客户复制粘贴，也不能让注册码断掉。
 *
 * 刻意不入库：用户要的是「填完直接到邮箱」，就只做这一件。想看历史线索再加表。
 */

import { isEmail } from "./tenant/accounts";
import { smtpConfigured, 建立SMTP } from "./tenant/notify";
import { 今日计数, 记一次今日 } from "./rate-limit";

export type 线索 = {
  name: string;
  phone: string;
  company: string;
  title: string;
  teamsize: string;
  email: string;
  scenario: string;
  lang: "zh" | "en";
};

/** 一个出口 IP 一天最多几条。一家公司一天约两次演示已经很多了 */
export const 每IP每日线索上限 = 5;
/** 全站一天封顶。额度 200 封/天要留给注册码，线索占到这个数已经不正常 */
export const 每日线索总上限 = 50;

/** 允许跨域来源。默认只有官网；本地调官网时可用 LEAD_ORIGINS 追加，逗号分隔 */
export function 允许来源(env: NodeJS.ProcessEnv = process.env): string[] {
  const 追加 = (env.LEAD_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ["https://ai-daedalus.com", "https://www.ai-daedalus.com", ...追加];
}

export function 来源允许(origin: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(origin) && 允许来源(env).includes(origin!);
}

/** 收件箱。LEAD_TO > LEGAL_CONTACT > 默认，和条款页的联系邮箱同源 */
export function 收件人(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEAD_TO?.trim() || env.LEGAL_CONTACT?.trim() || "qy1g18@gmail.com";
}

const 单行上限 = 200;
const 多行上限 = 2000;

/**
 * 校验并整形。返回 bot 表示蜜罐字段被填了——人看不见那个框，填了的只能是脚本；
 * 调用方应当回 200 假装收下，别告诉脚本它被识破了。
 */
export function 校验线索(body: unknown): { ok: true; 线索: 线索 } | { ok: false; error: string } | { ok: false; bot: true } {
  if (!body || typeof body !== "object") return { ok: false, error: "请求体不是对象" };
  const b = body as Record<string, unknown>;
  const 取 = (k: string, 上限 = 单行上限) => {
    const v = b[k];
    if (v == null) return "";
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 上限 ? null : t;
  };
  if (取("website") !== "") return { ok: false, bot: true };

  const name = 取("name"), phone = 取("phone"), company = 取("company"), email = 取("email");
  const title = 取("title"), teamsize = 取("teamsize"), scenario = 取("scenario", 多行上限);
  if ([name, phone, company, email, title, teamsize, scenario].some((v) => v === null)) return { ok: false, error: "有字段不是文本或太长" };
  if (!name || !phone || !company || !email) return { ok: false, error: "姓名、手机号、公司、邮箱都要填" };
  if (!isEmail(email)) return { ok: false, error: "邮箱格式不对" };
  const lang = b.lang === "en" ? "en" : "zh";
  return { ok: true, 线索: { name, phone, company, title: title!, teamsize: teamsize!, email, scenario: scenario!, lang } };
}

export type 邮件 = { to: string; replyTo: string; subject: string; text: string };

/**
 * Reply-To 设成访客邮箱：发件地址 no-reply@ 是阿里那边的触发类型地址，收不了信，
 * 不设的话在 Gmail 里点「回复」会发到一个没人看的地方。
 */
export function 组邮件(线索: 线索, env: NodeJS.ProcessEnv = process.env): 邮件 {
  const zh = 线索.lang === "zh";
  const 行: [string, string][] = zh
    ? [["姓名", 线索.name], ["手机号", 线索.phone], ["公司/组织", 线索.company], ["职位", 线索.title], ["团队规模", 线索.teamsize], ["邮箱", 线索.email], ["关注场景", 线索.scenario]]
    : [["Name", 线索.name], ["Phone", 线索.phone], ["Company", 线索.company], ["Role", 线索.title], ["Team size", 线索.teamsize], ["Email", 线索.email], ["Wants to cover", 线索.scenario]];
  const text = 行.map(([k, v]) => `${k}：${v || "-"}`).join("\n") + `\n\n—— 来自官网预约演示表单（${zh ? "中文" : "English"}）`;
  return {
    to: 收件人(env),
    replyTo: `${线索.name} <${线索.email}>`,
    subject: `${zh ? "预约演示" : "Demo request"} - ${线索.company}`,
    text,
  };
}

type 发送器 = (m: 邮件) => Promise<void>;

async function 默认发送(m: 邮件): Promise<void> {
  const transport = await 建立SMTP();
  await transport.sendMail({ from: process.env.SMTP_FROM!, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text });
}

let 当前发送器: 发送器 = 默认发送;

/** 测试用：换掉真正的 SMTP。传 null 恢复默认 */
export function 设置发送器(fn: 发送器 | null) {
  当前发送器 = fn ?? 默认发送;
}

export function 线索通道可用(): boolean {
  return smtpConfigured();
}

/**
 * 限流全在这里判，路由只管翻译成状态码。ip 为 null（没走反代）时只按全站封顶算。
 * 返回 null 放行，否则返回拒绝原因。
 */
export function 线索限流(ip: string | null, now = new Date()): "ip" | "all" | null {
  if (今日计数("lead:all", now) >= 每日线索总上限) return "all";
  if (ip && 今日计数(`lead:ip:${ip}`, now) >= 每IP每日线索上限) return "ip";
  return null;
}

export async function 发线索(线索: 线索, ip: string | null, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await 当前发送器(组邮件(线索));
  } catch (e) {
    console.error("[lead] 线索邮件发送失败：", e instanceof Error ? e.message : e);
    return { ok: false, error: "邮件发不出去" };
  }
  // 发成功才计数：发失败的那次不该占额度，访客重试是合理的
  记一次今日("lead:all", now);
  if (ip) 记一次今日(`lead:ip:${ip}`, now);
  return { ok: true };
}
