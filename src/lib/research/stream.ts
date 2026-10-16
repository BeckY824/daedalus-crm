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

export type 背调回答 = { text: string; records: []; customers: { id: string; name: string; followStatus: string }[]; proposals: []; research: 背调状态 };

/** 公司名：2–120 字，去掉两头的引号和空白 */
export function 收公司名(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[「『“"']+|[」』”"']+$/g, "").trim();
  return s.length >= 2 && s.length <= 120 ? s : null;
}

export async function 背调一次(
  body: { company: unknown; customerId?: unknown; need?: unknown },
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
  if (typeof body.customerId === "string" && body.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true, name: true, remark: true, extra: { select: { country: true, email: true } } } });
    if (c) {
      const 邮箱域 = c.extra?.email?.split("@")[1];
      客户 = {
        id: c.id,
        已知: [c.extra?.country && `国家 ${c.extra.country}`, 邮箱域 && `邮箱域名 ${邮箱域}`, c.remark && `备注 ${c.remark.slice(0, 120)}`].filter(Boolean).join("；") || "（档案里没有别的线索）",
      };
    }
  }
  // 老客户里去掉它自己：不然从客户详情页背调一位老客户，「最像的老客户」永远是它本人
  const 老客户 = (await 老客户清单(b)).filter((c) => c.id !== 客户?.id);

  send({ type: "research-start", 扣次: 通道.通道.扣次, 通道: 通道.通道.名 });
  const r = await 跑背调({
    公司,
    客户,
    需求: typeof body.need === "string" && body.need.trim() ? body.need.trim().slice(0, 300) : undefined,
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
