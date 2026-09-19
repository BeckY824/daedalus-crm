/**
 * bakeoff 2.0 —— 20 道题，验 agent 到底会不会选工具。
 *
 * ## 为什么重做
 *
 * 1.0 是 A/B/C 三条决策路的对照，8 道题。**它的 16/16 是构造出来的**：
 * 那 8 道题拿现在的意图表（lib/agent/intents.ts）跑，**全部被直连接走**——
 * C 组的模型一次都没被要求选工具，分数量的是正则表达式，不是模型。
 *
 * 所以 2.0 的第一件事是：**每跑一题之前先报一句它会不会被直连接走**，
 * 并且把「没被接走的题」单独汇总。被接走的题留着（直连本身也要验不回归），
 * 但它们不进「模型选工具」那张分数表。`--只看直连` 可以不花一分钱额度先验题目。
 *
 * ## 量什么
 *
 *   选对工具    —— 最要紧。第一个调用的工具在期望里就算对
 *   零工具断言  —— **直接 0 分**，而且单独列出来。一次数据都没查就下
 *                  「一个都没有」这类结论，比答不上来严重得多（0.37.3 的老账）
 *   抢戏        —— 0.39 新增：该用专用工具的题，被 query_records 接走了几道。
 *                  它排在工具表最后、说明里也写了「别的工具能直接答的就别用它」，
 *                  但那是说明，得用数据验
 *   耗时        —— 中位和最慢
 *
 * 答案文本也打出来，对错要人看——这类问题没有能自动判分的标准答案。
 *
 * 用法（跑在开发库上，会真的调模型，花的是中转站的额度）：
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts --只看直连   # 不花钱，先验题目
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts --只跑 通用查询
 *   DATABASE_URL="file:./manual.db" npx tsx scripts/bakeoff.ts --模型 deepseek-v4.1-flash
 *
 * **成绩单必须写明是哪个模型跑的。** 不写的话，换一次中转站的默认模型，
 * 上一次的数字就悄悄变成了另一件事的记录，而没人看得出来。
 * 不给 `--模型` 就用配置里的默认值，报告里照样把它打出来。
 */
import { runAgent } from "../src/lib/agent/run";
import { 认意图 } from "../src/lib/agent/intents";
import { getBusiness } from "../src/lib/business";
import { prisma } from "../src/lib/prisma";

type 类别 = "通用查询" | "专用工具" | "陷阱";

type 题 = {
  q: string;
  /** 第一个调用的工具落在这里面就算选对 */
  期望: string[];
  类: 类别;
  /** 这道题在验什么，写给下一个改它的人看 */
  验: string;
  /**
   * 调了这里面的工具算跑偏。主要用来量「query_records 抢戏」：
   * 专用工具答得了的题不该绕到通用查询上——它的返回更泛、过程条更难读。
   */
  不该用?: string[];
  /** 必须调工具才能答。零工具作答直接 0 分 */
  必查?: boolean;
};

/**
 * 题目。
 *
 * **至少一半不在意图表里**，而且故意用非标准问法——直连接走的题验的是正则，
 * 不是模型。每道题的 `验` 写清它在挡什么。
 */
const 题目: 题[] = [
  /* ---------- 通用查询才答得了的（专用工具没有这个能力） ---------- */
  {
    q: "联系人里有几位留了微信？",
    期望: ["query_records"],
    类: "通用查询",
    验: "联系人整张表没有专用工具，十一个只读工具一个都不管它",
    必查: true,
  },
  {
    q: "关键联系人一共几位？",
    期望: ["query_records"],
    类: "通用查询",
    验: "布尔字段筛选 + 只计数，没有专用工具能表达",
    必查: true,
  },
  {
    q: "最久没人动过的那条线索是哪个？",
    期望: ["query_records", "list_leads"],
    类: "通用查询",
    验: "要按时间排序取第一条。list_leads 没有排序参数，只能靠它自己按建档倒序——正好是反的",
    必查: true,
  },
  {
    q: "还没做完的任务有几个？",
    期望: ["query_records", "get_my_plans"],
    类: "通用查询",
    验: "Task 表没有专用工具（get_my_plans 只给「我的」，这里问的是全部）",
    必查: true,
  },
  {
    q: "9 月签的单子里，有哪几笔是陈姓学员的？",
    期望: ["query_records", "list_contracts"],
    类: "通用查询",
    验: "跨一跳（签约 → 客户）。list_contracts 有 customerName，但要的是姓氏前缀匹配",
    必查: true,
  },
  {
    q: "学员按跟进状态分别有多少人？",
    期望: ["query_records", "query_metric"],
    类: "通用查询",
    验: "按任意字段分组数个数。query_metric 的 customers_count 也支持 followStatus，两个都算对",
    必查: true,
  },
  {
    q: "金额最大的那笔签约是哪位学员的？",
    期望: ["query_records", "list_contracts"],
    类: "通用查询",
    验: "排序 + 取一条 + 跨表拿姓名",
    必查: true,
  },
  {
    q: "有多少位学员填了预计签约时间？",
    期望: ["query_records", "search_customers"],
    类: "通用查询",
    验: "「非空」这种筛选专用工具表达不了（search_customers 只有起止日期）",
    必查: true,
  },

  /* ---------- 故意写错枚举词：验「当场报错并纠正」那条路 ---------- */
  {
    q: "意向高的学员有几位？",
    // query_metric（customers_count 按 followStatus 分组）也答得了，实跑时它就是这么答对的——
    // 期望写窄了会把一个正确答案判成错的
    期望: ["query_records", "search_customers", "query_metric"],
    类: "陷阱",
    验: "正确的词是「意向较高」。不许查出 0 条就答「一位都没有」——要么当场退回正确取值让它改，要么按状态分组自己对上",
    必查: true,
  },
  {
    // 「…线索有哪些？」会被「线索清单」直连接走，问法改成不沾那条规则的，才验得到模型
    q: "已成交的线索有几条？",
    期望: ["query_records", "list_leads"],
    类: "陷阱",
    验: "线索状态里根本没有「已成交」（只有 待跟进/跟进中/已转化/已放弃）。不许查出 0 条就当没有",
    必查: true,
  },

  /* ---------- 该用专用工具的：验 query_records 有没有抢戏 ---------- */
  {
    q: "小红老师这个渠道带来了哪些学员？",
    期望: ["search_customers", "list_channels"],
    类: "专用工具",
    验: "search_customers 的 channelName 就是干这个的，而且它认整条推荐链。"
      + "这句 2026-09-19 之前会被「渠道清单」直连错接走（去列了渠道清单，那张表里没有学员名单）——intents.ts 已收紧",
    不该用: ["query_records"],
    必查: true,
  },
  {
    q: "武汉大学的有几位，分别是谁？",
    期望: ["search_customers"],
    类: "专用工具",
    验: "search_customers 的 query 一个参数就够，别绕到通用查询",
    不该用: ["query_records"],
    必查: true,
  },
  {
    q: "李四手上有哪些学员？",
    期望: ["search_customers"],
    类: "专用工具",
    验: "ownerName 参数",
    不该用: ["query_records"],
    必查: true,
  },
  {
    q: "陈娜54 现在什么情况？",
    期望: ["search_customers", "get_customer"],
    类: "专用工具",
    验: "问某一个人先 search 再 get，通用查询给不出跟进时间线",
    不该用: ["query_records"],
    必查: true,
  },
  {
    q: "今年签约总额多少？",
    期望: ["query_metric", "list_contracts"],
    类: "专用工具",
    验: "问数字用 query_metric。「今年」不在意图表里（那条只认「这个月/本月」）",
    不该用: ["query_records"],
    必查: true,
  },
  {
    q: "现在还在谈的单子加起来多少钱？",
    期望: ["list_opportunities"],
    类: "专用工具",
    验: "商机清单那条意图可能接走；接不走时模型该选 list_opportunities",
    不该用: ["query_records"],
    必查: true,
  },

  /* ---------- 直连接走的：验它不回归 ---------- */
  {
    q: "我目前的渠道有哪些？",
    期望: ["list_channels"],
    类: "专用工具",
    验: "意图直连「渠道清单」。0.37.3 线上就是这句漏了，模型零工具答「还没有登记任何渠道」",
    必查: true,
  },
  {
    q: "谁提到过预算？",
    期望: ["search_followups"],
    类: "专用工具",
    验: "意图直连「谁提到过某个词」。正则回溯那个坑在这儿（会退成搜「过」字）",
    必查: true,
  },

  /* ---------- 边界 ---------- */
  {
    q: "下个月能签几单？",
    期望: [],
    类: "陷阱",
    验: "问的是将来。该说「只能查已经发生的」，不该真去查出一个 0 然后当预测报出来",
  },
  {
    q: "系统里有联系人吗？",
    期望: ["query_records", "search_customers"],
    类: "陷阱",
    验: "**零工具断言的靶子**。一次都不查就答「有/没有」的，直接 0 分",
    必查: true,
  },
];

/** 「关于数据有没有」的论断。和 run.ts 里那个同源——零工具时出现它就是编的 */
const 凭空断言 = (t: string) =>
  /(还?没有(任何|登记|录入|建立|添加)|一个都没有|一条都没有|一位都没有|都还没有|尚未(登记|录入|建立|添加)|(系统|库|里面)里?(还)?(没有|是空的)|暂无[^，。]{0,6}(数据|记录|渠道|客户|线索|商机)|目前(还)?没有)/.test(t);

function 参数(argv: string[], 名: string, 默认: string) {
  const i = argv.indexOf(名);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 默认;
}

async function 跑一道(q: string, user: { id: string; name: string }, model?: string) {
  const b = await getBusiness();
  const 工具: string[] = [];
  /** 每一步过程条上的那句话。通用查询的口径就写在这里，人要照着核对 */
  const 说明: string[] = [];
  const t0 = Date.now();
  let 出错 = "";
  let text = "";
  let steps = 0;
  try {
    const r = await runAgent(
      { question: q, user, b },
      {
        emit: (e) => {
          if (!e.id.startsWith("tool-")) return;
          // 步骤标签形如 query_records(客户)，取括号前那一段
          if (e.status === "running") 工具.push(e.label.split("(")[0]);
          else if (e.status === "done" && e.detail) 说明.push(e.detail);
        },
        onToken: () => {},
        model,
      },
    );
    text = r.text;
    steps = r.steps;
  } catch (e) {
    出错 = e instanceof Error ? e.message : String(e);
  }
  return { ms: Date.now() - t0, 工具, 说明, text, steps, 出错 };
}

type 计 = {
  对: number;
  总: number;
  零工具断言: string[];
  抢戏: string[];
  毫秒: number[];
  步: number[];
};
const 新计 = (): 计 => ({ 对: 0, 总: 0, 零工具断言: [], 抢戏: [], 毫秒: [], 步: [] });

async function main() {
  const argv = process.argv.slice(2);
  const 只看直连 = argv.includes("--只看直连");
  const 只跑 = 参数(argv, "--只跑", "");
  const 轮 = Number(参数(argv, "--轮", "1"));
  const 指定模型 = 参数(argv, "--模型", "");
  const 题 = 只跑 ? 题目.filter((t) => t.类 === 只跑) : 题目;

  /*
    **先把「谁会被直连接走」摊开。**
    1.0 的 16/16 就是栽在这儿：8 道题全被正则接走了，分数量的不是模型。
    这一段不花额度，改题目时先跑它。
  */
  console.log("================ 题目体检（不调模型）================");
  const 被接走: 题[] = [];
  for (const t of 题) {
    const 命中 = 认意图(t.q);
    if (命中) 被接走.push(t);
    console.log(
      `${命中 ? "直连" : "  模型"}  [${t.类}] ${t.q}` +
        (命中 ? `\n        ↳ 命中「${命中.名}」→ ${命中.调用.map((c) => c.name).join(" → ")}` : ""),
    );
  }
  const 要模型选的 = 题.length - 被接走.length;
  console.log(
    `\n共 ${题.length} 道：直连接走 ${被接走.length} 道，**要模型自己选工具的 ${要模型选的} 道**。` +
      `\n（1.0 那 8 道题这一栏是 0——分数量的是正则，不是模型）`,
  );
  if (要模型选的 < 10) {
    console.log("\n⚠️ 要模型选的不足 10 道，题目该换更非标准的问法——否则量的还是正则");
  }
  if (只看直连) {
    await prisma.$disconnect();
    return;
  }

  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true, name: true } });
  const 按类: Record<string, 计> = {};
  const 全局 = 新计();

  for (let n = 0; n < 轮; n++) {
    for (const t of 题) {
      const 直连 = Boolean(认意图(t.q));
      const r = await 跑一道(t.q, user, 指定模型 || undefined);
      const 首 = r.工具[0] ?? "";
      const 选对 = t.期望.length === 0 ? r.工具.length === 0 : 首 !== "" && t.期望.includes(首);
      const 零工具编造 = Boolean(t.必查) && r.工具.length === 0 && 凭空断言(r.text);
      const 抢戏了 = (t.不该用 ?? []).some((x) => r.工具.includes(x));

      const c = (按类[t.类] ??= 新计());
      for (const 桶 of [c, 全局]) {
        桶.总 += 1;
        // 零工具还敢下结论的，无论选没选对一律 0 分
        if (选对 && !零工具编造) 桶.对 += 1;
        if (零工具编造) 桶.零工具断言.push(t.q);
        if (抢戏了) 桶.抢戏.push(t.q);
        桶.毫秒.push(r.ms);
        桶.步.push(r.steps);
      }

      console.log(
        `\n[${t.类}${直连 ? "·直连" : ""}] ${t.q}` +
          `\n  验：${t.验}` +
          `\n  工具：${r.工具.join(" → ") || "（一个都没调）"}  ` +
          (选对 ? "✓" : t.期望.length ? `✗ 该用 ${t.期望.join(" 或 ")}` : "✗ 这道题不该调工具") +
          (零工具编造 ? "  ⛔ 零工具却下了结论——0 分" : "") +
          (抢戏了 ? `  ⚠️ 抢戏：用了 ${(t.不该用 ?? []).filter((x) => r.工具.includes(x)).join("、")}` : "") +
          `  ${(r.ms / 1000).toFixed(1)}s  ${r.steps} 步` +
          (r.说明.length ? `\n  过程条：${r.说明.join(" ｜ ").slice(0, 300)}` : "") +
          (r.出错 ? `\n  出错：${r.出错.slice(0, 160)}` : `\n  答：${r.text.replace(/\s+/g, " ").slice(0, 200)}`),
      );
    }
  }

  const 报 = (名: string, v: 计) => {
    const 中位 = [...v.毫秒].sort((a, b) => a - b)[Math.floor(v.毫秒.length / 2)] ?? 0;
    const 最慢 = Math.max(...v.毫秒, 0);
    const 平均步 = v.步.reduce((s, x) => s + x, 0) / (v.步.length || 1);
    console.log(
      `${名.padEnd(10)} 选对 ${String(v.对).padStart(2)}/${String(v.总).padEnd(2)}  ` +
        `中位 ${(中位 / 1000).toFixed(1)}s  最慢 ${(最慢 / 1000).toFixed(1)}s  平均 ${平均步.toFixed(1)} 步`,
    );
  };

  const { getLlmConfig } = await import("../src/lib/llm");
  const 实际模型 = 指定模型 || (await getLlmConfig())?.model || "（没配）";
  console.log(`\n\n================ 汇总 · 模型 ${实际模型} ================`);
  for (const [名, v] of Object.entries(按类)) 报(名, v);
  console.log("─".repeat(38));
  报("全部", 全局);

  if (全局.零工具断言.length) {
    console.log(`\n⛔ 零工具却下结论（每一条都是 0 分，也是最该先修的）：`);
    for (const q of 全局.零工具断言) console.log(`   · ${q}`);
  } else {
    console.log(`\n✓ 没有一次零工具断言`);
  }

  if (全局.抢戏.length) {
    console.log(`\n⚠️ query_records 抢戏（专用工具答得了，却绕到通用查询）：`);
    for (const q of 全局.抢戏) console.log(`   · ${q}`);
    console.log(`   → 抢戏说明工具说明里那句「别的工具能直接答的就别用它」不够硬，考虑调它在工具表里的位置或措辞`);
  } else {
    console.log(`\n✓ 没有抢戏：专用工具答得了的题，一道都没绕到通用查询上`);
  }

  await prisma.$disconnect();
}

void main();
