/**
 * r4 兼容 · 二、**新桌面端 0.46.15（本分支）× 旧网关 0.46.13**——桌面端先发、托管版后部署的那段时间；
 * 顺带对照 0.46.15 × 新网关（两边都上线之后的终态）。
 *
 * 客户端就是本分支的 src（不 mock），网关二选一（见 tests/r4-compat-harness.ts）。
 * 重点：旧网关丢工具表时新 agent 怎么退；快速重发 / 5xx 重发在旧网关上多不多扣；旧网关的报错在新客户端上显示成什么。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 是人话,
  回JSON, 回文本, 回工具, 回流, 问AI, type 上游请求,
  接线到, 等后台, 时间缩放, type 网关版本,
} from "./r4-compat-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r4-compat-new-${process.pid}`);
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
  process.env.AGENT_INTENTS = "0";
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  (await import("@/lib/llm")).重置模型探测();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "李文龙", phone: "13800000001", salesOwnerId: "tester-id", followStatus: "跟进中" } })).id;
  await prisma.followUp.create({ data: { customerId: 客户, ownerId: "tester-id", type: "PHONE", title: "电话", content: "聊了报价，下周再约" } });
  账号 = await 建账号带令牌();
  目录 = 装桌面端(标准凭据(账号.token));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AGENT_INTENTS;
  拆桌面端(目录);
});

const 工具结果数 = (r: 上游请求) => (r.body.messages as { role: string }[]).filter((m) => m.role === "tool").length;
const 工具步 = (steps: Record<string, unknown>[]) => steps.filter((s) => String(s.id).startsWith("tool") && s.status === "done").map((s) => String(s.label));
const 给人看 = (r: Awaited<ReturnType<typeof 问AI>>) => (r.result ? (r.result.ok ? r.屏幕 : r.result.error) : "（没有结果）");

/** 和 r4-compat-old-client 同一个「DeepSeek」：有工具表就调工具，没有就空口说 */
function 模型(r: 上游请求): Response {
  if (r.body.stream) {
    const 查到了 = JSON.stringify(r.body.messages).includes("聊了报价");
    return 回流([查到了 ? "李文龙上次聊了报价，" : "我这边没查到李文龙的记录，", "下周再约他一次。"]);
  }
  if (Array.isArray(r.body.tools) && r.body.tools.length) {
    const n = 工具结果数(r);
    if (n === 0) return 回工具([{ name: "find_person", args: { name: "李文龙" } }]);
    if (n === 1) return 回工具([{ name: "get_customer", args: { id: 客户 } }]);
    return 回工具([], "够了");
  }
  if (r.body.response_format) return 回文本('{"final":true}');
  return 回文本("李文龙是我们的客户，具体情况我需要再看看。");
}

describe("旧网关丢掉工具表：0.46.15 的 agent 怎么退", () => {
  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：不报错；旧网关下一次工具都查不了、空口作答（=线上现状），新网关下正常查库`, async () => {
      const 线 = 接线到(版本, { 上游: 模型 });
      const r = await 问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(true);
      expect(await 用掉(账号.acc.id)).toBe(1);
      if (版本 === "旧") {
        // 工具表在旧网关被丢掉，上游回的是普通正文 → agent 当成「没调工具」，顶回去一次再放行，不会退回 JSON 协议
        expect(线.上游.some((u) => u.body.tools)).toBe(false);
        expect(线.上游.some((u) => u.body.response_format)).toBe(false);
        expect(工具步(r.steps)).toEqual([]);
        expect(r.屏幕).not.toContain("聊了报价");
      } else {
        expect(工具步(r.steps).some((l) => l.startsWith("get_customer"))).toBe(true);
        expect(r.屏幕).toContain("聊了报价");
      }
    });
  }
});

describe("快速重发（首轮 25 / 45 / 20 秒没回音就重发一次）", () => {
  beforeEach(() => 时间缩放());

  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：AI 解析第一次卡 60 秒才回（网关那边 200）、重发 3 秒回——只扣 1 次（旧网关认问题编号）`, async () => {
      let n = 0;
      const 答 = () => 回文本(JSON.stringify({ followUp: { type: "PHONE", content: "聊了二十分钟", followedAt: null }, plan: null, status: null }));
      const 线 = 接线到(版本, { 上游: () => (++n === 1 ? { 等: 60, 回: 答 } : { 等: 3, 回: 答 }) });
      const a = await (await import("@/app/(app)/customers/[id]/ai")).parseFollowUpDraft({ customerId: 客户, text: "刚跟李文龙聊了二十分钟，下周三下午电话再约" });
      await 等后台(线);
      expect(a.ok).toBe(true);
      expect(线.网关).toHaveLength(2);
      expect(new Set(线.网关.map((g) => g.questionId)).size).toBe(1);
      expect(await 用掉(账号.acc.id)).toBe(1);
    });

    // 旧网关这条不修：先部署网关、再推 0.46.15 就碰不到（第四轮兼容 C2）
    (版本 === "旧" ? it.skip : it)(`${版本 === "旧" ? "【先部署网关就碰不到】" : ""}网关=${版本}：首页问一句，第一次决策卡 150 秒（网关 120 秒超时 504）、重发马上回——用户拿到了答案，该扣 1 次`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => (r.第几次 === 1 ? { 等: 150, 回: () => 模型(r) } : 模型(r)) });
      const r = await 问AI("李文龙上次聊到哪了");
      expect(r.result?.ok).toBe(true);
      await 等后台(线);
      const 扣 = await 用掉(账号.acc.id);
      console.info(`[r4] 0.46.15 × ${版本}网关 首发卡 150 秒、重发成功 → 扣 ${扣} 次；网关状态 ${线.网关.map((g) => g.status).join(",")}`);
      // 实际：卡住的那条在网关 120 秒时 504 → 退了这个问题（它是扣次数的那一条）→ 用户拿到答案却 0 次。两版网关都这样（漏收，C）
      expect(扣).toBe(1);
    });
  }
});

describe("5xx 重发在旧网关上", () => {
  for (const 版本 of ["旧", "新"] as 网关版本[]) {
    it(`网关=${版本}：第一步上游 502、重发成功——扣 1 次`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => (r.第几次 === 1 ? 回JSON({ error: "bad gateway" }, 502) : 模型(r)) });
      const r = await 问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(true);
      expect(await 用掉(账号.acc.id)).toBe(1);
    });

    it(`网关=${版本}：第二步上游 502、重发成功——扣 1 次`, async () => {
      const 线 = 接线到(版本, { 上游: (r) => (r.第几次 === 2 ? 回JSON({ error: "bad gateway" }, 502) : 模型(r)) });
      const r = await 问AI("李文龙上次聊到哪了");
      await 等后台(线);
      expect(r.result?.ok).toBe(true);
      expect(await 用掉(账号.acc.id)).toBe(1);
    });
  }
});

describe("旧网关的报错，在 0.46.15 上显示成什么", () => {
  for (const [上游码, 说明] of [[401, "我们的 Key 失效"], [404, "模型名在中转站不存在"], [402, "中转站余额不足"]] as const) {
    // 不修：先部署网关、再推 0.46.15 就碰不到（第四轮兼容 C3）
    it.skip(`【先部署网关就碰不到】旧网关：上游 ${上游码}（${说明}）——0.46.15 屏幕上是人话吗、扣不扣`, async () => {
      const 线 = 接线到("旧", { 上游: () => 回JSON({ error: { message: `Upstream error ${上游码}: Authentication Fails / Model Not Exist / Insufficient Balance` } }, 上游码) });
      const r = await 问AI("李文龙上次聊到哪了");
      await 等后台(线);
      const 扣 = await 用掉(账号.acc.id);
      console.info(`[r4] 0.46.15 × 旧网关 上游 ${上游码} → 屏幕：${给人看(r)}；扣 ${扣} 次；打网关 ${线.网关.length} 次`);
      expect(r.result?.ok).toBe(false);
      // 旧网关原样回「上游模型接口返回 401：{英文}」，新客户端认出里面有中文就整句照摆
      expect(是人话(给人看(r))).toBe(true);
    });
  }
});
