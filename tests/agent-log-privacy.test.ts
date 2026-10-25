/**
 * 客户的话不进服务端日志。
 *
 * 2026-10-20：意图直连没命中时记一行 `[intent] 没命中：<问句前 60 字>`。问句里是客户名字、电话、金额，
 * 团队版跑在云上，这一行就把客户的问句留在了云端日志里。现在只记「没命中」。
 *
 * 2026-10-22：同一类还有七处——JSON 协议那条路把模型决策（参数、thought）原样记 120 字，
 * 原地打转记「工具:参数」，五道回答闸把回答原文记 80 字。参数和回答里是查出来的客户名字、电话、金额。
 * 现在决策只记选了哪个工具，打转只记工具名，回答闸只记字数。
 *
 * 钉的是整条 runAgent：问句、模型给的参数、模型的回答都塞进客户信息，走完一问，
 * console 的任何一行都不许带上这些字。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/** 原生 function calling 每一步怎么回；"不支持" = 对面不吃 tools，退回 JSON 协议 */
let 原生剧本: ("不支持" | "空手")[] = [];
/** JSON 协议每一步回什么 */
let JSON剧本: Record<string, unknown>[] = [];
/** 每一轮最终回答吐什么 */
let 回答剧本: string[] = [];

vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "系统提示",
  chatMessagesJSON: async () => JSON剧本.shift() ?? { final: true },
  chatTextStream: async (_m: unknown, _o: unknown, onToken: (t: string) => void) => {
    const 答 = 回答剧本.shift() ?? "好的";
    onToken(答);
    return 答;
  },
  chatTools: async () => {
    if ((原生剧本.shift() ?? "空手") === "不支持") throw Object.assign(new Error("tools not supported"), { status: 400 });
    return { text: "", toolCalls: [] };
  },
}));

const b = { customer: "客户", brief: "销售", statusLabels: {}, 术语: {} } as never;
const user = { id: "u1", name: "张三" };
const 客户信息 = ["王秀英", "13812345678", "37 万", "续约"];

let 记下的: string[] = [];

beforeEach(() => {
  原生剧本 = [];
  JSON剧本 = [];
  回答剧本 = [];
  记下的 = [];
  for (const 级别 of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, 级别).mockImplementation((...args: unknown[]) => {
      记下的.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_INTENTS;
});

const 问 = async (问句: string) => {
  const { runAgent } = await import("@/lib/agent/run");
  return runAgent({ question: 问句, user, b });
};

const 日志里没有客户信息 = () => {
  for (const 片段 of 客户信息) {
    expect(记下的.filter((l) => l.includes(片段)), `日志里出现了「${片段}」`).toEqual([]);
  }
};

describe("客户的话不进日志", () => {
  it("意图没命中：日志只说没命中，不带问句", async () => {
    await 问("帮我想想怎么跟王秀英谈 13812345678 那单 37 万的续约");

    expect(记下的.some((l) => l.includes("[intent] 没命中")), "没命中那一行还在（只是不带问句）").toBe(true);
    日志里没有客户信息();
  });

  it("JSON 协议：决策只记选了哪个工具，原地打转只记工具名", async () => {
    process.env.AGENT_INTENTS = "0";
    原生剧本 = ["不支持"];
    const 决策 = { thought: "查王秀英 13812345678 那单 37 万的续约", action: { tool: "search_customers", args: { keyword: "王秀英 13812345678" } } };
    JSON剧本 = [决策, 决策, { final: true }];
    回答剧本 = ["查到了，跟进记录在下面。"];
    await 问("王秀英那单怎么样了");

    expect(记下的.some((l) => /第 1 步决策 \d+ms：search_customers$/.test(l)), "决策那一行还在，记着选的工具").toBe(true);
    expect(记下的.some((l) => l.endsWith("原地打转，拦下第二次 search_customers")), "打转那一行还在，记着工具名").toBe(true);
    日志里没有客户信息();
  });

  it("回答闸：不是答案、重答还不是答案，只记字数", async () => {
    process.env.AGENT_INTENTS = "0";
    原生剧本 = ["空手", "空手"];
    const 吐标记 = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="search_customers">王秀英 13812345678 37 万 续约';
    回答剧本 = [吐标记, 吐标记];
    await 问("王秀英那单怎么样了");

    expect(记下的.some((l) => l.includes("吐的不是答案，重答一次（")), "不是答案那一行还在").toBe(true);
    expect(记下的.some((l) => l.includes("重答还是不是答案，不上屏（")), "重答那一行还在").toBe(true);
    日志里没有客户信息();
  });

  it("回答闸：零工具断言数据、说有卡片却没卡，只记字数", async () => {
    process.env.AGENT_INTENTS = "0";
    原生剧本 = ["空手", "空手"];
    回答剧本 = ["王秀英 13812345678 那单 37 万的续约目前没有任何记录。", "王秀英 13812345678 那单 37 万的续约，你在卡片上确认一下。"];
    await 问("王秀英那单怎么样了");

    expect(记下的.some((l) => l.includes("零工具却断言了数据，重答一次（")), "零工具断言那一行还在").toBe(true);
    expect(记下的.some((l) => l.includes("说有卡片但这一轮没生成卡片，重答一次（")), "说有卡片那一行还在").toBe(true);
    日志里没有客户信息();
  });

  /*
    「有卡没确认却说已改好」那一道要真出一张卡，得连库，上面没跑到；
    这里按源码钉住：日志里不许再拼回答原文、工具参数、模型原始输出
  */
  it("run.ts 的日志不拼回答原文、工具参数、模型原始输出", () => {
    const 源码 = readFileSync("src/lib/agent/run.ts", "utf8");
    const 日志行 = 源码.split("\n").filter((l) => /console\.(log|info|warn|error|debug)\(/.test(l));
    expect(日志行.length).toBeGreaterThan(5);
    for (const 行 of 日志行) {
      expect(行, "日志拼了回答原文").not.toMatch(/\$\{text\.slice/);
      expect(行, "日志拼了「工具:参数」").not.toMatch(/\$\{签名/);
      expect(行, "日志拼了模型原始输出").not.toMatch(/JSON\.stringify\(raw\)|JSON\.stringify\(args\)|\$\{thought/);
      expect(行, "日志拼了问句").not.toMatch(/\$\{(question|q|问句)\b/);
    }
  });
});
