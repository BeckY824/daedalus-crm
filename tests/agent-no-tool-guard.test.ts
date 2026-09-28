/**
 * 空手作答的兜底。
 *
 * 2026-09-18 线上：问「我现在有什么渠道」，模型（glm-5.3-flash）**一个工具都没调**，
 * 直接答「查了一下，目前系统里还没有登记任何渠道」——而库里有一个叫「明杰哥」的。
 * 存下来的 steps 只有一条 `{"id":"answer"}`，一次工具调用都没有。
 *
 * 根因是循环里那句「没调工具 = 它认为够了」：第一步就没调，意味着上下文里
 * 一条数据都没有，而最终提示词写着「只基于工具结果」——手上没有工具结果，它就自己编。
 * **凭空断言用户的数据比答不上来严重得多**：用户没法分辨哪句是查过的、哪句是编的。
 *
 * 所以第一步空手时顶回去一次；再空手就放行，免得「你能做什么」这种问题被卡住。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { 不是答案, 日期对照, 有卡时的要求 } from "@/lib/agent/run";
import { dayjs } from "@/lib/utils";

let 决策轮次: { messages: { role: string; content: string }[] }[] = [];
/** 每一轮决策要不要调工具，由用例摆好 */
let 剧本: ("空手" | "调工具" | "一步两个")[] = [];
/** 每一轮最终回答吐什么 */
let 回答剧本: string[] = [];
/** 每一轮最终回答收到的提示词 */
let 回答轮次: string[] = [];

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async () => ({ final: true }),
  chatTextStream: async (
    messages: { role: string; content: string }[],
    _o: unknown,
    onToken: (t: string) => void,
  ) => {
    回答轮次.push(String(messages[messages.length - 1].content));
    const 答 = 回答剧本.shift() ?? "好的";
    // 逐字吐，模拟流式——要验的正是「编造的那版有没有流到界面」
    for (const ch of 答) onToken(ch);
    return 答;
  },
  chatTools: async (messages: { role: string; content: string }[]) => {
    // 存副本：runAgent 一直往同一个数组里 push，存引用的话断言时看到的是后来的状态
    决策轮次.push({ messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })) });
    const 这轮 = 剧本.shift() ?? "空手";
    if (这轮 === "空手") return { text: "", toolCalls: [] };
    if (这轮 === "一步两个")
      return {
        text: "",
        toolCalls: [
          { id: "c1", function: { name: "list_channels", arguments: "{}" } },
          { id: "c2", function: { name: "list_channels", arguments: '{"keyword":"老带新"}' } },
        ],
      };
    return { text: "", toolCalls: [{ id: "c1", function: { name: "list_channels", arguments: "{}" } }] };
  },
}));

const b = { customer: "学员", brief: "招生", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };
/** 绕开意图直连，专测模型那条路 */
const 问 = async (q: string) => {
  process.env.AGENT_INTENTS = "0";
  const { runAgent } = await import("@/lib/agent/run");
  return runAgent({ question: q, user, b });
};

beforeEach(() => {
  决策轮次 = [];
  剧本 = [];
  回答剧本 = [];
  回答轮次 = [];
});

describe("第一步就不调工具", () => {
  it("顶回去一次，并且把「不许凭印象断言」说清楚", async () => {
    剧本 = ["空手", "调工具"];
    await 问("我现在有什么渠道");

    expect(决策轮次.length).toBeGreaterThanOrEqual(2);
    const 第二轮 = 决策轮次[1].messages;
    const 最后一条 = 第二轮[第二轮.length - 1];
    expect(最后一条.role).toBe("user");
    expect(最后一条.content).toContain("还没有查任何数据");
    expect(最后一条.content).toContain("不许凭印象断言");
  });

  it("顶一次就够——第二次还空手就放它去回答，不会卡在这儿来回拉锯", async () => {
    剧本 = ["空手", "空手", "空手"];
    await 问("你能做什么");
    // 顶了一次 → 第二轮仍空手 → 直接去组织回答。不该有第三轮决策
    expect(决策轮次.length).toBe(2);
  });

  it("本来就调了工具的，一次都不顶", async () => {
    剧本 = ["调工具", "空手"];
    await 问("我现在有什么渠道");
    const 有顶过 = 决策轮次.some((轮) => 轮.messages.some((m) => String(m.content).includes("还没有查任何数据")));
    expect(有顶过).toBe(false);
  });
});

/**
 * 第二道闸：回答级。
 *
 * 循环里那道只顶一次，顶完还不查就放它来组织回答——到这儿手上依然一条数据都没有，
 * 它照样能写出「查了一下，系统里还没有登记任何渠道」。所以回答出口再拦一道：
 * **零工具 + 关于数据有没有的论断 = 必然是编的**，拦下重答。
 *
 * 代价是零工具那次不流式（先攒完再验）。零工具本来就该是极少数，
 * 而让用户眼睁睁看着一句编的话逐字蹦出来更糟。
 */
describe("凭空断言的判别", () => {
  it("认得出编造的那几种说法", async () => {
    const { 凭空断言 } = await import("@/lib/agent/run");
    for (const s of [
      "查了一下，目前系统里还没有登记任何渠道。",
      "你这边一个都没有。",
      "库里是空的，建议先录入。",
      "尚未录入任何客户。",
      "目前没有相关记录。",
    ]) expect(凭空断言(s), s).toBe(true);
  });

  it("正常回答不误伤", async () => {
    const { 凭空断言 } = await import("@/lib/agent/run");
    for (const s of [
      "你现在有 1 个渠道：明杰哥，负责人是 becky。",
      "这个月签了 2 单，合计 4.96 万。",
      "张三最近一次跟进是 09-09，他说预算还没批下来。",
      "我可以帮你查客户、渠道、线索和商机。",
    ]) expect(凭空断言(s), s).toBe(false);
  });
});

describe("零工具 + 编造 = 拦下重答", () => {
  it("编的那一版一个字都不流给用户，重答的才流", async () => {
    剧本 = ["空手", "空手"]; // 顶过一次仍不查
    回答剧本 = ["查了一下，目前系统里还没有登记任何渠道。", "我还没查过库，先让我查一下再回答。"];
    const 推给界面: string[] = [];

    process.env.AGENT_INTENTS = "0";
    const { runAgent } = await import("@/lib/agent/run");
    const r = await runAgent(
      { question: "我现在有什么渠道", user, b },
      { onToken: (t) => 推给界面.push(t) },
    );

    const 屏幕 = 推给界面.join("");
    expect(屏幕).not.toContain("还没有登记任何渠道");
    expect(屏幕).toContain("先让我查一下");
    expect(r.text).toContain("先让我查一下");
    // 重答那一轮的提示词里要写明「你一次数据都没查过」
    expect(回答轮次[1]).toContain("一次数据都没查过");
  });

  it("零工具但没编造的，原样放行，不白跑第二轮", async () => {
    剧本 = ["空手", "空手"];
    回答剧本 = ["我可以帮你查客户、渠道、线索和商机。"];
    const 推给界面: string[] = [];

    process.env.AGENT_INTENTS = "0";
    const { runAgent } = await import("@/lib/agent/run");
    await runAgent({ question: "你能做什么", user, b }, { onToken: (t) => 推给界面.push(t) });

    expect(推给界面.join("")).toContain("我可以帮你查");
    expect(回答轮次.length).toBe(1); // 只组织了一次回答
  });
});

/**
 * 「吐的根本不是答案」。
 *
 * 三种形态都是 bakeoff 2.0 真跑出来的，**全都流到了用户屏幕上**：
 *   deepseek-v4.1-flash：`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="get_watchlist">…`
 *   glm-5.3-flash：      `get_my_plans`（光秃秃一个工具名）
 *   glm-5.3-flash：      `我来查一下各跟进状态的学员数量。`（说了要查，然后没查）
 *
 * 和「凭空断言」是两回事：那道闸问「有没有编造数据」，而且只在零工具时才开；
 * DSML 那次调了两个工具，闸根本不会开。这道闸问的是**它到底答没答**。
 */
describe("吐的不是答案", () => {
  const 工具名 = ["get_my_plans", "search_customers", "query_records"];
  const 是 = (t: string) => 不是答案(t, 工具名);

  it("工具调用的协议残片", () => {
    expect(是('<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="get_watchlist"> </｜｜DSML｜｜ calls>')).toBe(true);
    expect(是('<tool_call>{"name":"x"}</tool_call>')).toBe(true);
    expect(是("<function_call>")).toBe(true);
  });

  it("整段就是一个工具名", () => {
    expect(是("get_my_plans")).toBe(true);
    expect(是("get_my_plans。")).toBe(true);
    expect(是("  search_customers  ")).toBe(true);
  });

  it("只承诺不执行", () => {
    expect(是("我来查一下各跟进状态的学员数量。")).toBe(true);
    expect(是("这就帮你查一下。")).toBe(true);
  });

  it("空的也算", () => {
    expect(是("")).toBe(true);
    expect(是("   \n ")).toBe(true);
  });

  /** 收得紧一点：正常答案一个都不能误伤，否则每次都白白多跑一轮回答 */
  it("正常答案不误伤", () => {
    expect(是("**19 位**学员填了预计签约时间。")).toBe(false);
    expect(是("我来算一下：本月一共 12 笔，合计 ¥198,000。")).toBe(false); // 带数字的开场白是正常的
    expect(是("没有匹配的学员。要不要换个条件再找一次？")).toBe(false);
    expect(是("陈娜54 现在是「已签约」，上次跟进在 9 月 12 日。")).toBe(false);
    // 正文里提到工具名不算——只有「整段就是一个工具名」才算
    expect(是("我用 search_customers 查了一遍，武汉大学的有 3 位。")).toBe(false);
  });
});

/**
 * 重答之前要先把已经推出去的正文抹掉。
 *
 * 没有这一步的话，重答的文本会**接在**坏的那一段后面（lib/ai-stream.ts 里
 * token 是 `text += e.text`），屏幕上就成了
 * 「<｜｜DSML｜｜ calls>…没有匹配的学员。」——比只有坏的那一段更让人看不懂。
 *
 * 有了 reset，好情况（绝大多数）照样逐字蹦，不必为了这个把所有回答都改成先攒后推。
 */
describe("重答前先 reset", () => {
  it("吐了协议标记：先 reset，再把正经答案推出去", async () => {
    剧本 = ["调工具"];
    回答剧本 = ['<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="get_watchlist">', "查到 3 位。"];
    const 重置了: number[] = [];
    const 推出去的: string[] = [];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    const r = await runAgent(
      { question: "下个月能签几单", user, b },
      { onToken: (t) => 推出去的.push(t), onReset: () => 重置了.push(推出去的.length) },
    );
    expect(重置了.length, "没有 reset，坏的那一段会留在屏幕上").toBe(1);
    // reset 发生在第一段推完之后、第二段推出去之前
    expect(重置了[0]).toBeGreaterThan(0);
    expect(r.text).toBe("查到 3 位。");
    expect(回答轮次.length, "该重答一次").toBe(2);
    expect(回答轮次[1]).toContain("不要再输出任何工具调用");
  });

  it("重答还是吐标记：标记一个字都不上屏，换成一句「没做成」（2026-09-28 桌面端连着四次就是这样留在屏幕上的）", async () => {
    剧本 = ["调工具"];
    const 标记 = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="find_person">';
    回答剧本 = [标记, 标记];
    let 屏幕 = "";
    const { runAgent, 没答成 } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    const r = await runAgent(
      { question: "我没有看到卡片", user, b },
      { onToken: (t) => { 屏幕 += t; }, onReset: () => { 屏幕 = ""; } },
    );
    expect(r.text).toBe(没答成);
    expect(屏幕, "reset 之后屏幕上只该有那句话").toBe(没答成);
    expect(屏幕).not.toMatch(/DSML/);
  });

  it("答得好好的就不 reset，也不重答", async () => {
    剧本 = ["调工具"];
    回答剧本 = ["武汉大学的有 3 位：钱同学、孙同学、李同学。"];
    const 重置了: number[] = [];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    await runAgent({ question: "武汉大学的有几位", user, b }, { onToken: () => {}, onReset: () => 重置了.push(1) });
    expect(重置了.length).toBe(0);
    expect(回答轮次.length).toBe(1);
  });
});

/**
 * 说有卡片、这一轮其实一张都没生成（2026-09-28 桌面端：「你在卡片上确认一下」，屏幕上什么都没有）。
 * 抹掉重答；重答还提卡片，就换成一句实话。
 */
describe("说有卡片但没有卡片", () => {
  it("抹掉、重答，重答不提卡片就用重答的", async () => {
    剧本 = ["调工具"];
    回答剧本 = ["这条挂在李文龙名下，你在卡片上确认一下。", "要记这条交付，还差客户是哪一位——请告诉我全名。"];
    let 屏幕 = "";
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    const r = await runAgent({ question: "明天去李文龙那边交付", user, b }, { onToken: (t) => { 屏幕 += t; }, onReset: () => { 屏幕 = ""; } });
    expect(r.proposals).toEqual([]);
    expect(r.text).toBe("要记这条交付，还差客户是哪一位——请告诉我全名。");
    expect(屏幕).toBe(r.text);
    expect(回答轮次[1]).toContain("没有生成任何卡片");
  });

  it("重答还说有卡片：换成实话，不把「卡片上确认」留在屏幕上", async () => {
    剧本 = ["调工具"];
    回答剧本 = ["你在卡片上确认一下。", "已生成建议卡，请确认。"];
    let 屏幕 = "";
    const { runAgent, 没出卡片 } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    const r = await runAgent({ question: "明天去李文龙那边交付", user, b }, { onToken: (t) => { 屏幕 += t; }, onReset: () => { 屏幕 = ""; } });
    expect(r.text).toBe(没出卡片);
    expect(屏幕).toBe(没出卡片);
  });

  it("没提卡片的回答不受影响", async () => {
    剧本 = ["调工具"];
    回答剧本 = ["查到 3 个渠道。"];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    await runAgent({ question: "有几个渠道", user, b }, { onToken: () => {}, onReset: () => {} });
    expect(回答轮次.length).toBe(1);
  });
});

/**
 * 回答这步吐了一个完整的工具调用（2026-09-28：决策几步都「没调工具」，回答时才想起要 find_person）。
 * 替它真跑，拿结果再答——不是叫它「别调了直接说」。
 */
describe("回答里吐了认得出来的工具调用", () => {
  it("回炉那步还是不调：退回标记里认出来的那个跑一次、拿结果再答；标记不上屏，过程条多一步", async () => {
    剧本 = ["调工具", "空手", "空手"];
    回答剧本 = [
      // 参数和决策那步不一样（那步是空参数）：一样的话会被「同工具同参数不跑第二次」拦下，那也是对的
      '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="list_channels">\n<｜｜DSML｜｜ parameter name="keyword" string="true">老带新</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
      "查到了，渠道都在上面。",
    ];
    let 屏幕 = "";
    const 步骤: string[] = [];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    const r = await runAgent(
      { question: "有哪些渠道", user, b },
      { onToken: (t) => { 屏幕 += t; }, onReset: () => { 屏幕 = ""; }, emit: (e) => { if (e.status === "done") 步骤.push(String(e.id)); } },
    );
    expect(步骤.filter((x) => x.startsWith("tool-late-")).length, "回答里那个调用要真跑").toBe(1);
    expect(回答轮次.length).toBe(2);
    expect(回答轮次[1]).toContain("你刚才想调的已经调过了");
    // 回炉那一步是带着工具定义问的，而且告诉了它刚才想调什么
    expect(决策轮次.at(-1)!.messages.at(-1)!.content).toContain("你刚才在回答里想调 list_channels");
    expect(r.text).toBe("查到了，渠道都在上面。");
    expect(屏幕).not.toMatch(/DSML/);
    expect(屏幕).toBe(r.text);
  });
});

describe("回炉那步正式调了", () => {
  it("用它正式调的那个（参数照工具定义），不用标记里猜的", async () => {
    // 第 1 步调工具、第 2 步空手去作答；作答吐标记（参数是猜的）；回炉那步正式调（空参数的 list_channels 已调过，换一套）
    剧本 = ["调工具", "空手", "一步两个"];
    回答剧本 = [
      '<｜DSML｜invoke name="list_channels"><｜DSML｜parameter name="猜的键" string="true">x</｜DSML｜parameter></｜DSML｜invoke>',
      "好了。",
    ];
    const 步骤: string[] = [];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    await runAgent({ question: "有哪些渠道", user, b }, { onToken: () => {}, onReset: () => {}, emit: (e) => { if (e.status === "done" && String(e.id).startsWith("tool-late-")) 步骤.push(String(e.label)); } });
    // 回炉给了两个：空参数那个刚才跑过（不重跑），老带新那个是新的——猜的键那个没跑
    expect(步骤.length).toBe(1);
    expect(步骤[0]).toContain("老带新");
  });
});

/** 一步里要了两个工具（「记一条跟进 + 排一次计划」常一起来）：两个都要跑，不能只认第一个 */
describe("一步里要了好几个", () => {
  it("第二个排进队列接着跑，不再问模型", async () => {
    剧本 = ["一步两个", "空手"];
    const 步骤: string[] = [];
    const { runAgent } = await import("@/lib/agent/run");
    process.env.AGENT_INTENTS = "0";
    await runAgent({ question: "记一条再排一个", user, b }, { onToken: () => {}, emit: (e) => { if (e.status === "done" && String(e.id).startsWith("tool-")) 步骤.push(String(e.label)); } });
    expect(步骤.length, "两个都得跑").toBe(2);
    expect(步骤[1]).toContain("老带新");
    // 第二个是从队列里取的，没为它再问一次模型：两次决策 = 第一步 + 队列跑完后那一步
    expect(决策轮次.length).toBe(2);
  });
});

/** 「下周三」照表算（2026-09-28：周一说下周三，它算成了本周三）；周一是一周的第一天 */
describe("日期对照", () => {
  it("周一：下周三是 7 天后的那个周三", () => {
    const t = 日期对照(dayjs("2026-09-28"));
    expect(t).toContain("本周 周一 09-28");
    expect(t).toContain("下周 周一 10-05、周二 10-06、周三 10-07");
  });
  it("周日还算这一周：本周从前一个周一算起", () => {
    expect(日期对照(dayjs("2026-10-04"))).toContain("本周 周一 09-28");
  });
});

describe("有卡时的回答要求", () => {
  it("没卡不加；有卡就说清「还没写进去」、只提卡上有的栏位", () => {
    expect(有卡时的要求(0)).toBe("");
    const t = 有卡时的要求(2);
    expect(t).toContain("2 张建议卡");
    expect(t).toContain("不许说「已经记上」");
    expect(t).toContain("只提卡片上本来就有的栏位");
  });
});
