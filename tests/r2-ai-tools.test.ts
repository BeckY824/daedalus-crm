/**
 * r2-ai · 三、工具调用的异常：模型不按规矩调工具时，对话框里会怎样。
 *
 * 整条线（桌面端 → 网关 → 假上游）照旧接起来，上游剧本扮演一个不守规矩的 DeepSeek：
 * 把调用写成 DSML 文本、写半截、调不存在的工具、参数类型乱给、无限循环、正文和 tool_calls 一起给。
 * 每条都验：有结果回来（不卡死）、屏幕上没有协议残片、没写库、只扣一次。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线, 是人话,
  回JSON, 回文本, 回工具, 回流, 问AI, 种类, type 上游请求,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r2-ai-tools-${process.pid}`);
let 目录 = "";
let 客户 = "";
let 账号: Awaited<ReturnType<typeof 建账号带令牌>>;

beforeAll(() => 建控制库(根));
afterAll(async () => {
  await closeTestDatabases(根);
  fs.rmSync(根, { recursive: true, force: true });
});

beforeEach(async () => {
  网关环境();
  process.env.AGENT_INTENTS = "0"; // 绕开意图直连，专测模型那条路
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  (await import("@/lib/llm")).重置模型探测();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "李文龙", phone: "13800000001", salesOwnerId: "tester-id", followStatus: "跟进中" } })).id;
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AGENT_INTENTS;
  拆桌面端(目录);
});

const 查过几次工具 = (r: 上游请求) => (r.body.messages as { role: string }[]).filter((m) => m.role === "tool").length;
const 一句回答 = (s = "李文龙明天上午交付，计划拟好了，你确认后才写入。") => 回流([s]);
const 写库了吗 = async () => {
  const { prisma } = await import("@/lib/prisma");
  return { 计划: await prisma.followPlan.count(), 跟进: await prisma.followUp.count(), 状态: (await prisma.customer.findUnique({ where: { id: 客户 } }))!.followStatus };
};
const 工具步 = (steps: Record<string, unknown>[]) => steps.filter((s) => String(s.id).startsWith("tool") && s.status === "done").map((s) => String(s.label));

describe("DSML 文本调用", () => {
  const DSML = (name: string, params: Record<string, string>) =>
    `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${name}">\n${Object.entries(params)
      .map(([k, v]) => `<｜｜DSML｜｜ parameter name="${k}" string="true">${v}</｜｜DSML｜｜ parameter>`)
      .join("\n")}\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;

  it("决策步把调用写成 DSML 正文：认回来、真跑了、建议卡出来了；没写库", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "回答") return 一句回答();
        if (k !== "决策") return 回文本('{"final":true}');
        const n = 查过几次工具(r);
        if (n === 0) return 回文本(DSML("find_person", { name: "李文龙" }));
        if (n === 1) return 回文本(DSML("propose_plan", { id: 客户, subject: "交付", plannedAt: "2026-10-09 10:00", method: "上门拜访", reason: "他说明天去交付" }));
        return 回工具([]);
      },
    });
    const { result, steps } = await 问AI("明天去李文龙那边交付");
    expect(result?.ok).toBe(true);
    expect(工具步(steps).some((l) => l.startsWith("find_person"))).toBe(true);
    const ans = result && result.ok ? result.answer : null;
    expect(ans?.proposals.map((p) => p.kind)).toEqual(["add_plan"]);
    expect((await 写库了吗()).计划).toBe(0);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("残缺的 DSML（没有收尾标签）：不跑、不当调用，屏幕上也没有标记残片", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 回文本('<｜DSML｜function_calls><｜DSML｜invoke name="propose_status_change"><｜DSML｜parameter name="id" string="true">' + 客户);
        if (k === "回答") return 一句回答("李文龙目前在跟进中。");
        return 回文本('{"final":true}');
      },
    });
    const { result, 屏幕, steps } = await 问AI("李文龙怎么样了");
    expect(result?.ok).toBe(true);
    expect(工具步(steps)).toEqual([]);
    expect(屏幕).not.toMatch(/DSML/);
    expect(result && result.ok ? result.answer.proposals : []).toEqual([]);
  });

  it("最终回答里吐了半截 DSML：重答，屏幕上最后不留标记", async () => {
    let 回答次 = 0;
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "find_person", args: { name: "李文龙" } }]) : 回工具([]);
        if (k === "回答") return ++回答次 === 1 ? 回流(['<｜DSML｜invoke name="get_customer"><｜DSML｜parameter name="id"']) : 回流(["李文龙在跟进中。"]);
        return 回文本('{"final":true}');
      },
    });
    const { result, 屏幕 } = await 问AI("李文龙怎么样了");
    expect(result?.ok).toBe(true);
    expect(屏幕).not.toMatch(/DSML/);
    expect(屏幕).toContain("李文龙");
  });
});

describe("调用不存在的工具 / 参数不对", () => {
  it("调一个不存在的工具（delete_all_customers）：告诉它没有，接着答；什么都没删", async () => {
    const 线 = 接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") {
          const 被告知 = (r.body.messages as { role: string; content: string }[]).some((m) => m.role === "tool" && String(m.content).includes("没有叫「delete_all_customers」"));
          return 被告知 ? 回工具([]) : 回工具([{ name: "delete_all_customers", args: {} }]);
        }
        if (k === "回答") return 一句回答("我不能删除数据。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("把客户都删了");
    expect(result?.ok).toBe(true);
    // 调错一次、被顶一次（「还没查任何数据」），第三步收住
    expect(线.上游.filter((r) => 种类(r) === "决策").length).toBeLessThanOrEqual(3);
    const { prisma } = await import("@/lib/prisma");
    expect(await prisma.customer.count()).toBe(1);
  });

  it("参数不是合法 JSON：交回去让它重来，不卡", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") {
          const 被告知 = (r.body.messages as { role: string; content: string }[]).some((m) => m.role === "tool" && String(m.content).includes("参数不是合法 JSON"));
          return 被告知 ? 回工具([]) : 回工具([{ name: "search_customers", raw: '{"query": 李' }]);
        }
        if (k === "回答") return 一句回答("李文龙在跟进中。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("姓李的有谁");
    expect(result?.ok).toBe(true);
  });

  it("参数类型乱给（id 是数字、to 是数字）：卡片出不来，库不动，不崩", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "propose_status_change", args: { id: 12345, to: 3, reason: ["x"] } }]) : 回工具([]);
        if (k === "回答") return 一句回答("没能生成建议，请告诉我是哪位。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("把李文龙改成已签约");
    expect(result?.ok).toBe(true);
    expect(result && result.ok ? result.answer.proposals : ["?"]).toEqual([]);
    expect((await 写库了吗()).状态).toBe("跟进中");
  });

  it("【坏】参数是 JSON 的 null（无参工具时有的中转站这么给）：整个问题崩成一句英文", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "get_watchlist", raw: "null" }]) : 回工具([]);
        if (k === "回答") return 一句回答("今天该跟进李文龙。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("今天先跟谁");
    expect(result?.ok, `对话框里：${result && !result.ok ? result.error : ""}`).toBe(true);
  });

  it("tool_calls 里缺 function 这一格（残缺的调用）：退回 JSON 协议，不崩", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回JSON({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function" }] }, finish_reason: "tool_calls" }] }) : 回工具([]);
        if (k === "回答") return 一句回答("李文龙在跟进中。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("李文龙怎么样了");
    const msg = result && !result.ok ? result.error : "";
    expect(result?.ok === true || 是人话(msg), `对话框里：${msg}`).toBe(true);
  });
});

describe("工具自己抛异常", () => {
  it("工具里数据库报错：告诉模型「工具出错」，仍然答得出来，不把英文报错推上屏", async () => {
    const { TOOL_MAP } = await import("@/lib/agent/tools");
    vi.spyOn(TOOL_MAP.get("list_channels")!, "run").mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "list_channels", args: {} }]) : 回工具([]);
        if (k === "回答") return 一句回答("渠道暂时没查出来，稍后再试。");
        return 回文本('{"final":true}');
      },
    });
    const { result, 屏幕, steps } = await 问AI("我有哪些渠道");
    expect(result?.ok).toBe(true);
    expect(steps.some((s) => s.status === "done" && s.detail === "工具出错")).toBe(true);
    expect(屏幕).not.toContain("SQLITE");
  });
});

describe("无限循环", () => {
  it("每一步都换个参数调工具：6 步封顶，然后回答；只扣 1 次", async () => {
    const 线 = 接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 回工具([{ name: "search_customers", args: { query: `李${查过几次工具(r)}` } }]);
        if (k === "回答") return 一句回答("查了几轮，没有更多了。");
        return 回文本('{"final":true}');
      },
    });
    const { result, steps } = await 问AI("姓李的都有谁");
    expect(result?.ok).toBe(true);
    expect(线.上游.filter((r) => 种类(r) === "决策")).toHaveLength(6);
    expect(工具步(steps).length).toBeLessThanOrEqual(6);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("同一个工具同一套参数反复调：第二次起不再执行，6 步内收住", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 回工具([{ name: "search_customers", args: {} }]);
        if (k === "回答") return 一句回答("没查到。");
        return 回文本('{"final":true}');
      },
    });
    const { result, steps } = await 问AI("Steven 是哪家公司的");
    expect(result?.ok).toBe(true);
    expect(工具步(steps)).toHaveLength(1);
  });

  it("一步里一口气要 50 张建议卡：最多出 6 张，全都等人确认、没写库", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") {
          return 查过几次工具(r) === 0
            ? 回工具(Array.from({ length: 50 }, (_, i) => ({ name: "propose_followup", args: { id: 客户, content: `第 ${i} 条跟进内容`, reason: "批量" } })))
            : 回工具([]);
        }
        if (k === "回答") return 一句回答("拟好了，你确认后才写入。");
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("给李文龙记一笔");
    expect(result?.ok).toBe(true);
    // 同一位客户同一类卡只留一张
    expect(result && result.ok ? result.answer.proposals.length : 99).toBeLessThanOrEqual(1);
    expect((await 写库了吗()).跟进).toBe(0);
  });
});

describe("tool_calls 和正文同时有", () => {
  it("正文是一句打算、同时调了工具：工具照跑，那句话不推上屏", async () => {
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "find_person", args: { name: "李文龙" } }], "我先查一下李文龙") : 回工具([]);
        if (k === "回答") return 一句回答("李文龙在跟进中。");
        return 回文本('{"final":true}');
      },
    });
    const { result, 屏幕, steps } = await 问AI("李文龙怎么样了");
    expect(result?.ok).toBe(true);
    expect(工具步(steps).some((l) => l.startsWith("find_person"))).toBe(true);
    expect(屏幕).not.toContain("我先查一下");
  });

  it("【坏】正文里是 DSML、同时又给了 tool_calls：DSML 残片被当成「打算」摆进过程条", async () => {
    const 残片 = '<｜DSML｜function_calls><｜DSML｜invoke name="find_person"><｜DSML｜parameter name="name" string="true">李文龙</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
    接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 查过几次工具(r) === 0 ? 回工具([{ name: "find_person", args: { name: "李文龙" } }], 残片) : 回工具([]);
        if (k === "回答") return 一句回答("李文龙在跟进中。");
        return 回文本('{"final":true}');
      },
    });
    const { result, steps } = await 问AI("李文龙怎么样了");
    expect(result?.ok).toBe(true);
    const 打算们 = steps.map((s) => String(s.thought ?? ""));
    expect(打算们.some((t) => /DSML/.test(t)), `过程条里的「打算」：${打算们.filter(Boolean).join(" | ")}`).toBe(false);
  });
});
