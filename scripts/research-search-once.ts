/**
 * 用背调的网页搜索（gpt-5.5 + web_search，和线上同一条路）搜一次，把结果打出来——单独核一条查询词用，花一次搜索的钱（几毛）。
 * 10-18 复核：核风险那一步新加的母公司定向搜索（extras.ts 母公司查询）搜不搜得到 Ansell Lighting 的母公司 Endo。
 *
 *   BENCH_BASE_URL=… BENCH_KEY=… npx tsx scripts/research-search-once.ts --母公司 "Ansell Lighting" --找 Endo
 *   BENCH_BASE_URL=… BENCH_KEY=… npx tsx scripts/research-search-once.ts --查 '"0114 327 1314"'
 *
 * Key 只从环境变量读（实验专用令牌），不打印。--找：结果里出现这个词就打「搜到了」，没出现打「没搜到」
 */
import { gpt搜索 } from "@/lib/research/providers";
import { 母公司查询 } from "@/lib/research/extras";

const a = process.argv.slice(2);
const 取 = (k: string) => {
  const i = a.indexOf(k);
  return i >= 0 ? a[i + 1] : undefined;
};
const 母 = 取("--母公司");
const 查 = 母 ? 母公司查询(母) : 取("--查");
const 找 = 取("--找");
const base = process.env.BENCH_BASE_URL;
const key = process.env.BENCH_KEY;

async function main() {
  if (!查) throw new Error("要 --母公司 公司名 或 --查 查询词");
  if (!base || !key) throw new Error("要 BENCH_BASE_URL 和 BENCH_KEY 两个环境变量（实验专用令牌）");
  console.log(`查询：${查}`);
  const { results, usage } = await gpt搜索({ baseUrl: base, apiKey: key, models: [] }, "gpt-5.5").search(查, {});
  results.forEach((r, i) => console.log(`[${i + 1}] ${r.title}\n    ${r.url}\n    ${(r.snippet ?? "").replace(/\s+/g, " ").slice(0, 300)}`));
  if (!results.length) console.log("（0 条结果）");
  if (usage) console.log(`用量：输入 ${usage.input}（缓存 ${usage.cached ?? 0}）、输出 ${usage.output}`);
  if (找) {
    const 有 = results.some((r) => `${r.title}\n${r.snippet ?? ""}\n${r.url}`.toLowerCase().includes(找.toLowerCase()));
    console.log(有 ? `搜到了：结果里有「${找}」` : `没搜到：结果里没有「${找}」`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
