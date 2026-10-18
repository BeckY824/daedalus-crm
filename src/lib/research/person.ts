import { randomUUID } from "node:crypto";
/**
 * 只有「人名 + 电话 / WhatsApp」、没有公司名的询盘（10-18 用户：「收到询盘时只有客户名字和 WhatsApp，没有公司」）。
 *
 * 先找公司，再背调：
 *   1. 判号码（libphonenumber，本机，不花钱、不扣次数）：哪国的、手机还是固话
 *   2. 搜号码本身（国际 / 带 (0) / 本国 / 连写 / 不带开头 0 几种写法），再搜「人名 + 国家」——**从这一步起算花了钱，扣 1 次**
 *      号码落在虚构号段（Ofcom 留给影视剧的 020 7946 0xxx 这类，verify/fiction.ts）：不搜号码、不拿它认公司；
 *      连名字都没有就不搜、不扣，直接出简版
 *   3. 模型从搜索结果里认出这个人 / 这个号码属于哪家公司，**程序再核一遍**：来源得是这次的搜索结果，
 *      那一条里得真有这个号码或这个名字、也真有那家公司的名字，对不上的候选不给
 *   4. 有候选：列出来让人点选（点选、接着跑正常背调都算同一次，不另扣，见 run.ts 的 接着）
 *      没有：出「只有人」的简版——号码归属国和类型、号码 / 名字在网上出现过的页面、「信息少，谨慎」和建议
 *
 * 边界（10-18 总控）：只查和做生意有关的公开信息（任职、所在公司、公司主页），不查、不写住址、家人、私人社交动态。
 * WhatsApp 没有公开查询的渠道：不登录、不抓取，只看号码在搜索结果里出没出现过。
 */
import { parsePhoneNumberFromString, type NumberType } from "libphonenumber-js/max";
import type { ToolMessage } from "../llm";
import type { BusinessConfig } from "../business-config";
import type { 背调通道 } from "./channel";
import type { 模型调用 } from "./run";
import { 找公司搜索次数, type 研究事件, type 来源, type 搜索结果 } from "./types";
import { 背调超时, 背调输出上限, 截, 全句 } from "./retry";
import { 国名 } from "./verify/country";
import { 主域名 } from "./verify/domain";
import { 名词, 提到了, 规整名 } from "./verify/names";
import type { 核验项 } from "./verify/types";
import { 虚构号段 } from "./verify/fiction";

export type 号码信息 = {
  /** 国际写法：「+971 50 123 4567」 */
  号: string;
  /** 本国写法：「050 123 4567」 */
  本国: string;
  /** 不带国家码的号码本体（比对用）：「501234567」 */
  本体: string;
  国家?: string;
  国名: string;
  类型: string;
  有效: boolean;
  /** 落在影视剧 / 示例专用的虚构号段（Ofcom 020 7946 0xxx 这类）：一句说明。这种号不拿去认公司，电话亮红 */
  虚构?: string;
};

const 类型名: Partial<Record<NumberType & string, string>> = {
  MOBILE: "手机",
  FIXED_LINE: "固话",
  FIXED_LINE_OR_MOBILE: "固话或手机",
  VOIP: "网络电话（虚拟号段）",
  TOLL_FREE: "免费电话",
  PERSONAL_NUMBER: "个人转接号",
  PREMIUM_RATE: "付费号码",
  SHARED_COST: "分摊费用号码",
  UAN: "统一接入号",
};

/** 认不出（不是 + 开头的国际号码、位数不对）返回 null */
export function 认号码(电话: string): 号码信息 | null {
  const n = parsePhoneNumberFromString(电话.trim());
  if (!n) return null;
  const 类 = n.getType();
  const 虚构 = 虚构号段(String(n.countryCallingCode), String(n.nationalNumber));
  return {
    号: n.formatInternational(),
    本国: n.formatNational(),
    本体: String(n.nationalNumber),
    国家: n.country,
    国名: n.country ? 国名(n.country) : "归属国认不出",
    类型: (类 && 类型名[类]) ?? "号码",
    有效: n.isValid(),
    ...(虚构 ? { 虚构 } : {}),
  };
}

/** 一段文字里有没有这个号码：把像电话的那几截抽出来去掉符号，结尾是号码本体就算（本体至少 7 位，防撞） */
export function 有号码(文字: string, 号: 号码信息): boolean {
  if (号.本体.length < 7) return false;
  for (const m of 文字.matchAll(/\+?\d[\d\s().\-/]{5,24}\d/g)) {
    if (m[0].replace(/\D/g, "").endsWith(号.本体)) return true;
  }
  // 连着写的（wa.me/971501234567、tel:+971501234567）
  return 文字.replace(/[\s().\-]/g, "").includes(号.本体);
}

/** 名字的每个词都在（「Ahmed Khan」→ ahmed、khan 都出现）。至少 2 个字母的词才算 */
export function 有名字(文字: string, 名: string | undefined): boolean {
  const 词 = 人名词(名);
  if (!词.length) return false;
  const 文 = ` ${人名词(文字).join(" ")} `;
  return 词.every((w) => 文.includes(` ${w} `));
}

function 人名词(s: string | undefined): string[] {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * 给人看的「出现过」只列和做生意有关的页面：公司官网、名录、B2B 平台、LinkedIn、Facebook 公司页。
 * 私人社交（Instagram、TikTok、X、Facebook 个人页）不列——那不是我们要查的东西
 */
export function 是私人社交(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const h = u.hostname.replace(/^(www|m|mobile)\./, "");
  if (/(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|threads\.net|snapchat\.com|vk\.com|pinterest\.com)$/.test(h)) return true;
  if (/(^|\.)facebook\.com$/.test(h)) return /^\/(profile\.php|people\/|groups\/|photo|story\.php|permalink\.php)/.test(u.pathname);
  return false;
}

export type 候选公司 = {
  公司: string;
  官网?: string;
  /** 这个人在那家公司的职位（材料里写了才有） */
  职位?: string;
  /** 凭什么认的一句话（模型写，程序核过来源） */
  依据: string;
  来源: 来源;
  /** 程序核的：那一条里有这个号码 / 有这个名字 */
  号码对上: boolean;
  名字对上: boolean;
};

export type 出现 = { 号码: 来源[]; 名字: 来源[] };

export type 找公司输入 = {
  名?: string;
  电话: string;
  b: Pick<BusinessConfig, "brief">;
  通道: 背调通道;
  模型: 模型调用;
  发: (e: 研究事件) => void;
  signal?: AbortSignal;
  runId?: string;
};

export type 找公司结果 =
  | { ok: true; runId: string; 候选: 候选公司[]; 出现: 出现; 材料: 搜索结果[] }
  | { ok: false; error: string; 退了: boolean };

/** 国家的英文名，拿去搜（「UAE」比「阿联酋」搜得到） */
function 英文国名(码?: string): string {
  if (!码) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(码) ?? "";
  } catch {
    return "";
  }
}

/**
 * 号码的几种常见写法（10-18 复核：sunrgy.co.uk 写的是「0114 327 1314」，只搜「+44 114 327 1314」搜不到）：
 * 国际「+44 114 327 1314」、带 (0) 的「+44 (0)114 327 1314」、本国「0114 327 1314」、连写「01143271314」、
 * 不带开头 0 的「114 327 1314」
 */
export function 号码写法(号: 号码信息): { 国际: string[]; 本国: string[]; 去零: string } {
  const 码 = 号.号.match(/^\+(\d+)\s/)?.[1] ?? "";
  const 有零 = /^0/.test(号.本国);
  const 去零 = 有零 ? 号.本国.replace(/^0\s?/, "") : 号.本国;
  const 国际 = [号.号, ...(码 && 有零 ? [`+${码} (0)${去零}`] : [])];
  const 本国 = [号.本国, 号.本国.replace(/\D/g, "")];
  return { 国际: [...new Set(国际)], 本国: [...new Set(本国)], 去零 };
}

/**
 * 搜什么：号码的国际写法（加 (0) 的）、本国写法（连写的）、不带开头 0 的那串，再加「人名 + 国家」。
 * 同一类写法 OR 在一次搜索里，一共不超过 找公司搜索次数。
 * 虚构号码（影视剧号段）不搜：搜到的只会是拿它当占位符的网页，认出来的公司是错的（10-18 复核 Anna 那一家）
 */
export function 找公司查询(名: string | undefined, 号: 号码信息): string[] {
  const q: string[] = [];
  if (!号.虚构) {
    const 写 = 号码写法(号);
    const 或 = (列: string[]) => 列.map((x) => `"${x}"`).join(" OR ");
    q.push(或(写.国际), 或(写.本国));
    if (写.去零 !== 号.本国) q.push(写.去零);
  }
  const 名字 = 名?.trim();
  if (名字) q.push(`"${名字}" ${英文国名(号.国家)}`.trim());
  return [...new Set(q)].slice(0, 找公司搜索次数);
}

const 要 =
  '{"候选":[{"公司":"公司名（材料里原样写的）","官网":"网址或空","职位":"这个人的职位或空","依据":"一句话：号码出现在哪 / 名字和公司怎么一起出现的","来源":"材料编号"}]}';

export async function 找公司(input: 找公司输入): Promise<找公司结果> {
  const runId = input.runId ?? randomUUID();
  const { 通道, signal } = input;
  const 号 = 认号码(input.电话);
  if (!号) return { ok: false, error: "这个号码认不出来：要 + 开头、带国家码的国际号码", 退了: false };
  input.发({ type: "person", 名: input.名?.trim() || undefined, 号 });

  // 只有一个虚构号码：没东西可搜，直接出简版。没花钱，不扣（不调 开始）
  const 查询们 = 找公司查询(input.名, 号);
  if (!查询们.length) {
    const 出: 出现 = { 号码: [], 名字: [] };
    input.发({ type: "person-found", 候选: [], 出现: 出, 建议: 简版建议(号, 出, false) });
    input.发({ type: "done", charge: 0, 不完整: false });
    return { ok: true, runId, 候选: [], 出现: 出, 材料: [] };
  }

  const 开 = await 通道.开始(runId, signal);
  if (!开.ok) return { ok: false, error: 开.error, 退了: false };

  const 材料: 搜索结果[] = [];
  let 搜索数 = 0;
  let 出错: string | null = null;
  try {
    for (const [i, q] of 查询们.entries()) {
      if (signal?.aborted) throw new DOMException("已停止", "AbortError");
      const id = `p${i + 1}`;
      const label = `搜索「${截(q, 60)}」`;
      const t0 = Date.now();
      input.发({ type: "tool", stage: "person", id, kind: "search", label, status: "running" });
      try {
        搜索数 += 1;
        const rs = (await 通道.搜索(runId, q, signal)).filter((r) => /^https?:\/\//i.test(r.url));
        for (const r of rs) if (!材料.some((m) => m.url === r.url)) 材料.push(r);
        input.发({ type: "tool", stage: "person", id, kind: "search", label, status: "done", result: `${rs.length} 条结果`, ms: Date.now() - t0, sources: rs.filter((r) => !是私人社交(r.url)).slice(0, 6).map((r) => ({ title: r.title || r.url, url: r.url })) });
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : "搜索出错";
        input.发({ type: "tool", stage: "person", id, kind: "search", label, status: "error", result: 全句(msg, 120), ms: Date.now() - t0 });
      }
      input.发({ type: "usage", searches: 搜索数, pages: 0 });
    }

    const 全文 = (r: 搜索结果) => `${r.title}\n${r.snippet ?? ""}\n${r.url}`;
    const 号对 = (r: 搜索结果) => !号.虚构 && 有号码(全文(r), 号);
    const 出: 出现 = {
      号码: 材料.filter((r) => !是私人社交(r.url) && 号对(r)).slice(0, 8).map((r) => ({ title: r.title || r.url, url: r.url })),
      名字: 材料.filter((r) => !是私人社交(r.url) && 有名字(全文(r), input.名)).slice(0, 8).map((r) => ({ title: r.title || r.url, url: r.url })),
    };
    // 号码和名字一条都没对上：不用再问模型（问了也只能编），直接出简版
    const 有用 = 材料.filter((r) => !是私人社交(r.url) && (号对(r) || 有名字(全文(r), input.名)));
    let 候选: 候选公司[] = [];
    if (有用.length) {
      const messages: ToolMessage[] = [
        {
          role: "system",
          content:
            "你在帮一家外贸公司认一位询盘客户在哪家公司（客户只留了名字和电话）。只依据下面的搜索结果说话，不许编。" +
            "只写和做生意有关的公开信息：公司名、公司官网、职位。不写住址、家人、私人社交动态，也不要猜。" +
            "号码出现在公司官网 / 名录 / B2B 平台 / 展会名录 / 公司主页上，或者名字和公司一起出现（比如「姓名 - 职位 - 公司」），才算认出；拿不准的不写。",
        },
        {
          role: "user",
          content:
            `名字：${input.名?.trim() || "（没给）"}\n电话：${号.号}（${号.国名}${号.类型}）${号.虚构 ? `——这是虚构号码（${号.虚构}），网页上出现它只是占位符，不能拿号码认公司，只看名字` : ""}\n\n搜索结果：\n` +
            有用.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet ?? "").slice(0, 400)}`).join("\n\n") +
            `\n\n只输出 JSON，最多 4 家，认不出就空数组：${要}`,
        },
      ];
      const raw = (await input.模型.json(messages, { model: 通道.摘要模型 ?? 通道.模型, signal, requestId: runId, feature: "research", researchStage: "person", temperature: 0, thinking: false, timeoutMs: 背调超时.模型每次, maxTokens: 背调输出上限 })) as Record<string, unknown> | null;
      候选 = 核候选(raw?.候选, 有用, input.名, 号);
    }
    // 建议总是带上：有候选、人点了「都不是」也要出简版
    input.发({ type: "person-found", 候选, 出现: 出, 建议: 简版建议(号, 出) });
    // 有候选：等人点选，这一次背调还没完（不收尾；点选后接着跑，同一个 runId）。没有：出简版，收尾。
    // 简版也扣（10-18 用户：「我们花钱就扣」）：搜索已经花了钱；服务器见到搜过就不退
    if (!候选.length) {
      const 收 = await 通道.收尾(runId, true, { searches: 搜索数, pages: 0 });
      input.发({ type: "done", charge: 通道.扣次, 不完整: false, 退了: (收?.退了 ?? 0) > 0 });
    }
    return { ok: true, runId, 候选, 出现: 出, 材料: 有用 };
  } catch (e) {
    出错 = signal?.aborted ? "已停止" : e instanceof Error ? e.message : "找公司出错了";
  }
  // 停了 / 出错：退不退服务器判断（没花钱不扣；我们这边出错退；用户自己停的、钱花了照扣）
  const 收 = await 通道.收尾(runId, false, { searches: 搜索数, pages: 0, 取消: Boolean(signal?.aborted) });
  return { ok: false, error: 出错 ?? "找公司出错了", 退了: (收?.退了 ?? 0) > 0 };
}

/** 模型给的候选 → 程序核过的。来源得是这次的结果；那一条里得有号码或名字，还得真提到这家公司 */
export function 核候选(原始: unknown, 结果: 搜索结果[], 名: string | undefined, 号: 号码信息): 候选公司[] {
  const 列 = Array.isArray(原始) ? 原始 : [];
  const 出: 候选公司[] = [];
  for (const x of 列) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const 公司 = typeof o.公司 === "string" ? o.公司.trim() : "";
    if (公司.length < 2 || 公司.length > 120) continue;
    const 号源 = typeof o.来源 === "number" ? o.来源 : Number(String(o.来源 ?? "").replace(/[^\d]/g, ""));
    const r = Number.isInteger(号源) && 号源 >= 1 ? 结果[号源 - 1] : 结果.find((m) => m.url === o.来源);
    if (!r) continue;
    const 文 = `${r.title}\n${r.snippet ?? ""}\n${r.url}`;
    // 虚构号码出现在页面上只是占位符，不算对上
    const 号码对上 = !号.虚构 && 有号码(文, 号);
    const 名字对上 = 有名字(文, 名);
    if (!号码对上 && !名字对上) continue;
    // 那一条里得真有这家公司：名字提到了，或者网址就是它的域名（「alfanar.com/contact」）
    const 域 = 主域名(r.url) ?? "";
    const 在 = 提到了(`${r.title}\n${r.snippet ?? ""}`, 公司) || (名词(公司).join("").length >= 3 && 域.replace(/[^a-z0-9]/g, "").includes(名词(公司).join("")));
    if (!在) continue;
    const 官网 = typeof o.官网 === "string" && /^https?:\/\/\S+$|^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(o.官网.trim()) ? o.官网.trim() : undefined;
    const 职位 = typeof o.职位 === "string" && o.职位.trim() && 名字对上 ? o.职位.trim().slice(0, 60) : undefined;
    const 这家: 候选公司 = {
      公司,
      ...(官网 ? { 官网 } : {}),
      ...(职位 ? { 职位 } : {}),
      依据: typeof o.依据 === "string" && o.依据.trim() ? o.依据.trim().slice(0, 200) : 号码对上 ? "号码出现在这一页上" : "名字和这家公司一起出现",
      来源: { title: r.title || r.url, url: r.url },
      号码对上,
      名字对上,
    };
    // 同一家从两条结果认出来（名录上有号码、LinkedIn 上有名字）：并成一家，来源用号码对上的那条
    const i = 出.findIndex((c) => 规整名(c.公司) === 规整名(公司));
    if (i >= 0) {
      const 旧 = 出[i];
      const 主 = !旧.号码对上 && 号码对上 ? 这家 : 旧;
      出[i] = { ...主, 号码对上: 旧.号码对上 || 号码对上, 名字对上: 旧.名字对上 || 名字对上, ...(旧.职位 ?? 职位 ? { 职位: 旧.职位 ?? 职位 } : {}), ...(旧.官网 ?? 官网 ? { 官网: 旧.官网 ?? 官网 } : {}) };
      continue;
    }
    if (出.length >= 4) continue;
    出.push(这家);
  }
  // 号码对上的排前面（比名字撞名可靠）
  return 出.sort((a, b) => Number(b.号码对上) - Number(a.号码对上));
}

/** 「只有人」简版的建议：代码给，不交给模型（固定几条，按实情挑） */
export function 简版建议(号: 号码信息, 出: 出现, 扣了 = true): string[] {
  const 建: string[] = [];
  if (号.虚构) 建.push(`这个号码是虚构号码（${号.虚构}），不会分给任何真实用户：对方留的联系方式不可信，先要真实的公司电话和公司邮箱`);
  建.push(
    `先请对方给公司全名和官网，拿到后再背调公司（${扣了 ? "这次已经扣过，再背调公司会另扣 1 次" : "这次没搜索、没扣次数"}）`,
    "请对方用公司邮箱发一封邮件（看邮箱域名是不是公司自己的），或发营业执照 / 公司登记号",
  );
  if (号.类型.startsWith("网络电话") || 号.类型 === "个人转接号") 建.push("这个号码是虚拟号段，常用来注册账号，务必先核实身份");
  if (!出.号码.length && !出.名字.length) 建.push("号码和名字在网上都没出现过：首单小额、预付或信用证，别先发货");
  else 建.push("视频看一下办公室 / 仓库；首单小额、预付或信用证");
  return 建;
}

/**
 * 真实性里「人和号码」那一项（10-18 总控：「这个号码 / 这个人和这家公司对得上吗」，附来源）。代码判，不经模型：
 *   🟢 号码出现在提到这家公司的页面上，或者就在它官网上
 *   🟡 号码没对上，只有名字和这家公司一起出现过（同名的人可能很多）
 *   🟡 号码、名字都没在这家公司的页面上出现：对不上，请对方用公司邮箱确认
 *   🔴 号码是虚构号码（影视剧号段）
 */
export function 人号项(人: { 名?: string; 号: 号码信息 }, 公司: string, 官网域: string | undefined, 材料: { title: string; url: string; text: string }[]): 核验项 {
  const 是它的 = (m: { title: string; url: string; text: string }) => 提到了(`${m.title}\n${m.text}`, 公司) || Boolean(官网域 && 主域名(m.url) === 官网域);
  const 全 = (m: { title: string; url: string; text: string }) => `${m.title}\n${m.text}\n${m.url}`;
  const 页 = (列: { title: string; url: string }[]) => [...new Map(列.map((m) => [m.url, { title: m.title || m.url, url: m.url }])).values()].slice(0, 3);
  // 虚构号码（影视剧号段）：哪怕出现在这家公司的页面上，也只是占位符——亮红，不算对上（10-18 复核 Anna 那一家）
  if (人.号.虚构)
    return { key: "person", 灯: "red", 态: "已核", 事实: `号码 ${人.号.号} 是虚构号码（${人.号.虚构}），不会分给任何真实用户，不能用它确认这个人和 ${公司} 的关系；请对方给真实的公司电话，并用公司邮箱发一封邮件` };
  const 号页 = 页(材料.filter((m) => !是私人社交(m.url) && 是它的(m) && 有号码(全(m), 人.号)));
  if (号页.length) return { key: "person", 灯: "green", 态: "已核", 事实: `号码 ${人.号.号} 出现在提到 ${公司} 的公开页面上（${号页.map((x) => 全句(x.title, 80)).join("；")}），对得上`, 链接: 号页 };
  const 名页 = 人.名 ? 页(材料.filter((m) => !是私人社交(m.url) && 是它的(m) && 有名字(全(m), 人.名))) : [];
  if (名页.length)
    return { key: "person", 灯: "yellow", 态: "已核", 事实: `号码 ${人.号.号} 没在这家公司的公开页面上出现；只有名字「${人.名}」和 ${公司} 一起出现过（同名的人可能很多），请对方用公司邮箱发一封邮件确认`, 链接: 名页 };
  return { key: "person", 灯: "yellow", 态: "没查到", 事实: `号码 ${人.号.号}${人.名 ? `和名字「${人.名}」` : ""}都没在 ${公司} 的公开页面上出现，对不上；请对方用公司邮箱发一封邮件，或给公司座机回个电话确认` };
}
