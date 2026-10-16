import { createHash } from "node:crypto";
import type { 网关配置 } from "@/lib/gateway";
import { 抹掉密钥 } from "@/lib/secret";
import type { 搜索结果 } from "./types";

/**
 * 背调的搜索服务（服务器这一头，api/gateway/v1/research/search 用）。
 *
 * 不接单独的搜索 API：中转站自带搜索（10-16 用户定），Key 就是模型网关那一把（GATEWAY_API_KEY），
 * 不多一把要保管的钥匙。10-16 在真中转站上试过两条能用的路：
 *   Claude  POST {根}/v1/messages，工具 web_search_20250305（Anthropic 原生格式）
 *   GPT     POST {baseUrl}/responses，工具 web_search（OpenAI Responses 格式）
 * chat/completions + web_search_options 那条不行，别再试。
 *
 * 两家都是「让模型搜一次、再把结果列出来」：结果本身来自搜索工具的返回（标题、网址、时间），
 * 摘要优先用模型引用的原文——模型自己写的话可能编，引用原文不会。
 *
 * 报错一律不带 Key（抹掉密钥）：有的中转站鉴权失败会把收到的 Key 回显在错误体里。
 */

export type 搜索用量 = { model: string; input: number; output: number };
export type 搜索服务 = {
  名: string;
  search(query: string, opts: { signal?: AbortSignal }): Promise<{ results: 搜索结果[]; usage?: 搜索用量 }>;
};

/** 搜索服务出的错。message 只进日志（已抹 Key），给用户看的话由路由另写 */
export class 搜索出错 extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "搜索出错";
  }
}

/** 一次搜索最多回几条：多了模型读不过来，token 也白花 */
export const 每次最多条 = 8;
/** 单次上游调用的超时。带搜索的模型调用比普通问答慢得多，实测 10–30 秒 */
const 超时毫秒 = 45_000;
export const 默认搜索模型 = { claude: "claude-sonnet-5.5", gpt: "gpt-5.5" } as const;

function 提示词(query: string): string {
  return [
    `用网页搜索工具搜一次：${query}`,
    "搜完按相关度列出最相关的结果（最多 8 条），每条一行，格式：标题 | 网址 | 一句话说它讲了什么。",
    "只列搜索结果里真有的网页，不要编造网址，不要多写别的。",
  ].join("\n");
}

/** 去重用的键：去掉 #后面 和末尾的 /，大小写不同的主机名算一个 */
function 网址键(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

/** GPT 给的链接会带 utm_source=openai，存进报告里的来源不该带这个 */
function 去追踪参数(u: string): string {
  try {
    const x = new URL(u);
    if (x.searchParams.get("utm_source") === "openai") x.searchParams.delete("utm_source");
    return x.toString();
  } catch {
    return u;
  }
}

/** 摘要清一下：去 markdown 链接和粗体、合并空白、截到 300 字 */
function 清摘要(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** 模型自己写的那段话里，提到这个网址的那一行（「标题 | 网址 | 一句话」），拿来兜底当摘要 */
function 从正文找摘要(正文: string, url: string): string {
  const 行 = 正文.split("\n").find((l) => l.includes(url));
  if (!行) return "";
  const 段 = 行.split("|").map((x) => x.trim());
  // 按提示词的格式，第三段是那一句话；格式没对上就整行清一清
  return 清摘要(段.length >= 3 ? 段.slice(2).join(" ") : 行);
}

/** 把上游的失败变成 搜索出错。正文截短、抹 Key */
async function 上游失败(res: Response, 哪家: string, key: string): Promise<搜索出错> {
  const text = 抹掉密钥((await res.text().catch(() => "")).slice(0, 300), key);
  return new 搜索出错(`${哪家} 搜索上游返回 ${res.status}：${text}`, res.status);
}

async function 发请求(url: string, init: RequestInit, 哪家: string, key: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(超时毫秒)]) : AbortSignal.timeout(超时毫秒) });
  } catch (e) {
    const 超时 = e instanceof Error && e.name === "TimeoutError";
    throw new 搜索出错(`${哪家} 搜索${超时 ? "超时" : "连不上"}：${抹掉密钥(e instanceof Error ? e.message : String(e), key)}`);
  }
  if (!res.ok) throw await 上游失败(res, 哪家, key);
  try {
    return await res.json();
  } catch {
    throw new 搜索出错(`${哪家} 搜索返回的不是 JSON`, 502);
  }
}

/* ---------------- Claude：/v1/messages + web_search_20250305 ---------------- */

type Claude块 =
  | { type: "text"; text?: string; citations?: { type?: string; url?: string; title?: string; cited_text?: string }[] }
  | { type: "web_search_tool_result"; content?: unknown }
  | { type: string; [k: string]: unknown };

/** 解析一份 Claude messages 回应。单独导出给测试用 */
export function 解析Claude回应(data: unknown): 搜索结果[] {
  const 块们 = ((data as { content?: unknown })?.content ?? []) as Claude块[];
  if (!Array.isArray(块们)) return [];
  const 引用 = new Map<string, string[]>();
  let 正文 = "";
  const 引用顺序: { url: string; title: string }[] = [];
  for (const b of 块们) {
    if (b.type !== "text") continue;
    const t = b as Extract<Claude块, { type: "text" }>;
    正文 += t.text ?? "";
    for (const c of t.citations ?? []) {
      if (c.type !== "web_search_result_location" || !c.url) continue;
      const k = 网址键(c.url);
      if (c.cited_text) 引用.set(k, [...(引用.get(k) ?? []), c.cited_text]);
      引用顺序.push({ url: c.url, title: c.title ?? "" });
    }
  }

  const 出: 搜索结果[] = [];
  const 见过 = new Set<string>();
  const 加 = (url: string, title: string, published?: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    const k = 网址键(url);
    if (见过.has(k) || 出.length >= 每次最多条) return;
    见过.add(k);
    const 原文 = 引用.get(k);
    const snippet = 原文?.length ? 清摘要(原文.slice(0, 2).join(" … ")) : 从正文找摘要(正文, url);
    出.push({ title: title.trim() || url, url, snippet, ...(published ? { published } : {}) });
  };

  for (const b of 块们) {
    if (b.type !== "web_search_tool_result") continue;
    const items = (b as { content?: unknown }).content;
    // 搜索工具出错时 content 是一个 { type: "web_search_tool_result_error", error_code } 对象，不是数组
    if (!Array.isArray(items)) continue;
    for (const r of items as { type?: string; url?: string; title?: string; page_age?: string | null }[]) {
      if (r.type === "web_search_result" && r.url) 加(r.url, r.title ?? "", r.page_age ?? undefined);
    }
  }
  // 引用了、但不在搜索结果列表里的（多轮搜索时会有）也收进来
  for (const c of 引用顺序) 加(c.url, c.title);
  return 出;
}

/** 搜索工具自己报错（额度、超时、查询太长）：content 不是数组而是一个错误对象 */
function Claude搜索工具错误(data: unknown): string | null {
  const 块们 = (data as { content?: unknown })?.content;
  if (!Array.isArray(块们)) return null;
  for (const b of 块们 as Claude块[]) {
    if (b.type !== "web_search_tool_result") continue;
    const c = (b as { content?: { type?: string; error_code?: string } }).content;
    if (c && !Array.isArray(c) && c.type === "web_search_tool_result_error") return c.error_code ?? "unknown";
  }
  return null;
}

export function claude搜索(cfg: 网关配置, model: string = 默认搜索模型.claude): 搜索服务 {
  // cfg.baseUrl 是 OpenAI 那套的根（…/v1）；Anthropic 的路径自己带 /v1，去掉一层再拼
  const 根 = cfg.baseUrl.replace(/\/v1\/?$/, "");
  return {
    名: "claude",
    async search(query, opts) {
      const data = await 发请求(
        `${根}/v1/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 中转站有的认 x-api-key（Anthropic 原生），有的认 Bearer，10-16 实测两个都带最稳
            "x-api-key": cfg.apiKey,
            Authorization: `Bearer ${cfg.apiKey}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            // max_uses: 1——一次 search 就是一次真搜索，次数闸（背调上限.搜索）才数得准，账也算得清
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
            messages: [{ role: "user", content: 提示词(query) }],
          }),
        },
        "Claude",
        cfg.apiKey,
        opts.signal,
      );
      const 工具错 = Claude搜索工具错误(data);
      const results = 解析Claude回应(data);
      if (工具错 && results.length === 0) throw new 搜索出错(`Claude 搜索工具报错：${工具错}`, 502);
      const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown }; model?: unknown }).usage;
      const usage =
        u && typeof u.input_tokens === "number"
          ? { model: String((data as { model?: unknown }).model ?? model), input: u.input_tokens, output: typeof u.output_tokens === "number" ? u.output_tokens : 0 }
          : undefined;
      return { results, usage };
    },
  };
}

/* ---------------- GPT：/responses + web_search ---------------- */

type GPT注释 = { type?: string; url?: string; title?: string; start_index?: number; end_index?: number };

/** 解析一份 OpenAI Responses 回应。单独导出给测试用 */
export function 解析GPT回应(data: unknown): 搜索结果[] {
  const output = (data as { output?: unknown })?.output;
  if (!Array.isArray(output)) return [];
  const 出: 搜索结果[] = [];
  const 见过 = new Set<string>();
  const 收 = (r: 搜索结果) => {
    const k = 网址键(r.url);
    if (见过.has(k) || 出.length >= 每次最多条) return;
    见过.add(k);
    出.push(r);
  };
  type 项 = { type?: string; action?: { sources?: { type?: string; url?: string }[] }; content?: { type?: string; text?: string; annotations?: GPT注释[] }[] };
  const 项们 = output as 项[];
  /*
    真的搜到过的网址：web_search_call.action.sources（请求里带 include 才有）。
    10-16 对比实验试跑踩到：照提示词写「标题 | 网址 | 一句话」时，GPT 把网址自己写进正文、一个引用标记都不给，
    原来只认引用标记，于是 0 条。现在正文里的行也认，但**网址必须在这张表里**——防它编网址
  */
  const 真网址 = new Map<string, string>();
  for (const it of 项们) if (it.type === "web_search_call") for (const x of it.action?.sources ?? []) if (x?.url && /^https?:\/\//i.test(x.url)) 真网址.set(网址键(去追踪参数(x.url)), 去追踪参数(x.url));

  for (const item of 项们) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c.type !== "output_text") continue;
      const text = c.text ?? "";
      // 1. 引用标记（url_citation）：最可信
      for (const a of c.annotations ?? []) {
        if (a.type !== "url_citation" || !a.url || !/^https?:\/\//i.test(a.url)) continue;
        const url = 去追踪参数(a.url);
        /*
          start_index / end_index 圈的是引用标记本身（往往就是那个 markdown 链接），不是被引用的那句话。
          摘要取引用标记所在的那一行、去掉链接——那一行就是模型照提示词写的「标题 | 网址 | 一句话」
        */
        const s = Math.max(0, Math.min(text.length, a.start_index ?? 0));
        const 行首 = text.lastIndexOf("\n", s - 1) + 1;
        const 行尾 = text.indexOf("\n", s);
        const 行 = text.slice(行首, 行尾 === -1 ? undefined : 行尾);
        const 段 = 行.split("|").map((x) => x.trim());
        收({ title: (a.title ?? "").trim() || url, url, snippet: 清摘要(段.length >= 3 ? 段.slice(2).join(" ") : 行) });
      }
      // 2. 正文里的「标题 | 网址 | 一句话」行：网址得是真搜到过的
      for (const 行 of text.split("\n")) {
        const 段 = 行.split("|").map((x) => x.trim());
        const i = 段.findIndex((x) => /^https?:\/\/\S+$/i.test(x));
        if (i < 0) continue;
        const url = 去追踪参数(段[i]);
        if (!真网址.has(网址键(url))) continue;
        收({ title: 段.slice(0, i).join(" ").replace(/^[-*\d.\s]+/, "").trim() || url, url, snippet: 清摘要(段.slice(i + 1).join(" ")) });
      }
    }
  }
  // 3. 一条都没认出来：至少把真搜到的网址交回去（没有摘要，模型可以接着读）
  if (!出.length) for (const url of 真网址.values()) 收({ title: url, url, snippet: "" });
  return 出;
}

export function gpt搜索(cfg: 网关配置, model: string = 默认搜索模型.gpt): 搜索服务 {
  return {
    名: "gpt",
    async search(query, opts) {
      const data = await 发请求(
        `${cfg.baseUrl}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          // include：要回真搜到过的网址（解析时拿它核正文里的网址，见 解析GPT回应）
          body: JSON.stringify({ model, tools: [{ type: "web_search" }], include: ["web_search_call.action.sources"], input: 提示词(query) }),
        },
        "GPT",
        cfg.apiKey,
        opts.signal,
      );
      const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
      const usage =
        u && typeof u.input_tokens === "number"
          ? { model: String((data as { model?: unknown }).model ?? model), input: u.input_tokens, output: typeof u.output_tokens === "number" ? u.output_tokens : 0 }
          : undefined;
      return { results: 解析GPT回应(data), usage };
    },
  };
}

/* ---------------- 模拟：开发和测试用，不花钱 ---------------- */

/**
 * 按查询词算出来的固定结果：同一句查询永远回同样几条，测试能断言、截图不会每次变。
 * 域名一律 .example（RFC 2606 保留，永远不会真解析到谁家）
 */
export function 模拟搜索(): 搜索服务 {
  return {
    名: "mock",
    async search(query) {
      const h = createHash("sha256").update(query).digest("hex");
      const 名 = `co-${h.slice(0, 6)}`;
      const 条数 = 3 + (parseInt(h.slice(6, 8), 16) % 3);
      const 页 = ["", "about", "news", "products", "contact"];
      return {
        results: Array.from({ length: 条数 }, (_, i) => ({
          title: `${query} · ${["官网", "公司介绍", "最新动态", "产品目录", "联系方式"][i]}`,
          url: `https://${名}.example/${页[i]}`,
          snippet: `（模拟结果）关于「${query}」的第 ${i + 1} 条：${名} 的公开信息摘要。`,
          ...(i === 2 ? { published: "2026-10-01" } : {}),
        })),
      };
    },
  };
}

/**
 * 按环境变量挑搜索服务：
 *   RESEARCH_SEARCH        gpt（默认）| claude | mock
 *   RESEARCH_SEARCH_MODEL  换掉主用的那家的模型（默认 claude-sonnet-5.5 / gpt-5.5）
 *
 * 默认走 GPT（10-16 总控定），它挂了（上游报错、超时、连不上）就换 Claude 再试一次：两家同一个中转站、同一把 Key，
 * 一家临时不通时另一家多半还在。只换一次、只往一个方向换——备用的也挂了就是真挂了，不来回试着烧钱。
 * 调用方自己放弃的（桌面端断开）不换，直接抛。
 */
export function 选搜索服务(cfg: 网关配置, env: Record<string, string | undefined> = process.env): 搜索服务 {
  const 哪家 = (env.RESEARCH_SEARCH ?? "").trim().toLowerCase();
  const 模型 = env.RESEARCH_SEARCH_MODEL?.trim() || undefined;
  if (哪家 === "mock") return 模拟搜索();
  /*
    10-16 总控定：默认 GPT（试跑一次约 2.6 元、来源核得上 94%），Claude 只做备用（GPT 挂了才用，约 6 元）。
    RESEARCH_SEARCH=claude 反过来：Claude 主、GPT 备
  */
  const claude为主 = 哪家 === "claude";
  const 主 = claude为主 ? claude搜索(cfg, 模型) : gpt搜索(cfg, 模型);
  const 备 = claude为主 ? gpt搜索(cfg) : claude搜索(cfg);
  return {
    名: 主.名,
    async search(query, opts) {
      try {
        return await 主.search(query, opts);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        console.warn(`[research] ${主.名} 搜索失败，换 ${备.名} 再试一次：${e instanceof Error ? e.message : String(e)}`);
        return 备.search(query, opts);
      }
    },
  };
}
