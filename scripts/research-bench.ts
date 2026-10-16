/**
 * 背调对比实验（2026-10-14 起草，10-16 改成跑正式流程、改评判标准）——同一批真实公司，换搜索、换模型，
 * 比准不准、花多少、多快。
 *
 * ## 跑的是什么
 *
 * **就是产品里那套 6 步编排**（lib/research/run.ts 的 跑背调），不是另写一份简化版：
 * 量出来的成本和耗时就是上线以后用户那一次背调的成本和耗时。只有两头换成直连：
 *   搜索 / 读页  直接调 lib/research/providers.ts（中转站自带的 Claude / GPT 搜索）和 read-page.ts，不经我们的服务器、不扣次数
 *   模型        直接打中转站的 /chat/completions，自己记 token
 * 10-16 用户定了只用 GPT / Claude。
 *
 * ## 准不准怎么判（10-16 定：没有真实的成交 / 回复情况，改核这几样，全部自动算）
 *
 *   认对了没有    公司卡上的官网域名和名单里的官网对不对得上（重名的那几家最要看）。对不上的列出来人看一眼——
 *                名单里的官网是我们事先查好的，也可能它有好几个站
 *   有来源        档案格、评档、信号、风险里，带了来源网址的占几成
 *   来源里真有    带来源的那些，从结论里摘出数字和英文词，去那一页的材料原文里找：找得到算「核得上」。
 *                全是中文、摘不出可比的词的，记「核不了」，不算对也不算错
 *   完整          6 步跑完几步、有没有标「材料不全」
 *   稳定          同一家跑两遍：分数差多少、6 项档位一样的占几成（模型只评档、分由程序算，就是为了这个）
 *   成本 / 耗时   照记：和服务器同一套算法（lib/research/price.ts），单次成本到 4 元就停手（和产品一样）；
 *                汇总里按实测平均成本重算该扣几次（成本 ÷ 0.05 × 1.15，取整）
 *
 * 10-16 总控定：只跑 GPT 组合（搜索 + 分析都是 GPT），20 家各 1 遍、其中 5 家再跑 1 遍看稳定性，约 25 次。
 *
 * ## 用法
 *
 *   npx tsx scripts/research-bench.ts --配置 scripts/research-bench.example.json --公司 scripts/research-bench.companies.csv --模拟
 *     不联网、不花钱：模拟搜索 + 本机假模型（e2e/research-fake-llm.ts），验流程和输出格式
 *   BENCH_BASE_URL=https://api.b.ai/v1 BENCH_KEY=… npx tsx scripts/research-bench.ts --配置 … --公司 …
 *     真跑：花的是中转站额度。Key 只放环境变量，不写进任何文件（~/Opensource_CRM/02-开发与发版/背调-脚本/对比实验.sh 从服务器取，不打印）
 *   … --只跑 1     先跑第 1 家看看
 *
 * 输出到 --输出 指定的目录（默认 research-bench-out/，已在 .gitignore）：results.csv、summary.md、每份报告的 txt。
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
import { 读价目, 模型花费元, 成本上限元, 建议扣次, type 价目 } from "../src/lib/research/price";

/* ---------- 配置 ---------- */

type 组合 = {
  搜索: "claude" | "gpt";
  模型: string;
  /** 每家跑几遍 */
  重复: number;
  /** 只跑名单前几家（对照组省钱用），不填 = 全部 */
  只跑前?: number;
  /** 名单前几家再多跑一遍，看两遍稳不稳 */
  再跑前?: number;
};
type 配置 = {
  /** 「我们卖什么、卖给谁、哪些国家」——等于设置里的业务简介，评分照它评 */
  我方: string;
  组合: 组合[];
  /** 和服务器的 RESEARCH_PRICES 同一个格式；不写就用 price.ts 里的官方价 */
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

function 直连通道(服务: 搜索服务, 账: 账, 已花: () => number): 背调通道 {
  const 上限元 = 成本上限元();
  const 通道: 背调通道 = {
    名: "云端",
    扣次: 0,
    async 价目() {
      return { 扣次: 0, 还剩: null };
    },
    async 开始() {
      return { ok: true, 扣了: 0, 还剩: 0 };
    },
    async 搜索(_runId, query, signal) {
      const r = await 服务.search(query, { signal: signal ?? AbortSignal.timeout(60_000) });
      账.调用 += 1;
      if (r.usage) {
        账.输入 += r.usage.input;
        账.输出 += r.usage.output;
      }
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

/** 每条带来源的结论：核得上 / 核不上 / 核不了（摘不出词） */
export function 核来源(状态: 背调状态, 材料: { url: string; text: string }[]): { 结论数: number; 有来源: number; 核得上: number; 核不上: number; 核不了: number } {
  const 原文 = new Map<string, string>();
  for (const m of 材料) 原文.set(m.url, `${原文.get(m.url) ?? ""}\n${m.text}`.toLowerCase());
  const 条: { 话: string; 源?: string }[] = [
    ...Object.values(状态.fields).map((f) => ({ 话: f!.value, 源: f!.source })),
    ...(状态.评分?.明细 ?? []).filter((d) => d.档 !== "unknown" && d.维度 !== "similar").map((d) => ({ 话: d.证据 ?? "", 源: d.来源 })),
    ...状态.tags.map((t) => ({ 话: t.text, 源: t.source })),
  ];
  let 有来源 = 0, 核得上 = 0, 核不上 = 0, 核不了 = 0;
  for (const x of 条) {
    if (!x.源) continue;
    有来源 += 1;
    const 词 = 可核的词(x.话);
    if (!词.length) {
      核不了 += 1;
      continue;
    }
    const 文 = 原文.get(x.源) ?? "";
    if (词.some((w) => 文.includes(w))) 核得上 += 1;
    else 核不上 += 1;
  }
  return { 结论数: 条.length, 有来源, 核得上, 核不上, 核不了 };
}

/** 同一家两遍：分数差、6 项档位一样的占几成（两遍里都查不到的那一项也算一样） */
export function 稳定(a: 背调状态 | null, b: 背调状态 | null): { 分差: number | null; 档一致: number | null } {
  if (!a?.评分 || !b?.评分) return { 分差: null, 档一致: null };
  const 分差 = a.评分.分 != null && b.评分.分 != null ? Math.abs(a.评分.分 - b.评分.分) : null;
  const 档b = new Map(b.评分.明细.map((d) => [d.维度, d.档]));
  const 同 = a.评分.明细.filter((d) => 档b.get(d.维度) === d.档).length;
  return { 分差, 档一致: 同 / a.评分.明细.length };
}

/* ---------- 跑 ---------- */

type 一行 = {
  公司: string;
  国家: string;
  类型: string;
  规模: string;
  搜索: string;
  模型: string;
  第几遍: number;
  认对: string;
  认到的官网: string;
  分: number | "";
  可信度: number;
  步完成: number;
  不完整: boolean;
  结论数: number;
  有来源: number;
  核得上: number;
  核不上: number;
  核不了: number;
  搜索次数: number;
  读页数: number;
  模型输入: number;
  模型输出: number;
  搜索输入: number;
  搜索输出: number;
  秒: number;
  成本元: number;
  错: string;
};

const 均 = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const 百 = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "—");

async function main() {
  if (!参数.配置 || !参数.公司) throw new Error("要 --配置 和 --公司，见文件头的用法");
  const c = JSON.parse(readFileSync(参数.配置, "utf8")) as 配置;
  const 价: 价目 = 读价目({ RESEARCH_PRICES: c.价目 ? JSON.stringify(c.价目) : process.env.RESEARCH_PRICES });
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
  const 状态们 = new Map<string, (背调状态 | null)[]>();
  for (const g of c.组合) {
    const 这组公司 = g.只跑前 ? 公司们.slice(0, g.只跑前) : 公司们;
    const 模型名 = 参数.模拟 ? "e2e-model" : g.模型;
    for (const [第几家, co] of 这组公司.entries()) {
      const 遍数 = Math.max(1, g.重复) + (g.再跑前 && 第几家 < g.再跑前 ? 1 : 0);
      for (let 遍 = 1; 遍 <= 遍数; 遍++) {
        const 模型账: 账 = { 输入: 0, 输出: 0, 调用: 0 };
        const 搜索账: 账 = { 输入: 0, 输出: 0, 调用: 0 };
        const 搜索模型 = g.搜索 === "claude" ? "claude-sonnet-5.5" : "gpt-5.5";
        const 花了 = () => 模型花费元(价, 模型名, 模型账.输入, 模型账.输出) + 模型花费元(价, 搜索模型, 搜索账.输入, 搜索账.输出) + 搜索账.调用 * 价.每次搜索美元 * 价.汇率;
        const 通道 = 参数.模拟 ? 模拟通道() : 直连通道(g.搜索 === "claude" ? claude搜索(cfg) : gpt搜索(cfg), 搜索账, 花了);
        const t0 = Date.now();
        process.stdout.write(`${co.名} × 搜索 ${g.搜索} × ${模型名}（第 ${遍} 遍）… `);
        let 状态: 背调状态 | null = null;
        let 材料: { url: string; text: string }[] = [];
        let 错 = "";
        try {
          const r = await 跑背调({
            公司: co.名,
            b: { brief: c.我方, fields: { school: "公司", grade: "职位", major: "行业" } },
            通道,
            模型: 直连模型(base, key, 模型名, 模型账),
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
        const 秒 = (Date.now() - t0) / 1000;
        const 搜索次数 = 状态?.usage.searches ?? 搜索账.调用;
        const 成本 = 参数.模拟 ? 0 : 花了();
        const 核 = 状态 ? 核来源(状态, 材料) : { 结论数: 0, 有来源: 0, 核得上: 0, 核不上: 0, 核不了: 0 };
        const 键 = `${g.搜索}×${模型名}×${co.名}`;
        状态们.set(键, [...(状态们.get(键) ?? []), 状态]);
        行们.push({
          公司: co.名,
          国家: co.国家,
          类型: co.类型,
          规模: co.规模,
          搜索: g.搜索,
          模型: 模型名,
          第几遍: 遍,
          认对: 参数.模拟 ? "模拟" : 认对了(状态, co.官网),
          认到的官网: 状态?.fields.site?.value ?? "",
          分: 状态?.评分?.分 ?? "",
          可信度: 状态?.评分?.可信度 ?? 0,
          步完成: 状态 ? Object.values(状态.stages).filter((x) => x.status === "done").length : 0,
          不完整: 状态?.done?.不完整 ?? true,
          ...核,
          搜索次数,
          读页数: 状态?.usage.pages ?? 0,
          模型输入: 模型账.输入,
          模型输出: 模型账.输出,
          搜索输入: 搜索账.输入,
          搜索输出: 搜索账.输出,
          秒: Math.round(秒 * 10) / 10,
          成本元: Math.round(成本 * 1000) / 1000,
          错,
        });
        if (状态) writeFileSync(path.join(参数.输出, `${co.名.replace(/[^\p{L}\p{N}]+/gu, "_")}__${g.搜索}__${模型名}__${遍}.txt`), 报告文本(状态));
        console.log(错 ? `出错：${错.slice(0, 80)}` : `${状态?.评分?.分 ?? "—"} 分，${秒.toFixed(1)}s，${成本.toFixed(2)} 元`);
      }
    }
  }
  await 收拾?.();

  const 列 = Object.keys(行们[0] ?? {}) as (keyof 一行)[];
  const 格 = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(path.join(参数.输出, "results.csv"), "﻿" + [列.join(","), ...行们.map((r) => 列.map((k) => 格(r[k])).join(","))].join("\n"));

  // 汇总：每个组合一行
  const md = [
    "# 背调对比实验汇总",
    "",
    `公司 ${公司们.length} 家${参数.模拟 ? "（模拟数据，不代表真实效果）" : ""}，评分依据：${c.我方}`,
    "",
    "| 组合 | 跑成 | 认对公司 | 有来源 | 来源里核得上 | 6 步跑完 | 两遍分差 | 两遍档位一致 | 平均耗时 | 平均成本（元） | 最贵一次（元） | 碰到 4 元上限 | 按实测该扣几次 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const g of c.组合) {
    const 模型名 = 参数.模拟 ? "e2e-model" : g.模型;
    const rs = 行们.filter((r) => r.搜索 === g.搜索 && r.模型 === 模型名);
    const 成 = rs.filter((r) => !r.错);
    const 第一遍 = 成.filter((r) => r.第几遍 === 1);
    const 认 = 第一遍.filter((r) => r.认对 !== "模拟");
    const 有源 = 均(成.map((r) => (r.结论数 ? r.有来源 / r.结论数 : NaN)).filter(Number.isFinite));
    const 核得上 = 均(成.map((r) => (r.核得上 + r.核不上 ? r.核得上 / (r.核得上 + r.核不上) : NaN)).filter(Number.isFinite));
    const 稳 = [...状态们.entries()].filter(([k, v]) => k.startsWith(`${g.搜索}×${模型名}×`) && v.length >= 2).map(([, v]) => 稳定(v[0], v[1]));
    md.push(
      `| 搜索 ${g.搜索} × ${模型名} | ${成.length}/${rs.length} | ${认.length ? `${认.filter((r) => r.认对 === "对").length}/${认.length}` : "—"} | ${百(有源)} | ${百(核得上)} | ${百(均(成.map((r) => r.步完成 / 6)))} | ${稳.length ? 均(稳.map((x) => x.分差 ?? NaN).filter(Number.isFinite)).toFixed(1) : "—"} | ${稳.length ? 百(均(稳.map((x) => x.档一致 ?? NaN).filter(Number.isFinite))) : "—"} | ${均(成.map((r) => r.秒)).toFixed(0)}s | ${均(成.map((r) => r.成本元)).toFixed(2)} | ${Math.max(0, ...成.map((r) => r.成本元)).toFixed(2)} | ${成.filter((r) => r.成本元 >= 成本上限元() * 0.95).length} | ${参数.模拟 ? "—" : 建议扣次(均(成.map((r) => r.成本元)))} |`,
    );
  }
  const 认错 = 行们.filter((r) => r.第几遍 === 1 && (r.认对 === "错" || r.认对 === "没找到"));
  if (认错.length) {
    md.push("", "## 认错 / 没找到官网的（人看一眼：可能真认错了，也可能它有别的站）", "", "| 组合 | 公司 | 认到的官网 |", "|---|---|---|");
    for (const r of 认错) md.push(`| ${r.搜索} × ${r.模型} | ${r.公司} | ${r.认到的官网 || "（没找到）"} |`);
  }
  md.push("", "「来源里核得上」只算摘得出数字 / 英文词的那些结论；全中文、摘不出词的记「核不了」，在 results.csv 里。每份报告的原文在同目录的 txt。");
  md.push("「按实测该扣几次」= 平均成本 ÷ 0.05 × 1.15，取整（向上）。成本按官方价估（lib/research/price.ts），中转站实价可能更低。");
  writeFileSync(path.join(参数.输出, "summary.md"), md.join("\n"));
  console.log(`\n写好了：${参数.输出}/results.csv、summary.md`);
}

// 只在直接运行时跑（单测会 import 上面那几个核对函数）
if (process.argv[1] && /research-bench\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
