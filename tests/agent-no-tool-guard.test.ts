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

let 决策轮次: { messages: { role: string; content: string }[] }[] = [];
/** 每一轮决策要不要调工具，由用例摆好 */
let 剧本: ("空手" | "调工具")[] = [];
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
