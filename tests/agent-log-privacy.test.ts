/**
 * 问 AI 的那句话不进服务端日志（2026-10-20）。
 *
 * 原来意图直连没命中时记一行 `[intent] 没命中：<问句前 60 字>`。问句里是客户名字、电话、金额，
 * 团队版跑在云上，这一行就把客户的问句留在了云端日志里。现在只记「没命中」。
 *
 * 钉的是整条 runAgent：意图直连开着（默认），问一句认不出意图的话，走完模型循环和回答，
 * 期间 console 的任何一行都不许带上问句里的字。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async () => ({ final: true }),
  chatTextStream: async (_m: unknown, _o: unknown, onToken: (t: string) => void) => {
    onToken("好的");
    return "好的";
  },
  chatTools: async () => ({ text: "", toolCalls: [] }),
}));

const b = { customer: "客户", brief: "销售", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_INTENTS;
});

describe("问句不进日志", () => {
  it("意图没命中：日志只说没命中，不带问句", async () => {
    delete process.env.AGENT_INTENTS;
    const 记下的: string[] = [];
    for (const 级别 of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, 级别).mockImplementation((...args: unknown[]) => {
        记下的.push(args.map(String).join(" "));
      });
    }
    const 问句 = "帮我想想怎么跟王秀英谈 13812345678 那单 37 万的续约";
    const { runAgent } = await import("@/lib/agent/run");
    await runAgent({ question: 问句, user, b });

    expect(记下的.some((l) => l.includes("[intent] 没命中")), "没命中那一行还在（只是不带问句）").toBe(true);
    for (const 片段 of ["王秀英", "13812345678", "37 万", "续约"]) {
      expect(记下的.filter((l) => l.includes(片段)), `日志里出现了「${片段}」`).toEqual([]);
    }
  });
});
