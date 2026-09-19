/**
 * 原地打转的兜底。
 *
 * 2026-09-19 报上来的（截图）：在线索页问「Steven是哪家公司的?」，过程条上
 *   search_customers() → 没给条件
 *   search_customers() → 没给条件
 *   search_customers() → 没给条件
 *   search_customers() → 没给条件
 * 四行一模一样，一条数据都没查着，最后中断。
 *
 * Steven 是那条线索的**联系人**，在 Lead 表里；`search_customers` 翻的是 Customer 表，
 * 给什么参数都查不到他。而工具原样把同一句「没给条件」退回去，模型读到的等于
 * 「再试一次」——提示词里那句「不要重复调用同一个工具」拦不住它。
 *
 * 所以第二次同样的调用不再执行，改成告诉它**下一步该干什么**：
 * 换参数、或者换一张表，并且把可用的工具列出来。空泛的禁止改不了它的选择。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** 每一轮决策模型要调什么。null = 空手（它认为够了） */
let 剧本: ({ name: string; args: string } | null)[] = [];
let 决策轮次: { role: string; content: string }[][] = [];

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async () => ({ final: true }),
  chatTextStream: async (_m: unknown, _o: unknown, onToken: (t: string) => void) => {
    onToken("好的");
    return "好的";
  },
  chatTools: async (messages: { role: string; content: unknown }[]) => {
    // 存副本：runAgent 一直往同一个数组里 push，存引用的话断言时看到的是后来的状态
    决策轮次.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
    const 这轮 = 剧本.shift() ?? null;
    if (!这轮) return { text: "", toolCalls: [] };
    return { text: "", toolCalls: [{ id: `c${决策轮次.length}`, function: { name: 这轮.name, arguments: 这轮.args } }] };
  },
}));

const b = { customer: "学员", brief: "招生", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };
/** 绕开意图直连，专测模型那条路 */
const 问 = async (q: string, 页面上下文?: string) => {
  process.env.AGENT_INTENTS = "0";
  const { runAgent } = await import("@/lib/agent/run");
  return runAgent({ question: q, user, b, 页面上下文 });
};

/** 这一轮里，模型最后收到的那条消息 */
const 末条 = (轮: number) => 决策轮次[轮]?.[决策轮次[轮].length - 1]?.content ?? "";

beforeEach(() => {
  剧本 = [];
  决策轮次 = [];
});

describe("同一个工具同一套参数连着调", () => {
  const 空搜 = { name: "search_customers", args: "{}" };

  it("第二次不再执行，改成告诉它换一张表", async () => {
    剧本 = [空搜, 空搜, null];
    const r = await 问("Steven是哪家公司的?");

    // 第一次照跑（拿到「没给条件」），第二次被拦下——所以只记了一步
    expect(r.steps).toBe(1);

    const 劝 = 末条(2);
    expect(劝).toContain("已经用完全相同的参数调过 search_customers");
    expect(劝).toContain("没给条件"); // 把上次的结果原样告诉它，别让它以为是新情况
    expect(劝).toContain("list_leads"); // 候选里必须有线索那张表
    expect(劝).toContain("不同的表");
  });

  it("拦下之后不占步数，剩下的步数还能换个工具查", async () => {
    剧本 = [空搜, 空搜, { name: "list_leads", args: '{"keyword":"Steven"}' }, null];
    const r = await 问("Steven是哪家公司的?");
    // search_customers 一步 + list_leads 一步；中间那次被拦的不算
    expect(r.steps).toBe(2);
  });

  it("参数不一样就照常跑，不是见到同名工具就拦", async () => {
    剧本 = [
      { name: "search_customers", args: '{"query":"Steven"}' },
      { name: "search_customers", args: '{"query":"张三"}' },
      null,
    ];
    const r = await 问("Steven 和张三分别是谁");
    expect(r.steps).toBe(2);
    expect(末条(2)).not.toContain("已经用完全相同的参数");
  });
});

describe("页面上下文进系统提示词", () => {
  it("线索页那句指路会原样带给模型", async () => {
    剧本 = [null];
    const { 认页面 } = await import("@/lib/ai-context-page");
    await 问("Steven是哪家公司的?", 认页面("/leads", null)!.提示);

    const 系统 = 决策轮次[0][0].content;
    expect(系统).toContain("list_leads");
    expect(系统).toContain("两张不同的表");
  });
});
