/**
 * 背调对比实验（2026-10-14 起草；10-16 改成跑正式流程、按 b.ai 实价算、按「和全 5.5 比」定过线）。
 *
 * ## 跑的是什么
 *
 * **就是产品里那套 6 步编排**（lib/research/run.ts 的 跑背调），不是另写一份简化版：量出来的成本和耗时就是上线以后的。
 * 只有两头换成直连：搜索 / 读页直接调 lib/research/providers.ts（中转站自带的 GPT 搜索）和 read-page.ts；
 * 模型直接打中转站的 /chat/completions，自己记 token（含命中缓存的那部分）。
 *
 * ## 比哪几组（10-16 总控定，用户原话「我们只用判断 gpt」「保证最后回复的质量」）
 *
 *   A 全 5.5（标准）：搜索、每步摘要、最后打分写报告都用 gpt-5.5
 *   B mini 搜 + mini 摘 + 5.5 写报告（主候选），叠加降本开关：搜索结果量 low、最多搜 5 次
 *   C 5.5 搜 + mini 摘 + 5.5 写报告，叠加同样的降本开关
 *   参考：全 mini（只跑前 5 家，不作为候选）
 *   提示缓存每组都开着（编排本身就是按缓存友好的顺序拼提示词，run.ts 的 前缀）。
 *
 * ## 过线（和 A 比，任何一条不过整组淘汰；门槛在配置的「过线」里）
 *
 *   认对公司 100%；结论带来源的比例不低于 A 5 个百分点以上（逐家和 A 比、再取平均——10-16 晚总控定：A 自己试跑才 74%，
 *   绝对线连标准组都过不了）；来源里核得上 ≥ 90%（这条是绝对线，防编造）；和 A 的总分平均差 ≤ 5、6 项档位平均至少 5 项一致；
 *   **编造嫌疑 0 条**：结论里的数字在它标的那一页原文里一个都找不到，就算一条嫌疑（编造嫌疑.md 逐条列出，人再看一眼）。
 *   过线的组合里挑最便宜的做默认；都不过线就用 A。
 *
 * ## 盲评
 *
 *   挑 5 家，把 A 和「最便宜的过线组合」的报告并排、去掉组合名、随机左右，出一份 PDF（盲评.pdf）给用户看；
 *   哪边是哪组写在 盲评-答案.txt。用户觉得明显差就不用。
 *
 * ## 用法
 *
 *   npx tsx scripts/research-bench.ts --配置 scripts/research-bench.example.json --公司 scripts/research-bench.companies.csv --模拟
 *     不联网、不花钱：模拟搜索 + 本机假模型（e2e/research-fake-llm.ts），验流程和输出格式
 *   BENCH_BASE_URL=https://api.b.ai/v1 BENCH_KEY=… npx tsx scripts/research-bench.ts --配置 … --公司 …
 *     真跑：花的是中转站额度。Key 只放环境变量（~/Opensource_CRM/02-开发与发版/背调-脚本/对比实验.sh 从服务器取，不打印）
 *   … --只跑 1     先跑第 1 家看看
 *
 * 同一家公司的几组并排同时跑（中转站扛得住，总时长缩到原来的几分之一）。
 * 输出到 --输出 指定的目录：results.csv、summary.md、编造嫌疑.md、盲评.html / 盲评.pdf / 盲评-答案.txt、每份报告的 txt。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 跑背调, type 模型调用 } from "../src/lib/research/run";
import { claude搜索, gpt搜索, 卡了重搜一次, type 搜索服务 } from "../src/lib/research/providers";
import { 读网页 } from "../src/lib/research/read-page";
import { 模拟通道 } from "../src/lib/research/mock";
import { 报告文本 } from "../src/lib/research/report";
import type { 背调通道 } from "../src/lib/research/channel";
import type { 背调状态 } from "../src/lib/research/state";
import { 读价目, 模型花费元, 搜索花费元, type 价目 } from "../src/lib/research/price";
import { 背调超时, 重发一次, 截 } from "../src/lib/research/retry";
import { 阶段表 } from "../src/lib/research/types";

/* ---------- 配置 ---------- */

type 组合 = {
  名: string;
  /** 搜索那一路的模型（gpt-* 走 GPT 搜索，claude-* 走 Claude 搜索） */
  搜索: string;
  /** 每一步挑工具、写摘要 */
  摘要: string;
  /** 最后打分 + 写报告 */
  报告: string;
  /** GPT 搜索的 search_context_size */
  搜索结果量?: "low" | "medium" | "high";
  /** 一次最多搜几次（产品默认 8） */
  搜索上限?: number;
  /** 标准组（A）：其余各组都和它比 */
  标准?: boolean;
  /** 只作参考，不参与挑默认 */
  参考?: boolean;
  /** 只跑名单前几家 */
  只跑前?: number;
};
/** 有来源差：结论带来源的比例最多比 A 低多少（0.05 = 5 个百分点），逐家比再取平均；A 自己不比 */
type 过线 = { 认对: number; 有来源差: number; 核得上: number; 分差: number; 档一致: number; 编造: number };
type 配置 = {
  /** 「我们卖什么、卖给谁、哪些国家」——等于设置里的业务简介，评分照它评 */
  我方: string;
  /** 每组跑名单前几家（组里另写 只跑前 的以组为准） */
  公司数: number;
  /** 实验里的单次成本上限（元）。产品默认 4 元，实验放宽到 10，别让 5.5 那组被截断 */
  成本上限元: number;
  组合: 组合[];
  过线: 过线;
  /** 和服务器的 RESEARCH_PRICES 同一个格式；不写就用 price.ts 里的 b.ai 实价 */
  价目?: Record<string, unknown>;
};

type 公司 = { 名: string; 官网: string[]; 国家: string; 类型: string; 规模: string; 备注: string };

const 参数 = (() => {
  const a = process.argv.slice(2);
  const 取 = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { 配置: 取("--配置"), 公司: 取("--公司"), 模拟: a.includes("--模拟"), 只跑: Number(取("--只跑") ?? 0) || 0, 输出: 取("--输出") ?? "research-bench-out" };
})();

function 读公司(p: string): 公司[] {
  const 行 = readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const [头, ...身] = 行;
  const 列 = 头.split(",").map((x) => x.trim());
  const 取 = (c: string[], n: string) => (列.indexOf(n) >= 0 ? (c[列.indexOf(n)] ?? "").trim() : "");
  return 身
    .map((l) => {
      const c = l.split(",");
      return { 名: 取(c, "公司"), 官网: 取(c, "官网").split("|").map((x) => x.trim().toLowerCase()).filter(Boolean), 国家: 取(c, "国家"), 类型: 取(c, "类型"), 规模: 取(c, "规模"), 备注: 取(c, "备注") };
    })
    .filter((x) => x.名);
}

/* ---------- 直连模型：打 OpenAI 兼容的 /chat/completions，自己记 token（含缓存命中） ---------- */

type 账 = { 输入: number; 缓存: number; 输出: number; 调用: number; 花费元: number };
const 新账 = (): 账 => ({ 输入: 0, 缓存: 0, 输出: 0, 调用: 0, 花费元: 0 });

function 直连模型(base: string, key: string, 默认模型: string, 账: 账, 价: 价目): 模型调用 {
  /** 和产品（gateway-model.ts）同一套：每一趟等 opts.timeoutMs（编排给的 背调超时.模型每次），卡住 / 5xx 重发一次 */
  const 发 = async (body: Record<string, unknown>, model: string, opts: { signal?: AbortSignal; timeoutMs?: number }) => {
    const t = await 重发一次(
      async (signal) => {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, temperature: 0, max_tokens: 2000, ...body }),
          signal,
        });
        const t = await r.text();
        if (!r.ok) throw Object.assign(new Error(`接口返回 ${r.status}：${t.slice(0, 200)}`), { status: r.status });
        return t;
      },
      opts.timeoutMs ?? 背调超时.模型每次,
      opts.signal,
    );
    const j = JSON.parse(t) as {
      choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const 入 = j.usage?.prompt_tokens ?? 0, 出 = j.usage?.completion_tokens ?? 0, 缓存 = j.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    账.调用 += 1;
    账.输入 += 入;
    账.输出 += 出;
    账.缓存 += 缓存;
    账.花费元 += 模型花费元(价, model, 入, 出, 缓存);
    return j.choices?.[0]?.message ?? {};
  };
  return {
    async tools(messages, tools, opts) {
      const m = await 发({ messages, tools }, opts.model ?? 默认模型, opts);
      return { toolCalls: (m.tool_calls ?? []) as never, text: (m.content ?? "").trim() };
    },
    async json(messages, opts) {
      const model = opts.model ?? 默认模型;
      let m;
      try {
        m = await 发({ messages, response_format: { type: "json_object" } }, model, opts);
      } catch (e) {
        if ((e as { status?: number }).status === 400) m = await 发({ messages }, model, opts);
        else throw e;
      }
      const s = (m.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return JSON.parse(s || "{}");
    },
  };
}

/* ---------- 直连通道：搜索走中转站自带的搜索，读页走我们那份带内网防护的读法 ---------- */

function 直连通道(g: 组合, 服务: 搜索服务, 账: 账, 价: 价目, 已花: () => number, 上限元: number): 背调通道 {
  const 通道: 背调通道 = {
    名: "云端",
    扣次: 0,
    模型: g.报告,
    摘要模型: g.摘要,
    async 价目() {
      return { 扣次: 0, 还剩: null };
    },
    async 开始() {
      return { ok: true, 扣了: 0, 还剩: 0, 模型: g.报告, 摘要模型: g.摘要, 搜索上限: g.搜索上限 };
    },
    async 搜索(_runId, query, signal) {
      // 和产品的搜索接口同一套：卡住重搜一次（实验每组只测一家，不换备用）
      const r = await 卡了重搜一次(服务, undefined, query, { signal: signal ?? AbortSignal.timeout(背调超时.搜索接口) });
      账.调用 += 1;
      if (r.usage) {
        账.输入 += r.usage.input;
        账.输出 += r.usage.output;
        账.缓存 += r.usage.cached ?? 0;
      }
      账.花费元 += 搜索花费元(价, r.usage?.model ?? g.搜索, r.usage?.input ?? 0, r.usage?.output ?? 0, r.usage?.cached ?? 0);
      // 和服务器一样：每次搜索后报一次「到现在花了多少」，编排到了上限就停手（run.ts）
      通道.花费 = { 已花元: 已花(), 上限元 };
      return r.results;
    },
    async 读页(_runId, url, signal) {
      // 开着「假 IP」代理的电脑上，外网域名都解析到 198.18.x，要显式放行（服务器上从不放行）
      const p = await 读网页(url, { signal, 放行代理假IP: process.env.BENCH_ALLOW_FAKE_IP === "1" });
      通道.花费 = { 已花元: 已花(), 上限元 };
      return p;
    },
    async 收尾() {
      return null;
    },
  };
  return 通道;
}

/* ---------- 自动核 ---------- */

/** 域名对不对得上：去掉 www，后缀相同就算（ledvance.de 对 ledvance.com 要在名单里另列） */
export function 认对了(状态: 背调状态 | null, 官网: string[]): "对" | "错" | "没找到" {
  const v = 状态?.fields.site?.value?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!v) return "没找到";
  return 官网.some((h) => v === h || v.endsWith(`.${h}`)) ? "对" : "错";
}

/** 从一句结论里摘能拿去原文里找的东西：两位以上的数字、四个字母以上的英文词（去掉太常见的） */
const 常见词 = new Set(["with", "from", "that", "this", "their", "have", "company", "group", "lighting", "light", "the", "and"]);
export function 可核的词(s: string): string[] {
  const 数 = s.match(/\d{2,}/g) ?? [];
  const 词 = (s.match(/[A-Za-z][A-Za-z.&-]{3,}/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !常见词.has(w));
  return [...new Set([...数, ...词])];
}

export type 核对 = { 结论数: number; 有来源: number; 核得上: number; 核不上: number; 核不了: number; 嫌疑: { 话: string; 源: string }[] };

/**
 * 每条带来源的结论：核得上 / 核不上 / 核不了（摘不出词）。
 * **编造嫌疑**：结论里有数字、而这些数字在它标的那一页原文里一个都找不到——数字是最容易编、也最好核的
 */
export function 核来源(状态: 背调状态, 材料: { url: string; text: string }[]): 核对 {
  const 原文 = new Map<string, string>();
  for (const m of 材料) 原文.set(m.url, `${原文.get(m.url) ?? ""}\n${m.text}`.toLowerCase());
  const 条: { 话: string; 源?: string }[] = [
    ...Object.values(状态.fields).map((f) => ({ 话: f!.value, 源: f!.source })),
    ...(状态.评分?.明细 ?? []).filter((d) => d.档 !== "unknown" && d.维度 !== "similar").map((d) => ({ 话: d.证据 ?? "", 源: d.来源 })),
    ...状态.tags.map((t) => ({ 话: t.text, 源: t.source })),
  ];
  const 出: 核对 = { 结论数: 条.length, 有来源: 0, 核得上: 0, 核不上: 0, 核不了: 0, 嫌疑: [] };
  for (const x of 条) {
    if (!x.源) continue;
    出.有来源 += 1;
    const 词 = 可核的词(x.话);
    if (!词.length) {
      出.核不了 += 1;
      continue;
    }
    const 文 = 原文.get(x.源) ?? "";
    if (词.some((w) => 文.includes(w))) 出.核得上 += 1;
    else 出.核不上 += 1;
    const 数 = x.话.match(/\d{2,}/g) ?? [];
    if (数.length && !数.some((n) => 文.includes(n))) 出.嫌疑.push({ 话: x.话, 源: x.源 });
  }
  return 出;
}

/** 两份报告比：分数差、6 项档位一样的占几成（两边都查不到的那一项也算一样） */
export function 稳定(a: 背调状态 | null, b: 背调状态 | null): { 分差: number | null; 档一致: number | null } {
  if (!a?.评分 || !b?.评分) return { 分差: null, 档一致: null };
  const 分差 = a.评分.分 != null && b.评分.分 != null ? Math.abs(a.评分.分 - b.评分.分) : null;
  const 档b = new Map(b.评分.明细.map((d) => [d.维度, d.档]));
  const 同 = a.评分.明细.filter((d) => 档b.get(d.维度) === d.档).length;
  return { 分差, 档一致: 同 / a.评分.明细.length };
}

/* ---------- 跑 ---------- */

type 一次 = {
  组: string;
  公司: string;
  国家: string;
  类型: string;
  认对: string;
  认到的官网: string;
  分: number | "";
  步完成: number;
  不完整: boolean;
  结论数: number;
  有来源: number;
  核得上: number;
  核不上: number;
  核不了: number;
  嫌疑: number;
  搜索次数: number;
  读页数: number;
  模型调用: number;
  模型输入: number;
  模型缓存读: number;
  模型输出: number;
  搜索输入: number;
  搜索缓存读: number;
  搜索输出: number;
  秒: number;
  成本元: number;
  错: string;
  /** 哪一步出错停下的、报的什么（没停就空着） */
  停在: string;
};

const 均 = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * 结论带来源的比例和 A 比：同一家 A 和这组都跑成、都有结论的才比，逐家「这组 − A」再取平均（负的 = 比 A 少）。
 * 没有一家能比就是 NaN（过线判断里算不过）
 */
export function 来源比A(行们: Pick<一次, "组" | "公司" | "错" | "结论数" | "有来源">[], A名: string, 组名: string): number {
  const 率 = (r?: Pick<一次, "错" | "结论数" | "有来源">) => (r && !r.错 && r.结论数 ? r.有来源 / r.结论数 : NaN);
  return 均(
    行们
      .filter((r) => r.组 === 组名)
      .map((r) => 率(r) - 率(行们.find((a) => a.组 === A名 && a.公司 === r.公司)))
      .filter(Number.isFinite),
  );
}
const 百 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "—");
const 文件名 = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "_");

/** 「基本面：The operation was aborted due to timeout」这样：一眼看出卡在哪一步、是什么错 */
function 停在哪(状态: 背调状态 | null): string {
  if (!状态) return "";
  const 错的 = 阶段表.find((x) => 状态.stages[x.id].status === "error");
  return 错的 ? `${错的.label}：${截(状态.stages[错的.id].summary ?? "", 80)}` : "";
}

/**
 * 同一家公司最多几组同时跑。10-16 下午 ABC 试跑 4 组一起跑，中转站把其中两组的请求卡到超时；总控定最多 2 组
 */
const 同时跑 = 2;
async function 限并发<T, R>(xs: T[], n: number, 做: (x: T) => Promise<R>): Promise<R[]> {
  const 出: R[] = new Array(xs.length);
  let 下一个 = 0;
  const 工人 = async () => {
    while (下一个 < xs.length) {
      const i = 下一个++;
      出[i] = await 做(xs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, 工人));
  return 出;
}

async function 跑一次(c: 配置, g: 组合, co: 公司, base: string, key: string, 价: 价目): Promise<{ 行: 一次; 状态: 背调状态 | null; 嫌疑: 核对["嫌疑"] }> {
  const 模型账 = 新账();
  const 搜索账 = 新账();
  const 已花 = () => 模型账.花费元 + 搜索账.花费元;
  const cfg = { baseUrl: base, apiKey: key, models: [] };
  const 服务 = /^claude/i.test(g.搜索) ? claude搜索(cfg, g.搜索) : gpt搜索(cfg, g.搜索, g.搜索结果量);
  const 通道 = 参数.模拟 ? 模拟通道() : 直连通道(g, 服务, 搜索账, 价, 已花, c.成本上限元);
  const t0 = Date.now();
  let 状态: 背调状态 | null = null;
  let 材料: { url: string; text: string }[] = [];
  let 错 = "";
  try {
    const r = await 跑背调({
      公司: co.名,
      b: { brief: c.我方, fields: { school: "公司", grade: "职位", major: "行业" } },
      通道,
      模型: 直连模型(base, key, 参数.模拟 ? "e2e-model" : g.报告, 模型账, 价),
      老客户: [],
      发: () => {},
    });
    if (r.ok) {
      状态 = r.状态;
      材料 = r.材料;
    } else 错 = r.error;
  } catch (e) {
    错 = e instanceof Error ? e.message : String(e);
  }
  const 核 = 状态 ? 核来源(状态, 材料) : { 结论数: 0, 有来源: 0, 核得上: 0, 核不上: 0, 核不了: 0, 嫌疑: [] };
  const 秒 = (Date.now() - t0) / 1000;
  const 行: 一次 = {
    组: g.名,
    公司: co.名,
    国家: co.国家,
    类型: co.类型,
    认对: 参数.模拟 ? "模拟" : 认对了(状态, co.官网),
    认到的官网: 状态?.fields.site?.value ?? "",
    分: 状态?.评分?.分 ?? "",
    步完成: 状态 ? Object.values(状态.stages).filter((x) => x.status === "done").length : 0,
    不完整: 状态?.done?.不完整 ?? true,
    结论数: 核.结论数,
    有来源: 核.有来源,
    核得上: 核.核得上,
    核不上: 核.核不上,
    核不了: 核.核不了,
    嫌疑: 核.嫌疑.length,
    搜索次数: 状态?.usage.searches ?? 搜索账.调用,
    读页数: 状态?.usage.pages ?? 0,
    模型调用: 模型账.调用,
    模型输入: 模型账.输入,
    模型缓存读: 模型账.缓存,
    模型输出: 模型账.输出,
    搜索输入: 搜索账.输入,
    搜索缓存读: 搜索账.缓存,
    搜索输出: 搜索账.输出,
    秒: Math.round(秒 * 10) / 10,
    // 模拟数据不花钱（假模型名按兜底价估出来的数没有意义）
    成本元: 参数.模拟 ? 0 : Math.round(已花() * 1000) / 1000,
    错,
    停在: 停在哪(状态),
  };
  if (状态) writeFileSync(path.join(参数.输出, `${文件名(co.名)}__${文件名(g.名)}.txt`), 报告文本(状态));
  return { 行, 状态, 嫌疑: 核.嫌疑 };
}

/** 盲评：A 和挑中的那组并排，去掉组合名、随机左右，出 HTML 再打成 PDF */
async function 出盲评(对: { 公司: string; A: 背调状态; 候选: 背调状态 }[], 候选组: string) {
  const 答案: string[] = [];
  const 转义 = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const 块 = 对.map(({ 公司, A, 候选 }, i) => {
    const A在左 = Math.random() < 0.5;
    答案.push(`${i + 1}. ${公司}：甲 = ${A在左 ? "A 全 5.5" : 候选组}，乙 = ${A在左 ? 候选组 : "A 全 5.5"}`);
    const [左, 右] = A在左 ? [A, 候选] : [候选, A];
    return `<section><h2>${i + 1}. ${转义(公司)}</h2><div class="两栏"><div><h3>报告 甲</h3><pre>${转义(报告文本(左))}</pre></div><div><h3>报告 乙</h3><pre>${转义(报告文本(右))}</pre></div></div></section>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>背调报告盲评</title><style>
    body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#222}
    h1{font-size:20px} h2{font-size:16px;margin:24px 0 8px;page-break-before:always} section:first-of-type h2{page-break-before:auto}
    .两栏{display:grid;grid-template-columns:1fr 1fr;gap:16px} h3{font-size:13px;margin:0 0 6px;color:#555}
    pre{white-space:pre-wrap;font-family:inherit;font-size:11px;line-height:1.6;margin:0;padding:10px;border:1px solid #ddd;border-radius:6px}
  </style><h1>背调报告盲评（${对.length} 家）</h1><p>每家两份报告，来自两种不同的配置，左右随机。请看哪份更准、更有用；觉得其中一边明显差就记下来。</p>${块.join("")}`;
  writeFileSync(path.join(参数.输出, "盲评.html"), html);
  writeFileSync(path.join(参数.输出, "盲评-答案.txt"), 答案.join("\n") + "\n");
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    const p = await b.newPage();
    await p.setContent(html);
    await p.pdf({ path: path.join(参数.输出, "盲评.pdf"), format: "A4", landscape: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
    await b.close();
  } catch (e) {
    console.warn("盲评 PDF 没打出来（HTML 在同目录，可以用浏览器打印）：", e instanceof Error ? e.message : e);
  }
}

async function main() {
  if (!参数.配置 || !参数.公司) throw new Error("要 --配置 和 --公司，见文件头的用法");
  const c = JSON.parse(readFileSync(参数.配置, "utf8")) as 配置;
  const 价: 价目 = 读价目({ RESEARCH_PRICES: c.价目 ? JSON.stringify(c.价目) : process.env.RESEARCH_PRICES });
  let 公司们 = 读公司(参数.公司).slice(0, c.公司数 || undefined);
  if (参数.只跑) 公司们 = 公司们.slice(0, 参数.只跑);
  mkdirSync(参数.输出, { recursive: true });

  let base = process.env.BENCH_BASE_URL?.replace(/\/+$/, "") ?? "";
  let key = process.env.BENCH_KEY ?? "";
  let 收拾: (() => Promise<void>) | undefined;
  if (参数.模拟) {
    const { 起假模型 } = await import("../e2e/research-fake-llm");
    const s = await 起假模型(0);
    base = s.url;
    key = "bench-mock";
    收拾 = s.close;
  }
  if (!base || !key) throw new Error("真跑要 BENCH_BASE_URL 和 BENCH_KEY 两个环境变量（中转站地址和 Key）");

  const 行们: 一次[] = [];
  const 状态表 = new Map<string, 背调状态 | null>();
  const 嫌疑表: { 组: string; 公司: string; 话: string; 源: string }[] = [];
  for (const [第几家, co] of 公司们.entries()) {
    const 这家的组 = c.组合.filter((g) => !g.只跑前 || 第几家 < g.只跑前);
    console.log(`\n${co.名}（${这家的组.length} 组，最多 ${同时跑} 组同时跑）`);
    const 结果们 = await 限并发(这家的组, 同时跑, (g) => 跑一次(c, g, co, base, key, 价));
    for (const [i, r] of 结果们.entries()) {
      行们.push(r.行);
      状态表.set(`${这家的组[i].名}|${co.名}`, r.状态);
      for (const x of r.嫌疑) 嫌疑表.push({ 组: 这家的组[i].名, 公司: co.名, ...x });
      console.log(`  ${r.行.组}：${r.行.错 ? `出错 ${r.行.错.slice(0, 60)}` : `${r.行.分 === "" ? "—" : r.行.分} 分，${r.行.秒}s，${r.行.成本元.toFixed(2)} 元，认对 ${r.行.认对}，嫌疑 ${r.行.嫌疑}`}`);
    }
  }
  await 收拾?.();

  const 列 = Object.keys(行们[0] ?? {}) as (keyof 一次)[];
  const 格 = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(path.join(参数.输出, "results.csv"), "﻿" + [列.join(","), ...行们.map((r) => 列.map((k) => 格(r[k])).join(","))].join("\n"));
  writeFileSync(
    path.join(参数.输出, "编造嫌疑.md"),
    ["# 编造嫌疑（结论里的数字在它标的那一页原文里一个都找不到）", "", ...(嫌疑表.length ? 嫌疑表.map((x) => `- **${x.组}** · ${x.公司}：${x.话}\n  来源 ${x.源}`) : ["（没有）"])].join("\n"),
  );

  // 汇总：每组一行，和 A 比
  const A = c.组合.find((g) => g.标准) ?? c.组合[0];
  const 汇总 = c.组合.map((g) => {
    const rs = 行们.filter((r) => r.组 === g.名);
    const 成 = rs.filter((r) => !r.错);
    const 认 = 成.filter((r) => r.认对 !== "模拟");
    const 认对率 = 认.length ? 认.filter((r) => r.认对 === "对").length / 认.length : NaN;
    const 有来源率 = 均(成.map((r) => (r.结论数 ? r.有来源 / r.结论数 : NaN)).filter(Number.isFinite));
    const 有来源比A = g === A ? NaN : 来源比A(行们, A.名, g.名);
    const 核得上率 = 均(成.map((r) => (r.核得上 + r.核不上 ? r.核得上 / (r.核得上 + r.核不上) : NaN)).filter(Number.isFinite));
    const 比A = g === A ? [] : rs.map((r) => 稳定(状态表.get(`${A.名}|${r.公司}`) ?? null, 状态表.get(`${g.名}|${r.公司}`) ?? null)).filter((x) => x.分差 != null);
    const 分差 = 均(比A.map((x) => x.分差!));
    const 档一致 = 均(比A.map((x) => x.档一致!));
    const 嫌疑 = 成.reduce((a, r) => a + r.嫌疑, 0);
    const 成本 = 均(成.map((r) => r.成本元));
    const 入 = 成.reduce((a, r) => a + r.模型输入 + r.搜索输入, 0);
    const 缓存占比 = 入 ? 成.reduce((a, r) => a + r.模型缓存读 + r.搜索缓存读, 0) / 入 : NaN;
    const 不过: string[] = [];
    if (!(成.length === rs.length && rs.length)) 不过.push("有跑失败的");
    if (!参数.模拟 && !(认对率 >= c.过线.认对)) 不过.push("认错公司");
    if (g !== A && !(有来源比A >= -c.过线.有来源差)) 不过.push("来源比 A 少");
    if (!(核得上率 >= c.过线.核得上)) 不过.push("核得上不够");
    if (g !== A && !(分差 <= c.过线.分差)) 不过.push("分差大");
    if (g !== A && !(档一致 >= c.过线.档一致 / 6)) 不过.push("档位不一致");
    if (嫌疑 > c.过线.编造) 不过.push("有编造嫌疑");
    return { g, rs, 成, 认对率, 有来源率, 有来源比A, 核得上率, 分差, 档一致, 嫌疑, 成本, 缓存占比, 秒: 均(成.map((r) => r.秒)), 调用: 均(成.map((r) => r.模型调用)), 不过 };
  });
  const 标准 = 汇总.find((x) => x.g === A)!;
  const 候选 = 汇总.filter((x) => !x.g.参考 && x.g !== A && x.不过.length === 0).sort((a, b) => a.成本 - b.成本);
  const 默认 = 候选[0] ?? 标准;
  const 数 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");

  const md = [
    "# 背调对比实验汇总",
    "",
    `公司 ${公司们.length} 家${参数.模拟 ? "（模拟数据，不代表真实效果）" : ""}；成本按 b.ai 实价（含缓存读价），实验上限 ${c.成本上限元} 元；评分依据：${c.我方}`,
    "",
    "| 组合 | 跑成 | 认对公司 | 结论带来源 | 来源里核得上 | 和 A 平均分差 | 和 A 档位一致 | 编造嫌疑 | 平均每次成本（元） | 成本 × 3 建议售价（元） | 缓存读占输入 | 平均分析调用 | 平均耗时 | 过线 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...汇总.map(
      (x) =>
        `| ${x.g.名}${x.g.参考 ? "（参考）" : ""} | ${x.成.length}/${x.rs.length} | ${百(x.认对率)} | ${百(x.有来源率)}${x.g === A || !Number.isFinite(x.有来源比A) ? "" : `（比 A ${x.有来源比A >= 0 ? "+" : "−"}${Math.abs(x.有来源比A * 100).toFixed(0)} 点）`} | ${百(x.核得上率)} | ${x.g === A ? "（标准）" : 数(x.分差, 1)} | ${x.g === A ? "—" : Number.isFinite(x.档一致) ? `${(x.档一致 * 6).toFixed(1)} / 6` : "—"} | ${x.嫌疑} | ${数(x.成本)} | ${数(x.成本 * 3, 1)} | ${百(x.缓存占比)} | ${数(x.调用, 0)} | ${数(x.秒, 0)}s | ${x.g.参考 ? "—" : x.不过.length ? `✗ ${x.不过.join("、")}` : "✓"} |`,
    ),
    "",
    `**建议默认：${默认.g.名}**（${默认 === 标准 ? "没有组合过线，用 A + 降本开关" : "过线组合里最便宜的"}），平均每次 ${数(默认.成本)} 元，按成本 × 3 约 ${数(默认.成本 * 3, 1)} 元一次。`,
    "",
    `过线门槛：认对 ${百(c.过线.认对)}、结论带来源不比 A 低 ${Math.round(c.过线.有来源差 * 100)} 个百分点以上（逐家比再平均）、核得上 ≥ ${百(c.过线.核得上)}、和 A 平均分差 ≤ ${c.过线.分差}、档位平均至少 ${c.过线.档一致} / 6 一致、编造嫌疑 ≤ ${c.过线.编造}。`,
    "编造嫌疑逐条在 编造嫌疑.md；每份报告的原文在同目录的 txt；「核得上」只算摘得出数字 / 英文词的结论。",
  ];
  writeFileSync(path.join(参数.输出, "summary.md"), md.join("\n"));

  // 盲评：A 和建议默认（不是 A 时）并排，最多 5 家
  if (默认 !== 标准) {
    const 对 = 公司们
      .map((co) => ({ 公司: co.名, A: 状态表.get(`${A.名}|${co.名}`), 候选: 状态表.get(`${默认.g.名}|${co.名}`) }))
      .filter((x): x is { 公司: string; A: 背调状态; 候选: 背调状态 } => Boolean(x.A && x.候选))
      .slice(0, 5);
    if (对.length) await 出盲评(对, 默认.g.名);
  }
  console.log(`\n写好了：${参数.输出}/summary.md、results.csv、编造嫌疑.md${默认 !== 标准 ? "、盲评.pdf（答案在 盲评-答案.txt）" : ""}`);
}

// 只在直接运行时跑（单测会 import 上面那几个核对函数）
if (process.argv[1] && /research-bench\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
