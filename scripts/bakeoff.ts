/**
 * 对照：同一批问题，两条决策路各跑一遍。
 *
 *   A = JSON 协议（我们原来那套：让模型按规定格式吐一段 JSON 来选工具）
 *   B = 原生 function calling（把工具表按 `tools` 发过去）
 *   C = 原生 + 意图直连（固定的问题根本不问模型，见 lib/agent/intents.ts）
 *
 * 量三件事：**选对工具没有**（最要紧）、**几步答完**、**多久**。
 * 答案文本也打出来，对错要人看——这类问题没有能自动判分的标准答案。
 *
 * 用法（跑在开发库上，会真的调模型，花的是中转站的额度）：
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts --只跑 B --轮 2
 */
import { runAgent } from "../src/lib/agent/run";
import { getBusiness } from "../src/lib/business";
import { prisma } from "../src/lib/prisma";

/** 题目。每道都写清「该调哪个工具」，这是判分的主要依据 */
const 题目: { q: string; 期望工具: string[] }[] = [
  { q: "我目前的渠道有哪些？", 期望工具: ["list_channels"] },
  { q: "哪个渠道带来的客户最多？", 期望工具: ["list_channels"] },
  { q: "现在有哪些线索还没跟？", 期望工具: ["list_leads"] },
  { q: "手上进行中的商机有几个，加起来多少钱？", 期望工具: ["list_opportunities"] },
  { q: "谁提到过预算？", 期望工具: ["search_followups"] },
  { q: "这个月签约金额按销售分一下", 期望工具: ["query_metric"] },
  { q: "武汉大学的有几位，分别是谁？", 期望工具: ["search_customers"] },
  { q: "今天我最该跟进谁？", 期望工具: ["get_watchlist", "get_my_plans"] },
];

function 参数(argv: string[], 名: string, 默认: string) {
  const i = argv.indexOf(名);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 默认;
}

async function 跑一道(q: string, 原生: boolean, user: { id: string; name: string }) {
  const b = await getBusiness();
  const 工具: string[] = [];
  const t0 = Date.now();
  let 出错 = "";
  let text = "";
  let steps = 0;
  try {
    const r = await runAgent(
      { question: q, user, b },
      {
        emit: (e) => {
          // 步骤标签形如 list_channels(关键词)，取括号前那一段
          if (e.status === "running" && e.id.startsWith("tool-")) 工具.push(e.label.split("(")[0]);
        },
        onToken: () => {},
      },
    );
    text = r.text;
    steps = r.steps;
  } catch (e) {
    出错 = e instanceof Error ? e.message : String(e);
  }
  return { ms: Date.now() - t0, 工具, text, steps, 出错 };
}

async function main() {
  const argv = process.argv.slice(2);
  const 只跑 = 参数(argv, "--只跑", "");
  const 轮 = Number(参数(argv, "--轮", "1"));
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true, name: true } });

  const 路线 = [
    { 名: "A·JSON 协议", 原生: false, 直连: false },
    { 名: "B·原生工具", 原生: true, 直连: false },
    { 名: "C·原生+直连", 原生: true, 直连: true },
  ].filter((x) => !只跑 || x.名.startsWith(只跑));

  const 汇总: Record<string, { 对: number; 总: number; 毫秒: number[]; 步: number[] }> = {};

  for (const 路 of 路线) {
    process.env.AGENT_TOOLCALLS = 路.原生 ? "1" : "0";
    process.env.AGENT_INTENTS = 路.直连 ? "1" : "0";
    汇总[路.名] = { 对: 0, 总: 0, 毫秒: [], 步: [] };
    for (let n = 0; n < 轮; n++) {
      for (const t of 题目) {
        const r = await 跑一道(t.q, 路.原生, user);
        const 选对 = r.工具.length > 0 && t.期望工具.includes(r.工具[0]);
        汇总[路.名].总 += 1;
        if (选对) 汇总[路.名].对 += 1;
        汇总[路.名].毫秒.push(r.ms);
        汇总[路.名].步.push(r.steps);
        console.log(
          `\n[${路.名}] ${t.q}\n  工具：${r.工具.join(" → ") || "（一个都没调）"}  ${选对 ? "✓" : `✗ 该用 ${t.期望工具.join(" 或 ")}`}` +
            `  ${(r.ms / 1000).toFixed(1)}s  ${r.steps} 步` +
            (r.出错 ? `\n  出错：${r.出错.slice(0, 160)}` : `\n  答：${r.text.replace(/\s+/g, " ").slice(0, 160)}`),
        );
      }
    }
  }

  console.log("\n\n================ 汇总 ================");
  for (const [名, v] of Object.entries(汇总)) {
    const 中位 = [...v.毫秒].sort((a, b) => a - b)[Math.floor(v.毫秒.length / 2)] ?? 0;
    const 最慢 = Math.max(...v.毫秒, 0);
    const 平均步 = v.步.reduce((s, x) => s + x, 0) / (v.步.length || 1);
    console.log(
      `${名.padEnd(14)} 选对 ${v.对}/${v.总}  中位 ${(中位 / 1000).toFixed(1)}s  最慢 ${(最慢 / 1000).toFixed(1)}s  平均 ${平均步.toFixed(1)} 步`,
    );
  }
  await prisma.$disconnect();
}

void main();
