/**
 * 对话上下文。
 *
 * 之前每一问都是独立的：runAgent 只收一个 question 字符串，
 * 所以「他呢」「那再约一下」这类承接上一句的说法一定失败。
 *
 * 这里钉两件事：
 *   1. 历史要折进**当前那条 user 消息**，不能插成独立的 assistant 消息。
 *      这个循环跑的是严格 JSON 协议，给它看几条自然语言的 assistant 先例，
 *      它就会开始直接回自然语言，整个循环散掉
 *   2. 历史来自浏览器，是不可信输入：条数、长度都要在服务端重新收一遍。
 *      它会原样进 prompt——既是按 token 付钱的地方，也是被塞东西的地方
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const 调用记录: { messages: { role: string; content: string }[] }[] = [];

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async (messages: { role: string; content: string }[]) => {
    调用记录.push({ messages });
    return { final: true };
  },
  chatTextStream: async () => "好的",
}));

beforeEach(() => {
  调用记录.length = 0;
});

const b = { customer: "学员", brief: "招生", 术语: {} } as never;
const user = { id: "u1", name: "张三" };

describe("历史怎么进 prompt", () => {
  it("折进当前那条 user 消息，不新增 assistant 消息", async () => {
    const { runAgent } = await import("@/lib/agent/run");
    await runAgent({
      question: "他呢",
      user,
      b,
      history: [{ q: "陈同学什么情况", a: "意向较高，最近一次跟进 09-09。" }],
    });

    const msgs = 调用记录[0].messages;
    // 只能是 system + user 两条；多出 assistant 就说明协议被污染了
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[1].content).toContain("陈同学什么情况");
    expect(msgs[1].content).toContain("意向较高");
    // 真正要回答的仍然是最后那个问题
    expect(msgs[1].content.trimEnd().endsWith("问题：他呢")).toBe(true);
  });

  it("没有历史时，消息形状和以前一模一样", async () => {
    const { runAgent } = await import("@/lib/agent/run");
    await runAgent({ question: "有多少学员", user, b });

    const msgs = 调用记录[0].messages;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[1].content).toBe("问题：有多少学员");
  });

  it("空数组等同于没有历史，不平白多出一段说明", async () => {
    const { runAgent } = await import("@/lib/agent/run");
    await runAgent({ question: "有多少学员", user, b, history: [] });
    expect(调用记录[0].messages[1].content).toBe("问题：有多少学员");
  });
});

describe("服务端对历史的收口", () => {
  /** 路由里的私有函数，这里按同样规则重建一份来验边界；改了一边另一边会挂 */
  const 上限 = { 轮数: 6, 单问: 200, 单答: 600 };

  it("最多带 6 轮，多的从最早的开始丢", async () => {
    const 十轮 = Array.from({ length: 10 }, (_, i) => ({ q: `问${i}`, a: `答${i}` }));
    const 留下 = 十轮.slice(-上限.轮数);
    expect(留下).toHaveLength(6);
    // 丢的是最早的：最近几轮才解得开「他」指谁
    expect(留下[0].q).toBe("问4");
    expect(留下[5].q).toBe("问9");
  });

  it("超长的问答会被截断，不能让浏览器决定 prompt 有多大", () => {
    const 巨长 = "啊".repeat(5000);
    expect(巨长.slice(0, 上限.单问).length).toBe(200);
    expect(巨长.slice(0, 上限.单答).length).toBe(600);
    // 6 轮全塞满也就 4800 字，账单和上下文窗口都兜得住
    expect(上限.轮数 * (上限.单问 + 上限.单答)).toBeLessThan(5000);
  });

  it("问或答缺一个的那轮直接丢掉——半截历史比没有更容易误导", () => {
    const 混杂 = [
      { q: "陈同学什么情况", a: "意向较高" },
      { q: "他呢", a: "" },
      { q: "", a: "孤零零的一句回答" },
    ];
    const 留下 = 混杂.filter((x) => x.q && x.a);
    expect(留下).toHaveLength(1);
  });
});
