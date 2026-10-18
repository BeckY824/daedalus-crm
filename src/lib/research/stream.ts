/**
 * /api/ai/stream 里背调那一支：收参数、选通道、备好老客户清单、跑 6 步，过程事件原样推给浏览器。
 * 放在这里而不是路由里：路由文件只管把 emit 接到响应流上（和 agent、简报两支一个样）。
 */
import { requireUser } from "../auth";
import { getBusiness } from "../business";
import { consumeUserAiQuota } from "../ai-quota";
import { recordAiUse } from "../ai-usage";
import { chatMessagesJSON, chatTools } from "../llm";
import { prisma } from "../prisma";
import { 选通道 } from "./channel";
import { 老客户清单 } from "./similar";
import { 跑背调 } from "./run";
import { 报告文本 } from "./report";
import type { 研究事件 } from "./types";
import type { 背调状态 } from "./state";
import { 合并线索, 认线索, type 线索 } from "./verify/clues";
import { 收邮件信号, type 邮件信号 } from "./verify/mail";
import { 是免费邮箱 } from "./verify/domain";
import { 取IP库, 查IP } from "./verify/ip-country";
import { 模拟查IP } from "./mock";

export type 背调回答 = { text: string; records: []; customers: { id: string; name: string; followStatus: string }[]; proposals: []; research: 背调状态 };

/** 公司名：2–120 字，去掉两头的引号和空白 */
export function 收公司名(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[「『“"']+|[」』”"']+$/g, "").trim();
  return s.length >= 2 && s.length <= 120 ? s : null;
}

export async function 背调一次(
  body: { company: unknown; customerId?: unknown; need?: unknown; mail?: unknown },
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<{ ok: true; answer: 背调回答 } | { ok: false; error: string }> {
  const 公司 = 收公司名(body.company);
  if (!公司) return { ok: false, error: "要背调的公司名写得不对（2–120 个字）" };
  const user = await requireUser();
  const wait = consumeUserAiQuota(user);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const 通道 = await 选通道();
  if (!通道.ok) return { ok: false, error: 通道.error };
  const b = await getBusiness();

  /* 从客户详情页发起：把档案里已有的线索带上，帮第一步认准（同名公司很常见）。查不到这位就当没给——可能刚被删，或者看不到 */
  let 客户: { id: string; 已知: string } | undefined;
  const 需求 = typeof body.need === "string" && body.need.trim() ? body.need.trim().slice(0, 300) : undefined;
  /* 真实性核对要的对方自报的东西：档案里的邮箱 / 电话 / WhatsApp / 官网 / 国家，加上那句话里贴的（verify/clues.ts） */
  let 档案线索: Partial<线索> | undefined;
  if (typeof body.customerId === "string" && body.customerId) {
    const c = await prisma.customer.findUnique({
      where: { id: body.customerId },
      select: { id: true, name: true, remark: true, phone: true, extra: { select: { country: true, email: true, whatsapp: true, website: true } } },
    });
    if (c) {
      档案线索 = {
        邮箱: c.extra?.email ? [c.extra.email] : [],
        电话: [c.phone, c.extra?.whatsapp].filter((x): x is string => Boolean(x?.trim())),
        官网: c.extra?.website ?? undefined,
        国家: c.extra?.country ?? undefined,
      };
      const 邮箱域 = c.extra?.email?.split("@")[1];
      客户 = {
        id: c.id,
        已知: [c.extra?.country && `国家 ${c.extra.country}`, 邮箱域 && `邮箱域名 ${邮箱域}`, c.remark && `备注 ${c.remark.slice(0, 120)}`].filter(Boolean).join("；") || "（档案里没有别的线索）",
      };
    }
  }
  /*
    「粘贴询盘邮件」（第二期）：浏览器里已经从原文认出了几样（verify/mail.ts），原文不发过来。
    这里只收认得的字段；发件人、回复地址、签名里的电话和税号并进线索，和手填的一样去核
  */
  const 邮件 = 收邮件信号(body.mail);
  const 邮件线索: Partial<线索> | undefined = 邮件 && {
    邮箱: [邮件.发件人, 邮件.回复到].filter((x): x is string => Boolean(x)),
    电话: 邮件.电话,
    税号: 邮件.税号,
    官网: 邮件.发件人 && !是免费邮箱(邮件.发件人) ? 邮件.发件人.split("@")[1] : undefined,
  };
  // IP 库先拿起来（本机第一次要下载几秒）：等到拼真实性的时候多半已经好了
  if (邮件?.发件IP && 通道.通道.名 !== "模拟") void 取IP库();
  // 老客户里去掉它自己：不然从客户详情页背调一位老客户，「最像的老客户」永远是它本人
  const 老客户 = (await 老客户清单(b)).filter((c) => c.id !== 客户?.id);

  send({ type: "research-start", 扣次: 通道.通道.扣次, 通道: 通道.通道.名 });
  const r = await 跑背调({
    公司,
    客户,
    需求,
    线索: 合并线索(档案线索, 邮件线索, 认线索(需求), 认线索(公司)),
    邮件,
    // 模拟通道（e2e、演示）不下载真的 IP 库
    查IP: 通道.通道.名 === "模拟" ? 模拟查IP : 查发件IP,
    b,
    通道: 通道.通道,
    // 云端通道自带「打我们的网关」的模型调用（自己填了 Key 的也走我们的，照价扣）；模拟通道用本机配的模型
    模型: 通道.通道.模型调用 ?? { tools: chatTools, json: chatMessagesJSON },
    老客户,
    发: (e: 研究事件) => send({ type: "research", e }),
    signal,
  });
  if (!r.ok) return { ok: false, error: r.退了 ? `${r.error}（没扣次数）` : r.error };
  await recordAiUse(user, "research", `AI 背调：「${公司.slice(0, 60)}」（搜索 ${r.状态.usage.searches} 次、读 ${r.状态.usage.pages} 页${通道.通道.名 === "模拟" ? "，模拟数据" : ""}）`, 客户?.id);
  const 像的 = r.状态.similar?.items ?? [];
  return {
    ok: true,
    answer: {
      text: 报告文本(r.状态),
      records: [],
      // 「像你的老客户」那几位也算这次回答提到的人：对话里能直接点开
      customers: 像的.map((c) => ({ id: c.id, name: c.name, followStatus: "" })),
      proposals: [],
      research: r.状态,
    },
  };
}

/** 发件 IP 查国家：本机离线库（verify/ip-country.ts），IP 不发出去。库下不来 → 抛错，编排那边当「查不了」 */
async function 查发件IP(ip: string): Promise<string | null> {
  const 库 = await 取IP库();
  if (!库) throw new Error("IP 库没下下来");
  return 查IP(库, ip);
}

export type { 邮件信号 };
