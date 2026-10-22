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
import { 初始状态, 归约, type 背调状态 } from "./state";
import { 合并线索, 认线索, type 线索 } from "./verify/clues";
import { 收邮件信号, type 邮件信号 } from "./verify/mail";
import { 是免费邮箱, 主机 } from "./verify/domain";
import { 取IP库, 查IP } from "./verify/ip-country";
import { 模拟查IP } from "./mock";
import { 找公司, 认号码, type 候选公司, type 出现 } from "./person";
import { 客户背调对象 } from "./subject";
import type { 搜索结果 } from "./types";

export type 背调回答 = { text: string; records: []; customers: { id: string; name: string; followStatus: string }[]; proposals: []; research: 背调状态 };

/** 公司名：2–120 字，去掉两头的引号和空白 */
export function 收公司名(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[「『“"']+|[」』”"']+$/g, "").trim();
  return s.length >= 2 && s.length <= 120 ? s : null;
}

/** runId 和网关同一个规矩：1–64 位 [A-Za-z0-9_-] */
const 收runId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined);

const 收来源 = (v: unknown): { title: string; url: string } | null => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return typeof o.url === "string" && /^https?:\/\/\S+$/i.test(o.url) ? { title: typeof o.title === "string" ? o.title.slice(0, 300) : o.url, url: o.url } : null;
};

/** 找公司时点选的那一家（浏览器回传的，形状不对就当没给） */
export function 收接着(v: unknown): { 名?: string; 电话: string; 候选: 候选公司; 出现: 出现; 证据: 搜索结果[] } | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.phone !== "string") return null;
  const c = o.候选 && typeof o.候选 === "object" ? (o.候选 as Record<string, unknown>) : null;
  const 源 = 收来源(c?.来源);
  const 公司 = 收公司名(c?.公司);
  if (!c || !源 || !公司) return null;
  const 列 = (x: unknown) => (Array.isArray(x) ? x.map(收来源).filter((y): y is { title: string; url: string } => Boolean(y)).slice(0, 8) : []);
  const 出 = o.出现 && typeof o.出现 === "object" ? (o.出现 as Record<string, unknown>) : {};
  const 证据 = (Array.isArray(o.证据) ? o.证据 : [])
    .flatMap((r) => {
      const x = 收来源(r);
      const sn = r && typeof r === "object" ? (r as Record<string, unknown>).snippet : undefined;
      return x ? [{ ...x, snippet: typeof sn === "string" ? sn.slice(0, 1000) : "" }] : [];
    })
    .slice(0, 4);
  return {
    名: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : undefined,
    电话: o.phone.slice(0, 40),
    候选: {
      公司,
      ...(typeof c.官网 === "string" && c.官网 ? { 官网: c.官网.slice(0, 200) } : {}),
      ...(typeof c.职位 === "string" && c.职位 ? { 职位: c.职位.slice(0, 60) } : {}),
      依据: typeof c.依据 === "string" ? c.依据.slice(0, 200) : "",
      来源: 源,
      号码对上: c.号码对上 === true,
      名字对上: c.名字对上 === true,
    },
    出现: { 号码: 列(出.号码), 名字: 列(出.名字) },
    证据,
  };
}

export type 找人回答 = { text: string; records: []; customers: []; proposals: []; research: 背调状态; runId?: string; 材料: 搜索结果[] };

/**
 * 只有人名 + 电话（person.ts）：先找公司。有候选就把 runId 和认出候选的那几条搜索结果交回浏览器，
 * 人点选以后带着它们再来一次（body.pick），同一个 runId 接着背调、不另扣
 */
async function 找人一次(
  body: { person: unknown; need?: unknown },
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<{ ok: true; answer: 找人回答 } | { ok: false; error: string }> {
  const p = body.person && typeof body.person === "object" ? (body.person as Record<string, unknown>) : {};
  const 电话 = typeof p.phone === "string" ? p.phone.trim().slice(0, 40) : "";
  const 名 = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : undefined;
  const 号 = 认号码(电话);
  if (!号) return { ok: false, error: "这个号码认不出来：要 + 开头、带国家码的国际号码" };
  const user = await requireUser();
  const wait = consumeUserAiQuota(user);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };
  const 通道 = await 选通道();
  if (!通道.ok) return { ok: false, error: 通道.error };
  const b = await getBusiness();
  send({ type: "research-start", 扣次: 通道.通道.扣次, 通道: 通道.通道.名 });
  let 状态 = 初始状态({ name: 名 ?? 号.号 });
  const r = await 找公司({
    名,
    电话,
    b,
    通道: 通道.通道,
    模型: 通道.通道.模型调用 ?? { tools: chatTools, json: chatMessagesJSON },
    发: (e: 研究事件) => {
      状态 = 归约(状态, e);
      send({ type: "research", e });
    },
    signal,
  });
  if (!r.ok) return { ok: false, error: r.退了 ? `${r.error}（没扣次数）` : r.error };
  await recordAiUse(user, "research", `AI 背调·找公司：${名 ? `「${名.slice(0, 40)}」` : ""}${号.号}（搜索 ${状态.usage.searches} 次，认出 ${r.候选.length} 家${通道.通道.名 === "模拟" ? "，模拟数据" : ""}）`);
  return { ok: true, answer: { text: 报告文本(状态), records: [], customers: [], proposals: [], research: 状态, runId: r.runId, 材料: r.材料 } };
}

export async function 背调一次(
  body: { company: unknown; customerId?: unknown; need?: unknown; mail?: unknown; person?: unknown; runId?: unknown; pick?: unknown },
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<{ ok: true; answer: 背调回答 | 找人回答 } | { ok: false; error: string }> {
  if (body.person && !body.company) return 找人一次({ person: body.person, need: body.need }, send, signal);
  let 公司 = 收公司名(body.company);
  if (!公司) return { ok: false, error: "要背调的公司名写得不对（2–120 个字）" };
  const user = await requireUser();
  const wait = consumeUserAiQuota(user);
  if (wait !== null) return { ok: false, error: `AI 调用太频繁，请 ${wait} 秒后再试` };

  const 通道 = await 选通道();
  if (!通道.ok) return { ok: false, error: 通道.error };
  const b = await getBusiness();

  /*
    从客户详情页发起：背调谁以档案为准（subject.ts），不信浏览器传来的公司名——10-21 客户反馈，以前拿客户名（人名）当公司查。
    档案里已有的线索带上，帮第一步认准（同名公司很常见）。查不到这位就当没给——可能刚被删，或者看不到
  */
  let 客户: { id: string; 已知: string } | undefined;
  let 联系人: string | undefined;
  const 收 = 收接着(body.pick);
  const 需求 = typeof body.need === "string" && body.need.trim() ? body.need.trim().slice(0, 300) : undefined;
  /* 真实性核对要的对方自报的东西：档案里的邮箱 / 电话 / WhatsApp / 官网 / 国家，加上那句话里贴的（verify/clues.ts） */
  let 档案线索: Partial<线索> | undefined;
  if (typeof body.customerId === "string" && body.customerId) {
    const c = await prisma.customer.findUnique({
      where: { id: body.customerId },
      select: { id: true, name: true, school: true, remark: true, phone: true, extra: { select: { country: true, email: true, whatsapp: true, website: true } } },
    });
    if (c) {
      const 对象 = 客户背调对象({ name: c.name, company: c.school, country: c.extra?.country, website: c.extra?.website, phone: c.phone, whatsapp: c.extra?.whatsapp }, b.fields.school);
      if (对象.种类 === "公司") {
        公司 = 对象.公司;
        联系人 = 对象.联系人;
      } else if (!收 || 收.候选.公司 !== 公司) {
        // 没公司：只能先「名字 + 电话找公司」点选了候选再来（body.pick）；直接拿客户名来背调的不跑、不扣
        return { ok: false, error: 对象.种类 === "找人" ? "这位客户没填公司：要先按名字和电话找到他在哪家公司（没扣次数）" : `${对象.原因}（没扣次数）` };
      }
      档案线索 = {
        邮箱: c.extra?.email ? [c.extra.email] : [],
        电话: [c.phone, c.extra?.whatsapp].filter((x): x is string => Boolean(x?.trim())),
        官网: c.extra?.website ?? undefined,
        国家: c.extra?.country ?? undefined,
      };
      const 邮箱域 = c.extra?.email?.split("@")[1];
      客户 = {
        id: c.id,
        已知: [联系人 && `联系人 ${联系人}（这家公司里的人，不是公司名，别拿去当公司查）`, c.extra?.country && `国家 ${c.extra.country}`, 邮箱域 && `邮箱域名 ${邮箱域}`, c.remark && `备注 ${c.remark.slice(0, 120)}`].filter(Boolean).join("；") || "（档案里没有别的线索）",
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

  /* 只有人名 + 电话、找公司时点选了这家：同一个 runId 接着跑（服务器认得这笔、不另扣），号码并进线索去核 */
  const 号 = 收 ? 认号码(收.电话) : null;
  const 接着 = 收 && 号 && 收.候选.公司 === 公司 ? { 人: { 名: 收.名, 号 }, 候选: 收.候选, 出现: 收.出现, 证据: 收.证据 } : undefined;
  const runId = 接着 ? 收runId(body.runId) : undefined;
  send({ type: "research-start", 扣次: runId ? 0 : 通道.通道.扣次, 通道: 通道.通道.名 });
  const r = await 跑背调({
    公司,
    客户,
    联系人,
    需求,
    ...(接着 && runId ? { 接着, runId } : {}),
    线索: 合并线索(档案线索, 邮件线索, 认线索(需求), 认线索(公司), 接着 ? { 电话: [接着.人.号.号], 官网: 接着.候选.官网 ? 主机(接着.候选.官网) : undefined } : undefined),
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
