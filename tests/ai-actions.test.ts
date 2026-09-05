/**
 * AI Server Action 的守卫层。
 *
 * AI 生成本身不进单测（不联网、不花钱、不引入不确定性），
 * 这里拦的是生成之前和之外的事：输入边界要拒得明白、
 * 学员不存在要报得清楚、key 未配置时必须优雅降级成一条人话错误——
 * 绝不能让"AI 没配好"表现为白屏或 500。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { parseFollowUpDraft, generateBrief } from "@/app/(app)/customers/[id]/ai";
import { draftWakeup } from "@/app/(app)/dashboard/ai";
import { draftInvite } from "@/app/(app)/channels/ai";
import { askData } from "@/app/(app)/reports/ask";
import { llmEnabled } from "@/lib/llm";
import { resetAiQuota, AI_LIMIT } from "@/lib/ai-quota";

let customerId: string;

beforeEach(async () => {
  // 测试进程不配 LLM_API_KEY——这是前提而不是巧合，开头就断言死
  delete process.env.LLM_API_KEY;
  resetAiQuota();
  await resetDb();
  const sales = await prisma.user.create({
    data: { email: "s1", name: "销售甲", title: "销售", role: "SALES", password: "x" },
  });
  const c = await prisma.customer.create({ data: { name: "测试学员", phone: "13800000001", salesOwnerId: sales.id } });
  customerId = c.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("前提", () => {
  it("测试环境不该配置 AI key", async () => {
    expect(await llmEnabled()).toBe(false);
  });
});

describe("跟进速记守卫", () => {
  it("文本太短要拒绝，不发起任何生成", async () => {
    const res = await parseFollowUpDraft({ customerId, text: "嗯" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("太短");
  });

  it("超过 5000 字要拒绝", async () => {
    const res = await parseFollowUpDraft({ customerId, text: "跟".repeat(5001) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("过长");
  });

  it("学员不存在要报得清楚", async () => {
    const res = await parseFollowUpDraft({ customerId: "no-such-id", text: "刚跟家长聊了二十分钟" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("学员不存在");
  });

  it("key 未配置时降级为一条人话错误，且不留下任何 AI 使用痕迹", async () => {
    const res = await parseFollowUpDraft({ customerId, text: "刚跟家长聊了二十分钟，下周约试听" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未启用");
    // 解析没发生，就不该有"AI 解析过"的日志
    const logs = await prisma.auditLog.findMany({ where: { action: "ai_use" } });
    expect(logs).toHaveLength(0);
  });
});

describe("临战简报守卫", () => {
  it("学员不存在要报得清楚", async () => {
    const res = await generateBrief({ customerId: "no-such-id" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("学员不存在");
  });

  it("没有任何跟进记录时明说，不硬生成", async () => {
    const res = await generateBrief({ customerId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("没有");
  });
});

describe("问数据守卫", () => {
  it("问题太短/太长都拒绝", async () => {
    const short = await askData("多少");
    expect(short.ok).toBe(false);
    const long = await askData("为什么".repeat(120));
    expect(long.ok).toBe(false);
  });

  it("key 未配置时降级为一条人话错误", async () => {
    const res = await askData("这个月签约金额是多少？");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未启用");
  });
});

describe("起草话术守卫", () => {
  it("唤醒与邀请：学员不存在都要报得清楚", async () => {
    const wake = await draftWakeup({ customerId: "no-such-id", reason: "沉睡 20 天" });
    expect(wake.ok).toBe(false);
    if (!wake.ok) expect(wake.error).toContain("学员不存在");

    const invite = await draftInvite({ customerId: "no-such-id" });
    expect(invite.ok).toBe(false);
    if (!invite.ok) expect(invite.error).toContain("学员不存在");
  });

  it("key 未配置时降级，不抛异常", async () => {
    const res = await draftWakeup({ customerId, reason: "沉睡 20 天" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("未启用");
  });
});

describe("AI 配额接线", () => {
  it(`同一用户窗口内第 ${AI_LIMIT + 1} 次 AI 动作被拒，错误里说清等多久`, async () => {
    for (let i = 0; i < AI_LIMIT; i++) {
      await askData("这个月签约金额是多少？");
    }
    const res = await askData("这个月签约金额是多少？");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("太频繁");
  });
});
