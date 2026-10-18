/**
 * 真实性程序直查的实测（2026-10-18）：一组写好的公司 + 线索，直接跑 lib/research/verify/check.ts 的 核验（和服务器
 * /api/gateway/v1/research/verify 同一份代码），连真的 RDAP、工商库、VIES、制裁名单。**不调模型、不花中转站的钱**。
 *
 *   RESEARCH_CACHE_DIR=… npx tsx scripts/research-verify-cases.ts --用例 scripts/research-verify.cases.json --输出 目录
 *
 * 开跑前先把四份制裁名单下全（第一次要几分钟，之后用缓存）。每个用例写一行：总灯（按服务器这几项算，不含网上足迹）、
 * 各项的灯和事实；用例里写了「应该」的（比如 { "email": "red" }）对一下，不对的标出来。输出 verify-cases.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 核验 } from "../src/lib/research/verify/check";
import { 同步名单, 取名单, 缓存目录 } from "../src/lib/research/verify/sanctions";
import { 定总灯, 灯符 } from "../src/lib/research/verify/rules";
import { 核验项表, type 核验请求, type 灯 } from "../src/lib/research/verify/types";

type 用例 = { 说明: string; 请求: Omit<核验请求, "runId">; 应该?: Partial<Record<string, 灯>> };

const a = process.argv.slice(2);
const 取 = (k: string) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : undefined);
const 用例文件 = 取("--用例") ?? "scripts/research-verify.cases.json";
const 输出 = 取("--输出") ?? "research-verify-out";

async function main() {
  const 用例们 = JSON.parse(readFileSync(用例文件, "utf8")) as 用例[];
  mkdirSync(输出, { recursive: true });
  console.log(`制裁名单缓存在 ${缓存目录()}，先下全…`);
  const t0 = Date.now();
  await 同步名单();
  const 单 = await 取名单({ 等秒: 1 });
  console.log(`名单 ${单.map((x) => `${x.名} ${x.条.length} 条`).join("、")}（${Math.round((Date.now() - t0) / 1000)}s）`);

  const 名 = Object.fromEntries(核验项表.map((x) => [x.key, x.label]));
  const 段: string[] = [];
  const 表: string[] = ["| # | 用例 | 总灯（不含足迹） | 各项 | 对不对 | 秒 |", "|---|---|---|---|---|---|"];
  let 不对 = 0;
  for (const [i, u] of 用例们.entries()) {
    const t = Date.now();
    // 开着「假 IP」代理的电脑上读官网要放行（对比实验.sh 同一个开关）；服务器上不需要
    const r = await 核验(u.请求, { 放行代理假IP: process.env.BENCH_ALLOW_FAKE_IP === "1" });
    const 秒 = ((Date.now() - t) / 1000).toFixed(1);
    const 总 = 定总灯(r.项);
    const 错 = Object.entries(u.应该 ?? {}).filter(([k, v]) => r.项.find((x) => x.key === k)?.灯 !== v);
    不对 += 错.length ? 1 : 0;
    const 对 = !u.应该 ? "—" : 错.length ? `✗ ${错.map(([k, v]) => `${名[k]}应为${灯符[v!]}`).join("，")}` : "✓";
    表.push(`| ${i + 1} | ${u.说明} | ${灯符[总.总灯]} ${总.总字} | ${r.项.map((x) => 灯符[x.灯]).join("")} | ${对} | ${秒} |`);
    段.push(
      `### ${i + 1}. ${u.说明}`,
      "",
      "```json",
      JSON.stringify(u.请求),
      "```",
      "",
      ...r.项.map((x) => `- ${灯符[x.灯]} **${名[x.key]}**（${x.态}）：${x.事实}${x.硬红 ? `  ⟵ 硬红：${x.硬红}` : ""}${x.链接?.length ? `  ${x.链接.map((l) => `[${l.title}](${l.url})`).join(" ")}` : ""}`),
      "",
    );
    console.log(`${i + 1}. ${u.说明}：${灯符[总.总灯]} ${r.项.map((x) => 灯符[x.灯]).join("")} ${对}（${秒}s）`);
  }
  const md = [
    "# 真实性程序直查实测",
    "",
    `${new Date().toISOString()}；${用例们.length} 个用例；不调模型、不花中转站的钱。各项顺序：工商登记 / 税号 / 域名 / 官网 / 邮箱 / 电话 / 制裁名单（发件 IP、网上足迹不在服务器这头）。`,
    `制裁名单：${单.map((x) => `${x.名} ${x.条.length} 条（${x.更新于.slice(0, 16)}）`).join("、")}`,
    "",
    ...表,
    "",
    不对 ? `**${不对} 个用例和预期不一样**，见上表。` : "预期全对上。",
    "",
    ...段,
  ];
  writeFileSync(path.join(输出, "verify-cases.md"), md.join("\n"));
  console.log(`\n写好了：${path.join(输出, "verify-cases.md")}`);
}

if (process.argv[1] && /research-verify-cases\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
