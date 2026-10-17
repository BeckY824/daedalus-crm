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
 * ## 10-17 起默认跑「A / C 同材料回放」（research-bench.ac.json；用户嫌全量太贵）
 *
 *   每家只让 A 真跑一遍，录下每一步搜到的、读到的（输出目录/录像/，按家分文件）；C 组配了 "回放": "A 全 5.5"，
 *   不再搜索、不读新页，用 A 录的同一批材料重放「mini 每步摘要 + 5.5 打分写报告」——两组材料一样，只比模型，C 一次不到 1 元。
 *   C 上线以后要自己搜，所以「估真实单次成本」= A 同一家的搜索花费 + C 的模型花费（偏高：A 的搜索是 5.5 中等结果量、最多 8 次）。
 *   回放规则见 回放()：不看查询词，A 搜到过的都给；A 没读过的页现场读（不花钱），次数记在 results.csv 的 回放补读页。
 *   5 家，2 家同时跑（每家里 A 跑完才回放 C）。A 跑过的家加 --重用录像 不再真跑 A，只重放 C（改了 C 的提示词想再比一次时用）。
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
 *   … --重用录像   录像目录里已有的组不再真跑，直接拿上次的结果，只跑回放组
 *   … --重跑 SLV,alfanar   这几家不用录像，A 重新真跑
 *
 * 同一家最多 2 组同时跑；几家同时跑看配置的 同时跑几家（默认 1）。
 * 输出到 --输出 指定的目录：results.csv、summary.md、编造嫌疑.md、盲评.html / 盲评.pdf / 盲评-答案.txt、每份报告的 txt。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 跑背调, type 模型调用 } from "../src/lib/research/run";
import { claude搜索, gpt搜索, 卡了重搜一次, type 搜索服务 } from "../src/lib/research/providers";
import { 读网页 } from "../src/lib/research/read-page";
import { 模拟通道 } from "../src/lib/research/mock";
import { 报告文本 } from "../src/lib/research/report";
import type { 背调通道 } from "../src/lib/research/channel";
import type { 背调状态 } from "../src/lib/research/state";
import { 读价目, 模型花费元, 搜索花费元, type 价目 } from "../src/lib/research/price";
import { 背调超时, 背调输出上限, 取回答, 重发一次, 截 } from "../src/lib/research/retry";
import { 阶段表, type 花费, type 搜索结果, type 读页结果 } from "../src/lib/research/types";

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
  /**
   * 不自己搜：回放这一组（写组名）同一家录下的搜索结果和网页，只比模型（10-17 总控定的「A / C 同材料回放」）。
   * 这组排在被回放的那组后面跑；成本只有模型那部分，估真实单次成本时再加上被回放那组的搜索花费
   */
  回放?: string;
  /**
   * 这组是另一组（写组名）原样再跑一遍：量同配置自己的波动（10-17：同材料同配置两遍每家差 7–9 分）。
   * 不参与挑默认；汇总里给「同配置两遍分差」，和 A 的分差按几遍的平均分算
   */
  同配置?: string;
  /** 开跑前估花费用：这组跑一家大约几元（不写：回放组 1 元，真跑的 7 元——10-17 实测 A 5–7 元、C 0.8 元） */
  预计每次元?: number;
};
/**
 * 10-17 总控定：都和 A 比，A 自己不判。有来源差 / 核得上差：最多比 A 低多少（0.05 = 5 个百分点，有来源逐家比再平均）；
 * 编造嫌疑不比 A 多；分差只在有「同配置」重跑时按几遍的平均分判（单次跑同配置自己就差 7–9 分，判不了）
 */
type 过线 = { 认对: number; 有来源差: number; 核得上差: number; 分差: number; 档一致: number };
type 配置 = {
  /** 「我们卖什么、卖给谁、哪些国家」——等于设置里的业务简介，评分照它评 */
  我方: string;
  /** 每组跑名单前几家（组里另写 只跑前 的以组为准）；写了 公司 就按 公司 */
  公司数?: number;
  /** 只跑这几家（名单里「公司」那一列的名字，照这里的顺序） */
  公司?: string[];
  /** 几家同时跑（默认 1）。同一家里几组同时跑另有 同时跑（最多 2） */
  同时跑几家?: number;
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
  return { 配置: 取("--配置"), 公司: 取("--公司"), 模拟: a.includes("--模拟"), 重用录像: a.includes("--重用录像"),
    /** 不探中转站余额（探不了的中转站用；b.ai 能探） */
    不查余额: a.includes("--不查余额"),
    /** --重跑 SLV,alfanar：这几家不用录像、A 重新真跑（配合 --重用录像：别的家只重放） */
    重跑: (取("--重跑") ?? "").split(",").map((x) => x.trim()).filter(Boolean), 只跑: Number(取("--只跑") ?? 0) || 0, 输出: 取("--输出") ?? "research-bench-out" };
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
  const 发 = async (body: Record<string, unknown>, model: string, 要正文: boolean, opts: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number; reasoningEffort?: string }) => {
    const t = await 重发一次(
      async (signal) => {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, temperature: 0, max_tokens: opts.maxTokens ?? 背调输出上限, ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}), ...body }),
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
      choices?: { message?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const 入 = j.usage?.prompt_tokens ?? 0, 出 = j.usage?.completion_tokens ?? 0, 缓存 = j.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    账.调用 += 1;
    账.输入 += 入;
    账.输出 += 出;
    账.缓存 += 缓存;
    账.花费元 += 模型花费元(价, model, 入, 出, 缓存);
    // 和产品（gateway-model.ts）同一个判断：被截断 / 要 JSON 却是空的就抛，编排重要一次（10-17 SLV「— 分」就是这个）
    try {
      return 取回答(j, 要正文);
    } catch (e) {
      console.warn(`[bench] ${model} 回答被截断（输出 ${出} token，上限 ${opts.maxTokens ?? 背调输出上限}）`);
      throw e;
    }
  };
  return {
    async tools(messages, tools, opts) {
      const m = await 发({ messages, tools }, opts.model ?? 默认模型, false, opts);
      return { toolCalls: (m.tool_calls ?? []) as never, text: (m.content ?? "").trim() };
    },
    async json(messages, opts) {
      const model = opts.model ?? 默认模型;
      let m;
      try {
        m = await 发({ messages, response_format: { type: "json_object" } }, model, true, opts);
      } catch (e) {
        if ((e as { status?: number }).status === 400) m = await 发({ messages }, model, true, opts);
        else throw e;
      }
      const s = (m.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return JSON.parse(s);
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

/* ---------- 录制 / 回放：A 真跑时把每一步搜到的、读到的原样录下来，C 用同一批材料重放，只比模型 ---------- */

export type 录像 = {
  公司: string;
  组: string;
  /** 按发生顺序；步 = 哪一步搜的（回放时同一步按顺序给） */
  搜索: { 步: string; query: string; 结果?: 搜索结果[]; 错?: string }[];
  读页: { url: string; 页?: 读页结果; 错?: string }[];
  /** 这一组这一家跑出来的整份结果（--重用录像 时不再真跑，直接拿来和回放组比） */
  结果?: 一次结果;
};
type 一次结果 = { 行: 一次; 状态: 背调状态 | null; 材料: { url: string; text: string }[]; 嫌疑: 核对["嫌疑"] };

const 错文 = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 同一页：去掉 #、末尾的 /、域名大小写 */
const 页键 = (u: string) => {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "")}${x.search}`;
  } catch {
    return u.trim();
  }
};

/** 包一层：搜索 / 读页照常走 基，结果（连出的错）按发生顺序记进 录 */
export function 录下(基: 背调通道, 录: 录像, 当前步: () => string): 背调通道 {
  const 通道: 背调通道 = {
    ...基,
    async 搜索(runId, query, signal) {
      const 步 = 当前步();
      try {
        const r = await 基.搜索(runId, query, signal);
        录.搜索.push({ 步, query, 结果: r });
        return r;
      } catch (e) {
        if (!signal?.aborted) 录.搜索.push({ 步, query, 错: 错文(e) });
        throw e;
      } finally {
        通道.花费 = 基.花费;
      }
    },
    async 读页(runId, url, signal) {
      try {
        const p = await 基.读页(runId, url, signal);
        录.读页.push({ url, 页: p });
        return p;
      } catch (e) {
        if (!signal?.aborted) 录.读页.push({ url, 错: 错文(e) });
        throw e;
      } finally {
        通道.花费 = 基.花费;
      }
    },
  };
  return 通道;
}

/**
 * 回放 录 里的材料。10-17 第一次跑出「缺搜 1–2、缺页 1–3」：C 的查询词、在哪一步搜和 A 不一样就拿不到材料，C 吃亏、分差偏大。
 * 改成**不看查询词，只要 A 搜到过的都给出去**：
 * - 搜索：同一步里先给一字不差的，再按顺序给这一步没用过的；这一步的用完了，按顺序给别的步没用过的；
 *   A 录的全给完了，再要就把 A 搜到过的全部结果合在一起再给一遍（没有新东西，材料还是那一批）。只有 A 一次都没搜成才算 缺.搜
 * - 读页：A 读过的给录下的那份（读失败的照样失败）；A 没读过的现场去读（读网页不花中转站的钱，产品里 C 自己也会读这一页——
 *   读哪页是模型的判断，算在模型差异里），记一笔 补读。这一步的材料边界是「同一批搜索结果」，不是「同一批页」
 */
export function 回放(录: 录像, 基: 背调通道, 当前步: () => string, 记: { 缺搜: number; 补读: number }, 看钱?: () => 花费): 背调通道 {
  const 用过 = new Set<number>();
  const 成了 = 录.搜索.map((x, i) => ({ x, i })).filter(({ x }) => !x.错);
  const 全部结果 = () => {
    const 见过 = new Set<string>();
    return 成了.flatMap(({ x }) => x.结果 ?? []).filter((r) => !见过.has(页键(r.url)) && Boolean(见过.add(页键(r.url))));
  };
  const 通道: 背调通道 = {
    ...基,
    async 搜索(_runId, query) {
      const 步 = 当前步();
      const 没用过 = 录.搜索.map((x, i) => ({ x, i })).filter(({ i }) => !用过.has(i));
      const 这步 = 没用过.filter(({ x }) => x.步 === 步);
      const 中 = 这步.find(({ x }) => x.query.trim().toLowerCase() === query.trim().toLowerCase()) ?? 这步[0] ?? 没用过[0];
      通道.花费 = 看钱?.();
      if (!中) {
        if (!成了.length) 记.缺搜 += 1;
        return 全部结果();
      }
      用过.add(中.i);
      if (中.x.错) throw new Error(中.x.错);
      return 中.x.结果 ?? [];
    },
    async 读页(runId, url, signal) {
      const 中 = 录.读页.find((x) => 页键(x.url) === 页键(url) || (x.页?.url && 页键(x.页.url) === 页键(url)));
      if (!中) {
        记.补读 += 1;
        try {
          return await 基.读页(runId, url, signal);
        } finally {
          通道.花费 = 看钱?.();
        }
      }
      通道.花费 = 看钱?.();
      if (中.错 || !中.页) throw new Error(中.错 ?? "这一页读不了");
      return 中.页;
    },
  };
  return 通道;
}

/* ---------- 自动核 ---------- */

/** 域名对不对得上：去掉 www，后缀相同就算（ledvance.de 对 ledvance.com 要在名单里另列） */
/* ---------- 开跑前：中转站余额够不够这一次（10-17 AC 全量跑到第 5 家撞上余额不足，跑了一半） ---------- */

/**
 * 从中转站「余额不足」的回包里读出余额（元）。b.ai：`credit insufficient balance: balance=14598812 required=…`，
 * 单位是积分，$1 = 100 万积分（price.ts 同一套）。读不出来回 null
 */
export function 读余额元(回包: string, 汇率: number): number | null {
  const m = /balance=(\d+)/.exec(回包);
  return m ? (Number(m[1]) / 1e6) * 汇率 : null;
}

/**
 * 探余额：b.ai 不开放查余额的接口（只放推理路径），就发一次 max_tokens 一千万的最小调用——
 * 中转站按 max_tokens 预扣，余额不够直接回 400 带上 balance=…，**被拒不花钱**；
 * 真放行了（余额够一千万 token，几百美元）就当足够，这一趟只回一两个字，花费可以忽略。
 * 返回：余额元（够多 = Infinity）；探不出来 null（只提示，不挡）
 */
export async function 探余额元(base: string, key: string, 汇率: number, fetch_ = fetch): Promise<number | null> {
  try {
    const res = await fetch_(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "1" }], max_tokens: 10_000_000 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return Infinity;
    return 读余额元(await res.text(), 汇率);
  } catch {
    return null;
  }
}

/** 这次大约花多少元：真跑的组按 预计每次元（默认 7），能用录像的不算；回放组每家都算（默认 1） */
export function 预计花费元(组们: 组合[], 公司们: string[], 能重用: (公司: string, 组: string) => boolean): number {
  let 元 = 0;
  公司们.forEach((co, i) => {
    for (const g of 组们.filter((g) => !g.只跑前 || i < g.只跑前)) {
      if (!g.回放 && 能重用(co, g.名)) continue;
      元 += g.预计每次元 ?? (g.回放 ? 1 : 7);
    }
  });
  return 元;
}

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
  /** 成本里搜索那部分 / 模型那部分 */
  搜索元: number;
  模型元: number;
  /**
   * 估真实单次成本：回放组 = 被回放那组同一家的 搜索元 + 自己的 模型元（上线以后它要自己搜）；别的组 = 成本元。
   * 被回放的 A 用的是 5.5 中等结果量、最多 8 次搜索，比 C 正式配的（low、最多 5 次）贵一点，所以这是偏高的估计
   */
  估实价元: number;
  /** 回放时 A 一次都没搜成、给不出材料的次数（应该是 0）；A 没读过、现场补读的页数 */
  回放缺搜: number;
  回放补读页: number;
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

function 空行(g: 组合, co: 公司): 一次 {
  return {
    组: g.名, 公司: co.名, 国家: co.国家, 类型: co.类型, 认对: "没找到", 认到的官网: "", 分: "", 步完成: 0, 不完整: true,
    结论数: 0, 有来源: 0, 核得上: 0, 核不上: 0, 核不了: 0, 嫌疑: 0, 搜索次数: 0, 读页数: 0, 模型调用: 0, 模型输入: 0, 模型缓存读: 0, 模型输出: 0,
    搜索输入: 0, 搜索缓存读: 0, 搜索输出: 0, 秒: 0, 成本元: 0, 搜索元: 0, 模型元: 0, 估实价元: 0, 回放缺搜: 0, 回放补读页: 0, 错: "", 停在: "",
  };
}

/** 录：真跑并把材料录进去；源：不自己搜，回放它 */
async function 跑一次(c: 配置, g: 组合, co: 公司, base: string, key: string, 价: 价目, 带: { 录?: 录像; 源?: 录像 } = {}): Promise<一次结果> {
  const 模型账 = 新账();
  const 搜索账 = 新账();
  const 已花 = () => 模型账.花费元 + 搜索账.花费元;
  const cfg = { baseUrl: base, apiKey: key, models: [] };
  const 服务 = /^claude/i.test(g.搜索) ? claude搜索(cfg, g.搜索) : gpt搜索(cfg, g.搜索, g.搜索结果量);
  const 基 = 参数.模拟 ? 模拟通道() : 直连通道(g, 服务, 搜索账, 价, 已花, c.成本上限元);
  // 编排每次调工具前先发一个 tool running 事件（带是哪一步），紧跟着就调通道：拿它认「这次搜索是哪一步的」
  let 当前步 = "";
  const 记 = { 缺搜: 0, 补读: 0 };
  const 通道 = 带.源 ? 回放(带.源, 基, () => 当前步, 记, () => ({ 已花元: 已花(), 上限元: c.成本上限元 })) : 带.录 ? 录下(基, 带.录, () => 当前步) : 基;
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
      发: (e) => {
        if (e.type === "tool" && e.status === "running") 当前步 = e.stage;
      },
    });
    if (r.ok) {
      状态 = r.状态;
      材料 = r.材料;
      // 6 步都「完成」却没分：最后一步没交出东西（10-17 第一次跑的 SLV），不能算跑成
      if (状态.评分?.分 == null) 错 = 停在哪(状态) || "最后一步没出分";
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
    搜索元: 参数.模拟 ? 0 : Math.round(搜索账.花费元 * 1000) / 1000,
    模型元: 参数.模拟 ? 0 : Math.round(模型账.花费元 * 1000) / 1000,
    估实价元: 参数.模拟 ? 0 : Math.round(已花() * 1000) / 1000,
    回放缺搜: 记.缺搜,
    回放补读页: 记.补读,
    错,
    停在: 停在哪(状态),
  };
  if (状态) writeFileSync(path.join(参数.输出, `${文件名(co.名)}__${文件名(g.名)}.txt`), 报告文本(状态));
  return { 行, 状态, 材料, 嫌疑: 核.嫌疑 };
}

/** 盲评：A 和挑中的那组并排，去掉组合名、随机左右，出 HTML 再打成 PDF */
/**
 * 盲评每家 A 在不在左边：左右各占一半（单数多出的那家随机），再打乱。
 * 10-17：原来每家各抛一次硬币，5 家正好全是 A 在左——看两家就猜得出规律，盲评就白做了
 */
export function 左右各半(n: number, 随机 = Math.random): boolean[] {
  const 出 = Array.from({ length: n }, (_, i) => (i * 2 + 1 === n ? 随机() < 0.5 : i < n / 2));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(随机() * (i + 1));
    [出[i], 出[j]] = [出[j], 出[i]];
  }
  return 出;
}

async function 出盲评(对: { 公司: string; A: 背调状态; 候选: 背调状态 }[], 候选组: string) {
  const 答案: string[] = [];
  const 转义 = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const 左右 = 左右各半(对.length);
  const 块 = 对.map(({ 公司, A, 候选 }, i) => {
    const A在左 = 左右[i];
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
  const 名单 = 读公司(参数.公司);
  let 公司们 = c.公司?.length
    ? c.公司.map((n) => {
        const co = 名单.find((x) => x.名 === n);
        if (!co) throw new Error(`配置里的公司「${n}」在名单里找不到`);
        return co;
      })
    : 名单.slice(0, c.公司数 || undefined);
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

  const 录像文件 = (公司: string, 组: string) => path.join(参数.输出, "录像", `${文件名(公司)}__${文件名(组)}.json`);
  const 有录像结果 = (公司: string, 组: string) => {
    if (!参数.重用录像 || 参数.重跑.includes(公司) || !existsSync(录像文件(公司, 组))) return false;
    try {
      return Boolean((JSON.parse(readFileSync(录像文件(公司, 组), "utf8")) as 录像).结果);
    } catch {
      return false;
    }
  };
  if (!参数.模拟) {
    const 预计 = 预计花费元(c.组合, 公司们.map((x) => x.名), 有录像结果);
    // 最后一笔调用中转站按 max_tokens 预扣（背调输出上限 8000 × 5.5 输出价 ≈ 1.7 元，加上输入），留 3 元余量
    const 要 = 预计 + 3;
    if (参数.不查余额) {
      console.log(`预计这次花约 ${预计.toFixed(0)} 元（没查中转站余额）`);
    } else {
      const 余额 = await 探余额元(base, key, 价.汇率);
      if (余额 === null) console.warn(`预计这次花约 ${预计.toFixed(0)} 元；中转站余额探不出来，照跑——余额不够会跑到一半停`);
      else if (余额 < 要) throw new Error(`中转站余额约 ${余额.toFixed(1)} 元，这次预计要 ${预计.toFixed(0)} 元（再留 3 元余量），不够，先充值再跑。没开跑，一分没花`);
      else console.log(`中转站余额约 ${Number.isFinite(余额) ? 余额.toFixed(1) : "很多"} 元，这次预计 ${预计.toFixed(0)} 元，够`);
    }
  }

  const 行们: 一次[] = [];
  const 状态表 = new Map<string, 背调状态 | null>();
  const 嫌疑表: { 组: string; 公司: string; 话: string; 源: string }[] = [];
  const 录像目录 = path.join(参数.输出, "录像");
  mkdirSync(录像目录, { recursive: true });
  const 同时几家 = Math.max(1, c.同时跑几家 ?? 1);
  console.log(`${公司们.length} 家，${同时几家} 家同时跑；组：${c.组合.map((g) => g.名 + (g.回放 ? `（回放 ${g.回放} 的材料）` : "")).join(" / ")}`);

  /** 一家：先真跑不回放的组（录下材料），再跑回放组 */
  const 跑一家 = async (co: 公司, 第几家: number) => {
    const 这家的组 = c.组合.filter((g) => !g.只跑前 || 第几家 < g.只跑前);
    const 录们 = new Map<string, 录像>();
    const 出 = new Map<string, 一次结果>();
    await 限并发(
      这家的组.filter((g) => !g.回放),
      同时跑,
      async (g) => {
        const 文件 = path.join(录像目录, `${文件名(co.名)}__${文件名(g.名)}.json`);
        if (参数.重用录像 && !参数.重跑.includes(co.名) && existsSync(文件)) {
          const 旧 = JSON.parse(readFileSync(文件, "utf8")) as 录像;
          // 有录像就重用（材料还在）；A 那次没出分 / 没跑完要重跑的，用 --重跑 点名——别在「只重放」里悄悄多花一次 A 的钱
          if (旧.结果) {
            // 10-17 之前录的：没分也没记错，补上，免得汇总里算「跑成」
            if (旧.结果.行.分 === "" && !旧.结果.行.错) 旧.结果.行.错 = "最后一步没出分";
            // 旧录像的行少了后来加的列（回放补读页 等）：补齐成这一版的格式，汇总相加不出 NaN
            旧.结果.行 = { ...空行(g, co), ...旧.结果.行 };
            录们.set(g.名, 旧);
            出.set(g.名, 旧.结果);
            console.log(`  ${co.名} · ${g.名}：用上次的录像，不重跑${旧.结果.行.错 ? `（上次${旧.结果.行.错.slice(0, 40)}，要重跑加 --重跑 ${co.名}）` : ""}`);
            return;
          }
        }
        const 录: 录像 = { 公司: co.名, 组: g.名, 搜索: [], 读页: [] };
        const r = await 跑一次(c, g, co, base, key, 价, { 录 });
        录.结果 = r;
        writeFileSync(文件, JSON.stringify(录));
        录们.set(g.名, 录);
        出.set(g.名, r);
      },
    );
    for (const g of 这家的组.filter((g) => g.回放)) {
      const 源 = 录们.get(g.回放!);
      const r = 源 ? await 跑一次(c, g, co, base, key, 价, { 源 }) : null;
      if (r && 源?.结果) r.行.估实价元 = Math.round((源.结果.行.搜索元 + r.行.模型元) * 1000) / 1000;
      出.set(g.名, r ?? { 行: { ...空行(g, co), 错: `没有「${g.回放}」的录像（那组没跑或跑错了组名）` }, 状态: null, 材料: [], 嫌疑: [] });
    }
    for (const g of 这家的组) {
      const r = 出.get(g.名)!;
      console.log(`  ${co.名} · ${r.行.组}：${r.行.错 ? `出错 ${r.行.错.slice(0, 60)}` : `${r.行.分 === "" ? "—" : r.行.分} 分，${r.行.秒}s，${r.行.成本元.toFixed(2)} 元${g.回放 ? `（估真实 ${r.行.估实价元.toFixed(2)} 元，缺搜 ${r.行.回放缺搜}、补读 ${r.行.回放补读页} 页）` : ""}，认对 ${r.行.认对}，嫌疑 ${r.行.嫌疑}`}`);
    }
    return 这家的组.map((g) => ({ g, r: 出.get(g.名)! }));
  };
  const 各家 = await 限并发(
    公司们.map((co, i) => ({ co, i })),
    同时几家,
    ({ co, i }) => 跑一家(co, i),
  );
  for (const [i, 这家] of 各家.entries()) {
    const co = 公司们[i];
    for (const { g, r } of 这家) {
      行们.push(r.行);
      状态表.set(`${g.名}|${co.名}`, r.状态);
      for (const x of r.嫌疑) 嫌疑表.push({ 组: g.名, 公司: co.名, ...x });
    }
  }
  await 收拾?.();

  // 列按这一版的行格式定，不按第一行：第一行常是旧录像里的 A（10-17：旧录像没有「回放补读页」，这一列整列没写出来）
  const 列 = Object.keys(空行(c.组合[0], 公司们[0])) as (keyof 一次)[];
  const 格 = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
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
    const 估实价 = 均(成.map((r) => r.估实价元));
    const 缺 = 成.reduce((a, r) => a + r.回放缺搜, 0);
    const 补读 = 成.reduce((a, r) => a + r.回放补读页, 0);
    const 入 = 成.reduce((a, r) => a + r.模型输入 + r.搜索输入, 0);
    const 缓存占比 = 入 ? 成.reduce((a, r) => a + r.模型缓存读 + r.搜索缓存读, 0) / 入 : NaN;
    return { g, rs, 成, 认对率, 有来源率, 有来源比A, 核得上率, 分差, 档一致, 嫌疑, 成本, 估实价, 缺, 补读, 缓存占比, 秒: 均(成.map((r) => r.秒)), 调用: 均(成.map((r) => r.模型调用)), 不过: [] as string[], 两遍差: NaN, 多遍分差: NaN, 两遍明细: "" };
  });
  const 标准 = 汇总.find((x) => x.g === A)!;
  for (const x of 汇总) {
    const g = x.g;
    // 同配置重跑的那几组：逐家把几遍的分拿来，看自己差多少；和 A 比用几遍的平均分
    const 重跑组 = c.组合.filter((h) => h.同配置 === g.名).map((h) => h.名);
    if (重跑组.length) {
      const 分 = (组: string, 公司: string) => {
        const r = 行们.find((y) => y.组 === 组 && y.公司 === 公司 && !y.错);
        return r && r.分 !== "" ? Number(r.分) : NaN;
      };
      const 各家 = 公司们.map((co) => ({ 名: co.名, 遍: [g.名, ...重跑组].map((n) => 分(n, co.名)).filter(Number.isFinite), A: 分(A.名, co.名) }));
      const 有两遍 = 各家.filter((y) => y.遍.length >= 2);
      x.两遍差 = 均(有两遍.map((y) => Math.max(...y.遍) - Math.min(...y.遍)));
      x.两遍明细 = 有两遍.map((y) => `${y.名} ${y.遍.join(" / ")}`).join("；");
      x.多遍分差 = 均(各家.filter((y) => y.遍.length && Number.isFinite(y.A)).map((y) => Math.abs(y.A - 均(y.遍))));
    }
    if (!(x.成.length === x.rs.length && x.rs.length)) x.不过.push("有跑失败的");
    if (!参数.模拟 && !(x.认对率 >= c.过线.认对)) x.不过.push("认错公司");
    if (g === A || g.同配置) continue;
    if (!(x.有来源比A >= -c.过线.有来源差)) x.不过.push("来源比 A 少");
    if (!(x.核得上率 >= 标准.核得上率 - c.过线.核得上差)) x.不过.push("核得上比 A 差");
    if (x.嫌疑 > 标准.嫌疑) x.不过.push("编造嫌疑比 A 多");
    if (Number.isFinite(x.多遍分差) && !(x.多遍分差 <= c.过线.分差)) x.不过.push("分差大（几遍平均）");
    if (!(x.档一致 >= c.过线.档一致 / 6)) x.不过.push("档位不一致");
  }
  const 候选 = 汇总.filter((x) => !x.g.参考 && !x.g.同配置 && x.g !== A && x.不过.length === 0).sort((a, b) => a.估实价 - b.估实价);
  const 默认 = 候选[0] ?? 标准;
  const 数 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");

  const md = [
    "# 背调对比实验汇总",
    "",
    `公司 ${公司们.length} 家${参数.模拟 ? "（模拟数据，不代表真实效果）" : ""}；成本按 b.ai 实价（含缓存读价），实验上限 ${c.成本上限元} 元；评分依据：${c.我方}`,
    "",
    "| 组合 | 跑成 | 认对公司 | 结论带来源 | 来源里核得上 | 和 A 平均分差 | 和 A 档位一致 | 编造嫌疑 | 这次平均花了（元） | 估真实单次成本（元） | 成本 × 3 建议售价（元） | 缓存读占输入 | 平均分析调用 | 平均耗时 | 过线 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...汇总.map(
      (x) =>
        `| ${x.g.名}${x.g.参考 ? "（参考）" : ""} | ${x.成.length}/${x.rs.length} | ${百(x.认对率)} | ${百(x.有来源率)}${x.g === A || !Number.isFinite(x.有来源比A) ? "" : `（比 A ${x.有来源比A >= 0 ? "+" : "−"}${Math.abs(x.有来源比A * 100).toFixed(0)} 点）`} | ${百(x.核得上率)} | ${x.g === A ? "（标准）" : `${数(x.分差, 1)}${Number.isFinite(x.多遍分差) ? `（${x.两遍明细 ? "几遍平均 " : ""}${数(x.多遍分差, 1)}）` : ""}`} | ${x.g === A ? "—" : Number.isFinite(x.档一致) ? `${(x.档一致 * 6).toFixed(1)} / 6` : "—"} | ${x.嫌疑} | ${数(x.成本)} | ${数(x.估实价)}${x.g.回放 ? "（加回搜索）" : ""} | ${数(x.估实价 * 3, 1)} | ${百(x.缓存占比)} | ${数(x.调用, 0)} | ${数(x.秒, 0)}s | ${x.g.参考 || x.g.同配置 ? "—" : x.g === A ? "（标准）" : x.不过.length ? `✗ ${x.不过.join("、")}` : "✓"} |`,
    ),
    ...汇总
      .filter((x) => Number.isFinite(x.两遍差))
      .flatMap((x) => ["", `**${x.g.名} 同配置几遍的分差**：平均 ${数(x.两遍差, 1)} 分（目标 ≤ ${c.过线.分差}）。逐家：${x.两遍明细}。`]),
    "",
    `**建议默认：${默认.g.名}**（${默认 === 标准 ? "没有组合过线，用 A + 降本开关" : "过线组合里最便宜的"}），估真实单次成本 ${数(默认.估实价)} 元，按成本 × 3 约 ${数(默认.估实价 * 3, 1)} 元一次。`,
    ...(汇总.some((x) => x.g.回放)
      ? [
          "",
          `回放组（${汇总.filter((x) => x.g.回放).map((x) => x.g.名).join("、")}）不自己搜，用被回放那组同一家录下的搜索结果和网页，两组的搜索结果一样、只比模型；` +
            "「这次平均花了」只有模型那部分，「估真实单次成本」= 被回放那组同一家的搜索花费 + 回放组的模型花费（上线以后它要自己搜；被回放的 A 搜索用的是 5.5 中等结果量、最多 8 次，比 C 正式配的贵一点，所以偏高）。" +
            `回放不看查询词，A 搜到过的都给；给不出搜索结果的共 ${汇总.filter((x) => x.g.回放).reduce((a, x) => a + x.缺, 0)} 次（应为 0）；A 没读过、现场补读的页共 ${汇总.filter((x) => x.g.回放).reduce((a, x) => a + x.补读, 0)} 页（读网页不花钱，产品里 C 也会自己读）。`,
        ]
      : []),
    "",
    `过线门槛（都和 A 比，A 自己不判）：认对 ${百(c.过线.认对)}、结论带来源不比 A 低 ${Math.round(c.过线.有来源差 * 100)} 个百分点以上（逐家比再平均）、核得上不比 A 低 ${Math.round(c.过线.核得上差 * 100)} 个百分点以上、编造嫌疑不比 A 多、档位平均至少 ${c.过线.档一致} / 6 一致；` +
      `和 A 的分差只在同配置跑了几遍时按平均分判（≤ ${c.过线.分差}），单跑一遍同配置自己就差 7–9 分，不判。`,
    "编造嫌疑逐条在 编造嫌疑.md；每份报告的原文在同目录的 txt；「核得上」只算摘得出数字 / 英文词的结论。",
  ];
  writeFileSync(path.join(参数.输出, "summary.md"), md.join("\n"));

  // 盲评：A 和建议默认并排；都没过线就和最便宜的候选组比（10-17 总控要 5 家盲评，过不过线都出），最多 5 家
  const 盲评组 = 默认 !== 标准 ? 默认 : 汇总.filter((x) => !x.g.参考 && !x.g.同配置 && x.g !== A && x.成.length).sort((a, b) => a.估实价 - b.估实价)[0];
  let 出了盲评 = false;
  if (盲评组) {
    const 对 = 公司们
      .map((co) => ({ 公司: co.名, A: 状态表.get(`${A.名}|${co.名}`), 候选: 状态表.get(`${盲评组.g.名}|${co.名}`) }))
      .filter((x): x is { 公司: string; A: 背调状态; 候选: 背调状态 } => Boolean(x.A && x.候选))
      .slice(0, 5);
    if (对.length) {
      await 出盲评(对, 盲评组.g.名);
      出了盲评 = true;
    }
  }
  console.log(`\n写好了：${参数.输出}/summary.md、results.csv、编造嫌疑.md${出了盲评 ? "、盲评.pdf（答案在 盲评-答案.txt）" : ""}`);
}

// 只在直接运行时跑（单测会 import 上面那几个核对函数）
if (process.argv[1] && /research-bench\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
