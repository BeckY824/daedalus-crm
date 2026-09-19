/**
 * 「找一个人」走通整条路：客户表搜空 → 工具自己把别的表查了 → 模型手上就有答案。
 *
 * 2026-09-19 首页那一问：「明杰哥的电话是多少」。明杰哥是一个**渠道**，客户库里当然没有，
 * 于是连问两次都是「没找到，你给个更完整的姓名我再查一次」——而人要的号码就在渠道表里。
 *
 * 页面上下文（0.41.0 那版）只在渠道页上盖住了这个洞，**首页没有页面上下文**，
 * 而首页正是这个 agent 的主场。所以这一组钉的是工具层那条路：
 * 不带任何页面上下文，模型只调一次 search_customers，回来的那条消息里就该有电话。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

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
    决策轮次.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
    const 这轮 = 剧本.shift() ?? null;
    if (!这轮) return { text: "", toolCalls: [] };
    return { text: "", toolCalls: [{ id: `c${决策轮次.length}`, function: { name: 这轮.name, arguments: 这轮.args } }] };
  },
}));

const b = { customer: "学员", brief: "招生", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };

/** 不带页面上下文——这就是首页 */
const 在首页问 = async (q: string) => {
  process.env.AGENT_INTENTS = "0";
  const { runAgent } = await import("@/lib/agent/run");
  return runAgent({ question: q, user, b });
};

/** 某一轮里模型收到的最后一条消息（上一次工具回的东西） */
const 末条 = (轮: number) => 决策轮次[轮]?.[决策轮次[轮].length - 1]?.content ?? "";

beforeEach(async () => {
  剧本 = [];
  决策轮次 = [];
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("首页问一个不在客户表里的人", () => {
  beforeEach(async () => {
    const u = await prisma.user.create({ data: { email: "o", name: "becky", title: "销售", role: "SALES", password: "x" } });
    await prisma.channel.create({ data: { name: "明杰哥", phone: "18672698117", remark: "外贸方面的资源", channelOwnerId: u.id } });
  });

  it("只调一次 search_customers，回来那条消息里就带着电话", async () => {
    剧本 = [{ name: "search_customers", args: '{"query":"明杰哥"}' }, null];
    await 在首页问("明杰哥的电话是多少?");

    // 第二轮开头那条 tool 消息 = 第一次 search_customers 的结果
    const 工具回的 = 末条(1);
    expect(工具回的).toContain("渠道");
    expect(工具回的).toContain("18672698117");
    // 并且明说别再反过来问用户
    expect(工具回的).toContain("不要反过来让用户");
    // 一次就够：不需要模型再去调 list_channels
    expect(决策轮次).toHaveLength(2);
  });

  it("get_customer 按姓名查不到时也一样，不只会说「查无此人」", async () => {
    剧本 = [{ name: "get_customer", args: '{"name":"明杰哥"}' }, null];
    await 在首页问("明杰哥的电话是多少?");
    const 工具回的 = 末条(1);
    expect(工具回的).toContain("18672698117");
    expect(工具回的).not.toContain("查无此人");
  });

  it("客户表里真有人时，一条多余的查询都不做", async () => {
    const u = await prisma.user.findFirstOrThrow();
    await prisma.customer.create({ data: { name: "明杰哥", phone: "13800000001", salesOwnerId: u.id } });
    剧本 = [{ name: "search_customers", args: '{"query":"明杰哥"}' }, null];
    await 在首页问("明杰哥的电话是多少?");
    const 工具回的 = 末条(1);
    expect(工具回的).toContain("13800000001");
    // 有结果的那条路不该冒出「别的表」那一段
    expect(工具回的).not.toContain("这个名字在别的表里");
  });

  it("谁都没命中时照旧如实说没有，不硬凑一段", async () => {
    剧本 = [{ name: "search_customers", args: '{"query":"查无此名"}' }, null];
    await 在首页问("查无此名的电话是多少?");
    const 工具回的 = 末条(1);
    expect(工具回的).toContain("没有匹配");
    expect(工具回的).not.toContain("这个名字在别的表里");
    expect(工具回的).not.toContain("该怎么办");
  });
});
