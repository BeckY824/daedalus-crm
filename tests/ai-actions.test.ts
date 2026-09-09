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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { parseFollowUpDraft, generateBrief } from "@/app/(app)/customers/[id]/ai";
import { draftWakeup, explainWatchlist } from "@/app/(app)/dashboard/ai";
import { askHome, quickBrief } from "@/app/(app)/dashboard/ask";
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

describe("首页提问守卫", () => {
  it("问题太短要拒绝", async () => {
    const res = await askHome("x");
    expect(res.ok).toBe(false);
  });

  it("问题里点到学员名 → 走简报路径；没有跟进记录时报简报那句人话，而不是白屏", async () => {
    const res = await askHome("测试学员还能怎么推进");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("跟进记录");
  });

  it("同名学员有两位时不能瞎猜，要让人去详情页", async () => {
    const sales = await prisma.user.findFirstOrThrow();
    await prisma.customer.create({ data: { name: "测试学员", phone: "13800000002", salesOwnerId: sales.id } });
    const res = await askHome("测试学员下次谈什么");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 位");
  });

  it("没点到学员名 → 走问数据；key 未配置时是人话错误", async () => {
    const res = await askHome("这个月签了多少单");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/undefined|TypeError/);
  });

  it("准备下次跟进：计划对应的学员没有跟进记录时跳过它，都没有就说清楚", async () => {
    // 计划的 ownerId 是当前登录人（mock 的 tester-id），外键要求这个用户真的在库里
    await prisma.user.create({ data: { id: "tester-id", email: "t", name: "测试员", title: "", role: "ADMIN", password: "x" } });
    const c = await prisma.customer.findFirstOrThrow();
    await prisma.followPlan.create({ data: { customerId: c.id, ownerId: "tester-id", subject: "x", plannedAt: new Date() } });
    const res = await quickBrief("prep");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("跟进记录");
  });

  it("快捷键：没有跟进计划 / 没有跟进记录时各报各的", async () => {
    const prep = await quickBrief("prep");
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.error).toContain("跟进计划");
    const recap = await quickBrief("recap");
    expect(recap.ok).toBe(false);
    if (!recap.ok) expect(recap.error).toContain("跟进记录");
  });
});

describe("盯盘解读守卫", () => {
  it("空清单要拒绝", async () => {
    const res = await explainWatchlist({ items: [] });
    expect(res.ok).toBe(false);
  });

  it("学员不存在要报得清楚", async () => {
    const res = await explainWatchlist({ items: [{ customerId: "nope", reason: "x" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("不存在");
  });
});

describe("速记原文留存", () => {
  // saveFollowUp 会把 ownerId 写成当前登录人，mock 的 tester-id 得真的在库里
  beforeEach(async () => {
    await prisma.user.create({ data: { id: "tester-id", email: "t", name: "测试员", title: "", role: "ADMIN", password: "x" } });
  });

  it("saveFollowUp 带 sourceText → FollowUpSource 有记录；编辑时不动原文", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const res = await saveFollowUp({
      customerId, type: "SMS", content: "要点", status: "已完成",
      occurredAt: new Date().toISOString(), sourceText: "王妈妈：孩子时间不够\n我：先试两节",
    });
    expect(res.ok).toBe(true);
    const fu = await prisma.followUp.findFirstOrThrow({ where: { customerId }, include: { source: true } });
    expect(fu.source?.text).toContain("时间不够");

    const edit = await saveFollowUp({
      id: fu.id, customerId, type: "SMS", content: "改了要点", status: "已完成",
      occurredAt: new Date().toISOString(), sourceText: "试图改写原文",
    });
    expect(edit.ok).toBe(true);
    const again = await prisma.followUp.findUniqueOrThrow({ where: { id: fu.id }, include: { source: true } });
    expect(again.source?.text).toContain("时间不够");
  });

  it("手工新建（不带 sourceText）不产生原文记录", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    await saveFollowUp({ customerId, type: "PHONE", content: "要点", status: "已完成", occurredAt: new Date().toISOString() });
    expect(await prisma.followUpSource.count()).toBe(0);
  });
});
