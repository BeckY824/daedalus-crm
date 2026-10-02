/**
 * r2-ai · 二、扣次数：一个问题到底被扣了几次。
 *
 * 价格页的承诺是「一次提问算一次」。网关靠 X-Question-Id 认同一个问题（lib/tenant/credits.ts 按问题扣一次），
 * 这里在整条线上（桌面端 llm.ts → 网关 → 假上游）验各种多步、重试、失败、并发下这句话还成不成立。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线,
  回文本, 回工具, 回流, 问AI, 种类, 上游, 上游请求,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r2-ai-credits-${process.pid}`);
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
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  (await import("@/lib/llm")).重置模型探测();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "王同学", phone: "13800000001", salesOwnerId: "tester-id" } })).id;
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  vi.unstubAllGlobals();
  拆桌面端(目录);
});

const 查过几次工具 = (r: 上游请求) => (r.body.messages as { role: string }[]).filter((m) => m.role === "tool").length;

/** 决策步按顺序吐这些工具调用，吐完就不调了；最终回答一句话 */
const 多步剧本 = (工具们: { name: string; args: Record<string, unknown> }[]) => (r: 上游请求) => {
  const k = 种类(r);
  if (k === "决策") {
    const n = 查过几次工具(r);
    return n < 工具们.length ? 回工具([工具们[n]]) : 回工具([]);
  }
  if (k === "回答") return 回流(["王同学", "在跟进中。"]);
  return 回文本('{"final":true}');
};

describe("一个问题多步只扣一次", () => {
  it("查四次库再回答（5 次上游调用）：扣 1 次，全程一个编号", async () => {
    const 线 = 接线({
      上游: 多步剧本([
        { name: "search_customers", args: { query: "王" } },
        { name: "get_customer", args: { id: "这里会查不到也无妨" } },
        { name: "list_channels", args: {} },
        { name: "get_my_plans", args: {} },
      ]),
    });
    const { result } = await 问AI("王同学现在怎么样了，渠道和我的计划呢");
    expect(result?.ok).toBe(true);
    expect(线.上游.length).toBeGreaterThanOrEqual(5);
    expect(new Set(线.网关.map((g) => g.questionId)).size).toBe(1);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("只剩最后 1 次时问一个多步问题：能问完（后几步不再扣），不透支", async () => {
    const { 扣一次, 余额 } = await import("@/lib/tenant/credits");
    for (let i = 0; i < 200; i++) {
      if ((await 余额(账号.owner)).还剩 <= 1) break;
      await 扣一次(账号.owner);
    }
    expect((await 余额(账号.owner)).还剩).toBe(1);
    接线({ 上游: 多步剧本([{ name: "search_customers", args: { query: "王" } }, { name: "list_channels", args: {} }]) });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(true);
    expect((await 余额(账号.owner)).还剩).toBe(0);
  });

  it("原生那条路最坏的情形（6 步全调工具 + 回答里吐 DSML 回炉 + 两次重答）：仍在 12 次以内，只扣 1 次", async () => {
    let 回答第几次 = 0;
    const 线 = 接线({
      上游: (r) => {
        const k = 种类(r);
        if (k === "决策") return 回工具([{ name: "search_customers", args: { query: `王${查过几次工具(r)}` } }]);
        if (k === "回答") {
          回答第几次++;
          if (回答第几次 === 1) return 回流(['<｜DSML｜invoke name="list_channels"></｜DSML｜invoke>']);
          if (回答第几次 === 2) return 回流(["我来查一下"]);
          return 回流(["你在卡片上确认一下"]);
        }
        return 回文本('{"final":true}');
      },
    });
    const { result } = await 问AI("把所有姓王的都找出来");
    expect(result?.ok).toBe(true);
    expect(线.网关.length).toBeLessThanOrEqual(12);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("【坏】退回 JSON 协议那条路（中转站不认 tools）：一个问题 14 次调用，超过「每问最多步」被扣第 2 次", async () => {
    const 线 = 接线({
      上游: (r) => {
        const k = 种类(r);
        // 中转站不认 tools 参数
        if (k === "决策") return new Response(JSON.stringify({ error: { message: "tools is not supported" } }), { status: 400 });
        if (k === "回答") return 回流(["王同学在跟进中。"]);
        // JSON 协议：每一步先吐一句话（不是 JSON），被要求修一次才给出合法的那一步
        const 修过 = (r.body.messages as { content: string }[]).some((m) => String(m.content).includes("不是合法 JSON"));
        if (!修过) return 回文本("好的，我先查一下");
        const 第几步 = (r.body.messages as { role: string; content: string }[]).filter((m) => m.role === "user" && String(m.content).startsWith("工具 ")).length;
        return 回文本(JSON.stringify({ thought: "查", action: { tool: "search_customers", args: { query: `王${第几步}` } } }));
      },
    });
    const { result } = await 问AI("把所有姓王的都找出来");
    expect(result?.ok).toBe(true);
    expect(线.网关.length).toBeGreaterThan(12);
    expect(await 用掉(账号.acc.id), `一个问题打了 ${线.网关.length} 次网关`).toBe(1);
  });
});

describe("上游失败退不退", () => {
  it("第 1 步上游 502、降级重试成功：净扣 1 次（退一次、再扣一次）", async () => {
    const 线 = 接线({
      上游: (r) => (r.第几次 === 1 ? new Response("bad gateway", { status: 502 }) : 多步剧本([{ name: "search_customers", args: { query: "王" } }])(r)),
    });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(true);
    expect(线.上游[0].body.tools).toBeDefined();
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("【坏】第 2 步以后上游一直 502，整个问题失败：次数不退（只有第一步扣过的那次才退）", async () => {
    接线({
      上游: (r) => (r.第几次 === 1 ? 回工具([{ name: "search_customers", args: { query: "王" } }]) : new Response("bad gateway", { status: 502 })),
    });
    const { result } = await 问AI("王同学现在怎么样了");
    expect(result?.ok).toBe(false);
    expect(result && !result.ok ? result.error : "").toContain("暂时不可用");
    expect(await 用掉(账号.acc.id), "上游炸了、人什么都没拿到，网关注释自己说的「不让用户买单」").toBe(0);
  });

  it("chatJSON 四道重试（不认 response_format → 降级 → 坏 JSON → 修 → 降级）共用一个编号：扣 1 次", async () => {
    const 线 = 接线({
      上游: (r) => (r.body.response_format ? new Response('{"error":{"message":"response_format unsupported"}}', { status: 400 }) : 回文本("这不是 JSON")),
    });
    const r = await (await import("@/app/(app)/dashboard/ai")).draftWakeup({ customerId: 客户, reason: "沉睡" });
    expect(r.ok).toBe(false);
    expect(线.上游).toHaveLength(4);
    expect(new Set(线.网关.map((g) => g.questionId)).size).toBe(1);
    expect(await 用掉(账号.acc.id)).toBe(1);
  });

  it("【坏】网关自己的频率闸（30 次请求 / 5 分钟）在问题中途拦下：问题失败，第一步那次照扣", async () => {
    // 前面已经问过七八个问题（每个 3–5 次请求），这个窗口里还剩 2 次
    const { consumeAiQuota } = await import("@/lib/ai-quota");
    for (let i = 0; i < 28; i++) consumeAiQuota(`gw:${账号.acc.id}`);
    接线({ 上游: 多步剧本([{ name: "search_customers", args: { query: "王" } }, { name: "list_channels", args: {} }]) });
    const { result } = await 问AI("王同学现在怎么样了");
    expect.soft(result?.ok, `对话框里：${result && !result.ok ? result.error : ""}`).toBe(true);
    expect(await 用掉(账号.acc.id), "问题没答成").toBe(result?.ok ? 1 : 0);
  });
});

describe("并发", () => {
  it("同时问两个不同的问题：各扣 1 次，都答得出来", async () => {
    接线({ 上游: 多步剧本([{ name: "search_customers", args: { query: "王" } }]) });
    const [a, b] = await Promise.all([问AI("王同学现在怎么样了"), 问AI("王同学最近跟进了吗")]);
    expect(a.result?.ok).toBe(true);
    expect(b.result?.ok).toBe(true);
    expect(await 用掉(账号.acc.id)).toBe(2);
  });

  it("只剩 1 次时同时问两个：一个答、一个说用完；不透支", async () => {
    const { 扣一次, 余额 } = await import("@/lib/tenant/credits");
    for (let i = 0; i < 200; i++) {
      if ((await 余额(账号.owner)).还剩 <= 1) break;
      await 扣一次(账号.owner);
    }
    接线({ 上游: 多步剧本([{ name: "search_customers", args: { query: "王" } }]) });
    const 结果 = await Promise.all([问AI("王同学现在怎么样了"), 问AI("王同学最近跟进了吗")]);
    const 成 = 结果.filter((x) => x.result?.ok).length;
    expect(成).toBe(1);
    const 败 = 结果.find((x) => !x.result?.ok)!;
    expect(败.result && !败.result.ok ? 败.result.error : "").toContain("用完");
    expect((await 余额(账号.owner)).还剩).toBe(0);
  });

  it("同一个问题编号的两步同时到（目前没有客户端这么发）：记录一下会扣几次", async () => {
    const { 按问题扣一次 } = await import("@/lib/tenant/credits");
    await Promise.all([按问题扣一次(账号.owner, "q-并发"), 按问题扣一次(账号.owner, "q-并发")]);
    // credits.ts 的注释承认这种情况「多扣一次」。桌面端的每一步都是串行的，碰不上；这条只是钉住现状
    expect(await 用掉(账号.acc.id)).toBeLessThanOrEqual(2);
  });
});

void 上游;
