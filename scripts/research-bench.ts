/**
 * 背调对比实验（2026-10-14 起草，10-16 改成跑正式流程）——同一批真实公司，换搜索、换模型，比准不准、花多少、多快。
 *
 * ## 跑的是什么
 *
 * **就是产品里那套 6 步编排**（lib/research/run.ts 的 跑背调），不是另写一份简化版：
 * 量出来的成本和耗时就是上线以后用户那一次背调的成本和耗时。只有两头换成直连：
 *   搜索 / 读页  直接调 lib/research/providers.ts（中转站自带的 Claude / GPT 搜索）和 read-page.ts，不经我们的服务器、不扣次数
 *   模型        直接打中转站的 /chat/completions，自己记 token
 * 10-16 用户定了只用 GPT / Claude，所以组合是「搜索：claude / gpt」×「分析模型：claude-sonnet-5.5 / gpt-5.5 / …」。
 *
 * ## 量什么
 *
 *   准不准  —— 机器判不了：导出一张人工打分表（ratings.csv），每份报告打「认准了没有」和 1–5 分
 *   相关性  —— 程序按 score.ts 算出来的分；公司名单里写了标签（成交 / 有回复 / 没下文 / 不相关）的，
 *              汇总里按标签看平均分：分数分不开这几类，权重就得调
 *   成本    —— 模型 token × 单价 + 搜索次数 × 搜索单价（Claude 搜索另收每次的钱，见配置），折成元，再折成「扣几次 AI」
 *   耗时    —— 每家公司每个组合一次背调的秒数
 *
 * ## 用法
 *
 *   npx tsx scripts/research-bench.ts --配置 scripts/research-bench.example.json --公司 scripts/research-bench.companies.example.csv --模拟
 *     不联网、不花钱：模拟搜索 + 本机假模型（e2e/research-fake-llm.ts），验流程和输出格式
 *   BENCH_BASE_URL=https://api.b.ai/v1 BENCH_KEY=… npx tsx scripts/research-bench.ts --配置 my.json --公司 my.csv
 *     真跑：花的是中转站额度。Key 只放环境变量，不写进任何文件
 *   … --只跑 3     先跑前 3 家看看
 *
 * 输出到 --输出 指定的目录（默认 research-bench-out/，已在 .gitignore）：results.csv、ratings.csv、summary.md、每份报告的 txt。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 跑背调, type 模型调用 } from "../src/lib/research/run";
import { claude搜索, gpt搜索, type 搜索服务 } from "../src/lib/research/providers";
import { 读网页 } from "../src/lib/research/read-page";
import { 模拟通道 } from "../src/lib/research/mock";
import { 报告文本 } from "../src/lib/research/report";
import type { 背调通道 } from "../src/lib/research/channel";
import type { 背调状态 } from "../src/lib/research/state";

/* ---------- 配置 ---------- */

type 单价 = { 输入每百万: number; 输出每百万: number };
type 配置 = {
  /** 「我们卖什么、卖给谁、哪些国家」——等于设置里的业务简介 */
  我方: string;
  搜索: ("claude" | "gpt")[];
  模型: string[];
  /** 美元单价（中转站实付价；不知道就填 0，成本列会是 0，token 照记） */
  单价: Record<string, 单价>;
  /** 每次搜索另收的钱（美元）：Claude web_search 官方价约 $0.01 / 次，GPT 按中转站的价 */
  每次搜索: Record<string, number>;
  汇率: number;
  /** 「1 次 AI」值多少元。用来把每家的成本折成「扣几次」 */
  一次的成本: number;
};

type 公司 = { 名: string; 网址?: string; 标签?: string };

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
  const 位 = (n: string) => 列.indexOf(n);
  return 身
    .map((l) => {
      const c = l.split(",").map((x) => x.trim());
      return { 名: c[位("公司")], 网址: c[位("网址")] || undefined, 标签: c[位("标签")] || undefined };
    })
    .filter((x) => x.名);
}

/* ---------- 直连模型：打 OpenAI 兼容的 /chat/completions，自己记 token ---------- */

type 账 = { 输入: number; 输出: number; 调用: number };

function 直连模型(base: string, key: string, model: string, 账: 账): 模型调用 {
  const 发 = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 2000, ...body }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`接口返回 ${r.status}：${t.slice(0, 200)}`), { status: r.status });
    const j = JSON.parse(t) as { choices?: { message?: { content?: string | null; tool_calls?: unknown[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    账.调用 += 1;
    账.输入 += j.usage?.prompt_tokens ?? 0;
    账.输出 += j.usage?.completion_tokens ?? 0;
    return j.choices?.[0]?.message ?? {};
  };
  return {
    async tools(messages, tools, opts) {
      const m = await 发({ messages, tools }, opts.signal);
      return { toolCalls: (m.tool_calls ?? []) as never, text: (m.content ?? "").trim() };
    },
    async json(messages, opts) {
      let m;
      try {
        m = await 发({ messages, response_format: { type: "json_object" } }, opts.signal);
      } catch (e) {
        if ((e as { status?: number }).status === 400) m = await 发({ messages }, opts.signal);
        else throw e;
      }
      const s = (m.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return JSON.parse(s || "{}");
    },
  };
}

/* ---------- 直连通道：搜索走中转站自带的搜索，读页走我们那份带内网防护的读法 ---------- */

function 直连通道(服务: 搜索服务, 账: 账): 背调通道 {
  return {
    名: "云端",
    扣次: 0,
    async 开始() {
      return { ok: true, 扣了: 0, 还剩: 0 };
    },
    async 搜索(_runId, query, signal) {
      const r = await 服务.search(query, { signal: signal ?? AbortSignal.timeout(60_000) });
      if (r.usage) {
        账.输入 += r.usage.input;
        账.输出 += r.usage.output;
      }
      return r.results;
    },
    async 读页(_runId, url, signal) {
      return 读网页(url, { signal });
    },
    async 收尾() {
      return null;
    },
  };
}

/* ---------- 跑 ---------- */

type 一行 = {
  公司: string;
  标签: string;
  搜索: string;
  模型: string;
  分: number | "";
  可信度: number;
  风险级别: string;
  字段数: number;
  不完整: boolean;
  搜索次数: number;
  读页数: number;
  模型输入: number;
  模型输出: number;
  搜索输入: number;
  搜索输出: number;
  秒: number;
  成本元: number;
  折合次数: number;
  错: string;
};

const 元 = (c: 配置, model: string, 入: number, 出: number) => ((入 * (c.单价[model]?.输入每百万 ?? 0) + 出 * (c.单价[model]?.输出每百万 ?? 0)) / 1e6) * c.汇率;

async function main() {
  if (!参数.配置 || !参数.公司) throw new Error("要 --配置 和 --公司，见文件头的用法");
  const c = JSON.parse(readFileSync(参数.配置, "utf8")) as 配置;
  let 公司们 = 读公司(参数.公司);
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
  const cfg = { baseUrl: base, apiKey: key, models: [] };

  const 行们: 一行[] = [];
  const 组合 = c.搜索.flatMap((s) => (参数.模拟 ? c.模型.slice(0, 1) : c.模型).map((m) => ({ 搜索: s, 模型: 参数.模拟 ? "e2e-model" : m })));
  for (const co of 公司们) {
    for (const g of 组合) {
      const 模型账: 账 = { 输入: 0, 输出: 0, 调用: 0 };
      const 搜索账: 账 = { 输入: 0, 输出: 0, 调用: 0 };
      const 通道 = 参数.模拟 ? 模拟通道() : 直连通道(g.搜索 === "claude" ? claude搜索(cfg) : gpt搜索(cfg), 搜索账);
      const t0 = Date.now();
      process.stdout.write(`${co.名} × 搜索 ${g.搜索} × ${g.模型} … `);
      let 状态: 背调状态 | null = null;
      let 错 = "";
      try {
        const r = await 跑背调({
          公司: co.名,
          客户: co.网址 ? { id: "bench", 已知: `官网 ${co.网址}` } : undefined,
          b: { brief: c.我方, fields: { school: "公司", grade: "职位", major: "行业" } },
          通道,
          模型: 直连模型(base, key, g.模型, 模型账),
          老客户: [],
          发: () => {},
        });
        if (r.ok) 状态 = r.状态;
        else 错 = r.error;
      } catch (e) {
        错 = e instanceof Error ? e.message : String(e);
      }
      const 秒 = (Date.now() - t0) / 1000;
      const 搜索次数 = 状态?.usage.searches ?? 0;
      const 搜索模型 = g.搜索 === "claude" ? "claude-sonnet-5.5" : "gpt-5.5";
      const 成本 = 元(c, g.模型, 模型账.输入, 模型账.输出) + 元(c, 搜索模型, 搜索账.输入, 搜索账.输出) + 搜索次数 * (c.每次搜索[g.搜索] ?? 0) * c.汇率;
      行们.push({
        公司: co.名,
        标签: co.标签 ?? "",
        搜索: g.搜索,
        模型: g.模型,
        分: 状态?.评分?.分 ?? "",
        可信度: 状态?.评分?.可信度 ?? 0,
        风险级别: 状态?.评分?.风险级别 ?? "",
        字段数: 状态 ? Object.keys(状态.fields).length : 0,
        不完整: 状态?.done?.不完整 ?? true,
        搜索次数,
        读页数: 状态?.usage.pages ?? 0,
        模型输入: 模型账.输入,
        模型输出: 模型账.输出,
        搜索输入: 搜索账.输入,
        搜索输出: 搜索账.输出,
        秒: Math.round(秒 * 10) / 10,
        成本元: Math.round(成本 * 1000) / 1000,
        折合次数: c.一次的成本 > 0 ? Math.round((成本 / c.一次的成本) * 10) / 10 : 0,
        错,
      });
      if (状态) writeFileSync(path.join(参数.输出, `${co.名.replace(/[^\p{L}\p{N}]+/gu, "_")}__${g.搜索}__${g.模型}.txt`), 报告文本(状态));
      console.log(错 ? `出错：${错.slice(0, 80)}` : `${状态?.评分?.分 ?? "—"} 分，${秒.toFixed(1)}s，${成本.toFixed(2)} 元`);
    }
  }
  await 收拾?.();

  const 列 = Object.keys(行们[0] ?? {}) as (keyof 一行)[];
  const 格 = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(path.join(参数.输出, "results.csv"), [列.join(","), ...行们.map((r) => 列.map((k) => 格(r[k])).join(","))].join("\n"));
  writeFileSync(
    path.join(参数.输出, "ratings.csv"),
    ["公司,搜索,模型,认准了没有(1/0),准不准(1-5),备注", ...行们.map((r) => [r.公司, r.搜索, r.模型, "", "", ""].map(格).join(","))].join("\n"),
  );

  // 汇总：每个组合的平均耗时 / 成本 / 分数，以及按标签的平均分
  const 组 = new Map<string, 一行[]>();
  for (const r of 行们) 组.set(`${r.搜索} × ${r.模型}`, [...(组.get(`${r.搜索} × ${r.模型}`) ?? []), r]);
  const 均 = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const md = ["# 背调对比实验汇总", "", `公司 ${公司们.length} 家${参数.模拟 ? "（模拟数据，不代表真实效果）" : ""}`, "", "| 组合 | 成功 | 平均耗时 | 平均成本（元） | 折合扣次 | 平均分 | 不完整 |", "|---|---|---|---|---|---|---|"];
  for (const [k, rs] of 组) {
    const 成 = rs.filter((r) => !r.错);
    md.push(`| ${k} | ${成.length}/${rs.length} | ${均(成.map((r) => r.秒)).toFixed(1)}s | ${均(成.map((r) => r.成本元)).toFixed(2)} | ${均(成.map((r) => r.折合次数)).toFixed(1)} | ${均(成.filter((r) => r.分 !== "").map((r) => Number(r.分))).toFixed(0)} | ${成.filter((r) => r.不完整).length} |`);
  }
  const 标签们 = [...new Set(行们.map((r) => r.标签).filter(Boolean))];
  if (标签们.length) {
    md.push("", "## 按标签的平均分（分数要能把「成交」和「不相关」分开）", "", "| 组合 | " + 标签们.join(" | ") + " |", "|---|" + 标签们.map(() => "---|").join(""));
    for (const [k, rs] of 组) md.push(`| ${k} | ${标签们.map((t) => 均(rs.filter((r) => r.标签 === t && r.分 !== "").map((r) => Number(r.分))).toFixed(0)).join(" | ")} |`);
  }
  md.push("", "准不准要人看：打开每份报告的 txt，在 ratings.csv 里打分。");
  writeFileSync(path.join(参数.输出, "summary.md"), md.join("\n"));
  console.log(`\n写好了：${参数.输出}/results.csv、ratings.csv、summary.md`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
