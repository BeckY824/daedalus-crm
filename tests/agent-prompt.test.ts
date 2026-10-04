/**
 * agent 发给模型的那几段话、以及意图直连那条近路（回归核对 J-134 / J-142 / J-147 / J-148 / J-149）。
 *
 * 这几件当初都修在 run.ts 里，但只是提示词或一个 break，没有任何断言——
 * 谁顺手删掉一行，模型照样会答，只是答得又慢又歪，测试一条都不红。
 *
 *   J-134 / J-142：最终回答那一步要「第一句就是答案」「一条记录不画表」
 *   J-147：原生 function calling 那条路，系统提示词里不许再留 JSON 协议（两套说明书一起给，它只听一套，8 道错 7 道）
 *   J-148：直连跑完工具就去组织回答，不再白问一次「要不要调工具」
 *   J-149：页面上下文进系统提示词，不进认意图的那句话——否则上下文里带「渠道」二字，问什么都被渠道清单接走
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

type 消息 = { role: string; content: string };
/** 每一次「挑工具」的决策轮，模型收到的消息 */
let 决策轮次: 消息[][] = [];
/** 每一次组织回答，模型收到的消息 */
let 回答轮次: 消息[][] = [];
/** JSON 协议那条路（不该走到）收到的消息 */
let JSON轮次: 消息[][] = [];

const 抄 = (ms: { role: string; content: unknown }[]) => ms.map((m) => ({ role: m.role, content: String(m.content ?? "") }));

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async (ms: { role: string; content: unknown }[]) => {
    JSON轮次.push(抄(ms));
    return { final: true };
  },
  chatTextStream: async (ms: { role: string; content: unknown }[], _o: unknown, onToken: (t: string) => void) => {
    回答轮次.push(抄(ms));
    onToken("好的");
    return "好的";
  },
  // 决策步：一律空手（它认为够了）
  chatTools: async (ms: { role: string; content: unknown }[]) => {
    决策轮次.push(抄(ms));
    return { text: "", toolCalls: [] };
  },
}));

const b = { customer: "学员", brief: "招生", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };

async function 问(q: string, 选项: { 直连?: boolean; 页面上下文?: string } = {}) {
  if (选项.直连) delete process.env.AGENT_INTENTS;
  else process.env.AGENT_INTENTS = "0";
  const { runAgent } = await import("@/lib/agent/run");
  return runAgent({ question: q, user, b, 页面上下文: 选项.页面上下文 });
}

beforeEach(async () => {
  await resetDb();
  决策轮次 = [];
  回答轮次 = [];
  JSON轮次 = [];
  delete process.env.AGENT_TOOLCALLS;
});

afterAll(async () => {
  delete process.env.AGENT_INTENTS;
  await prisma.$disconnect();
});

describe("最终回答那一步的要求（J-134 / J-142）", () => {
  it("提示词里写着「第一句就是答案」和「一条记录不画表」", async () => {
    await 问("明杰哥的电话是多少");
    expect(回答轮次.length).toBeGreaterThanOrEqual(1);
    const 末 = 回答轮次[0][回答轮次[0].length - 1].content;
    expect(末).toContain("第一句就是答案");
    expect(末).toContain("一条记录不画表");
    // 不兜售：DeepSeek 爱在末尾加一句「想让我帮你……说一声就行」
    expect(末).toContain("不要主动揽活");
  });
});

describe("原生 function calling 那条路的系统提示词（J-147）", () => {
  it("不留 JSON 协议那段：没有 {\"tool\": / {\"final\": true}，也没有手抄的工具清单", async () => {
    await 问("明杰哥的电话是多少");
    expect(决策轮次.length).toBeGreaterThanOrEqual(1);
    expect(JSON轮次).toEqual([]);
    const 系统 = 决策轮次[0][0].content;
    expect(决策轮次[0][0].role).toBe("system");
    expect(系统).not.toContain('{"final": true}');
    expect(系统).not.toContain('"tool"');
    expect(系统).not.toContain("每一轮只输出严格 JSON");
    expect(系统).not.toContain("你能调用的工具：");
    expect(系统).toContain("需要数据就直接调用工具");
  });

  it("对照：关掉原生（AGENT_TOOLCALLS=0）才走 JSON 协议，那时说明书才在", async () => {
    process.env.AGENT_TOOLCALLS = "0";
    try {
      await 问("明杰哥的电话是多少");
    } finally {
      delete process.env.AGENT_TOOLCALLS;
    }
    expect(决策轮次).toEqual([]);
    expect(JSON轮次.length).toBeGreaterThanOrEqual(1);
    expect(JSON轮次[0][0].content).toContain("每一轮只输出严格 JSON");
  });
});

describe("意图直连（J-148 / J-149）", () => {
  it("「我现在有什么渠道」：直连跑完 list_channels 就去组织回答，挑工具的决策轮一次都不问", async () => {
    const 我 = await prisma.user.create({ data: { email: "zs", name: "张三", title: "销售", role: "SALES", password: "x" } });
    await prisma.channel.create({ data: { name: "小红书", channelOwnerId: 我.id } });
    const r = await 问("我现在有什么渠道", { 直连: true });
    expect(决策轮次).toEqual([]);
    expect(JSON轮次).toEqual([]);
    expect(回答轮次).toHaveLength(1);
    expect(r.steps).toBe(1);
    // 查到的东西要交给组织回答那一步
    expect(回答轮次[0].map((m) => m.content).join("\n")).toContain("小红书");
  });

  it("页面上下文里带着「有什么渠道」，问一句不相干的「张三怎么样了」不被渠道清单接走", async () => {
    const { 认页面 } = await import("@/lib/ai-context-page");
    // 渠道页上搜了「有什么渠道」——上下文里就带着那几个字
    const 上下文 = 认页面("/channels", new URLSearchParams("q=有什么渠道"), null)!.提示;
    expect(上下文).toContain("有什么渠道");
    const r = await 问("张三怎么样了", { 直连: true, 页面上下文: 上下文 });
    // 没被直连接走：第一步照常问了模型，而且一个渠道清单都没查
    expect(决策轮次.length).toBeGreaterThanOrEqual(1);
    expect(r.steps).toBe(0);
    // 上下文照样带给了模型——在系统提示词里，不在问题里
    expect(决策轮次[0][0].content).toContain("有什么渠道");
    expect(决策轮次[0][1].content.trimEnd().endsWith("张三怎么样了")).toBe(true);
  });
});
