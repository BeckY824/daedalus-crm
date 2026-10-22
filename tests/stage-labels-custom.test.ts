/**
 * 商机阶段名自己改（2026-10-21 用户放行）：设置 → 业务里改五个阶段的叫法，全队一份。
 *   - 只改显示：商机存的阶段值、看板漏斗、赢单 / 转订单都按值算，不受影响
 *   - 外贸、通用模版都能改；老外贸库没存过阶段名 → 照旧「询盘」那套；存过空的 → 原名
 *   - 不能空、不能超 6 字、不能重复、不能借别的阶段的名字（含外贸默认叫法）
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa-stage", role: "ADMIN", title: "管理员", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (original) => ({ ...(await original<object>()), requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { getBusiness } from "@/lib/business";
import { BUSINESS_PRESETS, DEFAULT_BUSINESS, mergeBusiness, stageLabel, 阶段值, 阶段名问题, 外贸阶段名 } from "@/lib/business-config";
import { OPP_STAGES } from "@/lib/constants";
import { saveBusinessSettings } from "@/app/(app)/settings/actions";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";
import { TOOLS } from "@/lib/agent/tools";
import { 造客户 } from "./r2-data-helpers";

const 外贸 = BUSINESS_PRESETS["外贸出口"];
const 项目制 = { 初步沟通: "线索", 需求确认: "现场勘查", 方案报价: "出方案", 谈判审核: "投标", 赢单成交: "中标" };

describe("显示名", () => {
  it("改过的用改过的，没改的用原名；通用、外贸一样", () => {
    for (const b of [DEFAULT_BUSINESS, 外贸]) {
      const c = { ...b, stageLabels: { 需求确认: "现场勘查" } };
      expect(OPP_STAGES.map((s) => stageLabel(c, s))).toEqual(["初步沟通", "现场勘查", "方案报价", "谈判审核", "赢单成交"]);
    }
  });

  it("老配置：外贸没存过阶段名 → 询盘那套；存过空的 → 原名；通用没存过 → 原名", () => {
    const { stageLabels: _x, ...老外贸 } = 外贸;
    expect(mergeBusiness(老外贸).stageLabels).toEqual(外贸阶段名);
    expect(stageLabel({ template: "trade" }, "初步沟通")).toBe("询盘");
    expect(mergeBusiness({ ...老外贸, stageLabels: {} }).stageLabels).toEqual({});
    expect(mergeBusiness({ ...DEFAULT_BUSINESS, stageLabels: undefined }).stageLabels).toEqual({});
  });

  it("合并时去空格、丢掉空的 / 和原名一样的 / 不认识的阶段", () => {
    const m = mergeBusiness({ ...DEFAULT_BUSINESS, stageLabels: { 初步沟通: "  线索 ", 需求确认: "", 方案报价: "方案报价", 乱写: "x", 谈判审核: 3 as unknown as string } });
    expect(m.stageLabels).toEqual({ 初步沟通: "线索" });
  });

  it("反查：改过的名字、原名都认得回存储值", () => {
    const c = { ...DEFAULT_BUSINESS, stageLabels: 项目制 };
    expect(阶段值(c, "投标")).toBe("谈判审核");
    expect(阶段值(c, " 中 标 ")).toBe("赢单成交");
    expect(阶段值(c, "谈判审核")).toBe("谈判审核");
    expect(阶段值(c, "不认识")).toBe("不认识");
  });
});

describe("检查", () => {
  it("预设都没问题", () => {
    for (const p of Object.values(BUSINESS_PRESETS)) expect(阶段名问题(p)).toEqual({});
    expect(阶段名问题({ ...DEFAULT_BUSINESS, stageLabels: 项目制 })).toEqual({});
  });

  it.each([
    [{ 初步沟通: "​" }, "初步沟通", "不能只有空白"],
    [{ 初步沟通: "七个字的阶段名" }, "初步沟通", "6 个字以内"],
    [{ 初步沟通: "需求确认" }, "初步沟通", "属于「需求确认」"],
    [{ 需求确认: "询盘" }, "需求确认", "属于「初步沟通」"],
    [{ 初步沟通: "跟进", 需求确认: "跟 进" }, "需求确认", "重复"],
  ])("%j 拦下", (stageLabels, key, msg) => {
    expect(阶段名问题({ ...DEFAULT_BUSINESS, stageLabels })[key]).toContain(msg);
  });

  it("外贸那套换着用自己的名字可以（谈判审核叫回原名「谈判审核」也行）", () => {
    expect(阶段名问题({ ...外贸, stageLabels: { ...外贸阶段名, 谈判审核: "" } })).toEqual({});
  });
});

describe("保存后全队生效，商机不动", () => {
  let 我: string;
  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    我 = (await prisma.user.create({ data: { email: state.user.email, name: "QA", role: "ADMIN", password: "qa" } })).id;
    state.user = { ...state.user, id: 我 };
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("冲突的不存、不记审计", async () => {
    await setSetting("business", DEFAULT_BUSINESS);
    const before = await prisma.setting.findUniqueOrThrow({ where: { key: "business" } });
    expect(await saveBusinessSettings({ ...DEFAULT_BUSINESS, stageLabels: { 初步沟通: "投标", 谈判审核: "投标" } })).toMatchObject({ ok: false, error: expect.stringContaining("重复") });
    expect(await prisma.setting.findUniqueOrThrow({ where: { key: "business" } })).toEqual(before);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it.each([["通用", DEFAULT_BUSINESS], ["外贸", 外贸]] as const)("%s：改名后商机阶段值、赢单状态不变，AI 按新名字也筛得到", async (_n, base) => {
    await setSetting("business", base);
    invalidateSettingsCache();
    const c = await 造客户(我);
    await saveOpportunity({ name: "展厅灯具", customerId: c.id, amount: 100, stage: "谈判审核", status: "OPEN", probability: 70, ownerId: 我 });
    await saveOpportunity({ name: "办公楼", customerId: c.id, amount: 300, stage: "初步沟通", status: "OPEN", probability: 10, ownerId: 我 });
    const 前 = await prisma.opportunity.findMany({ orderBy: { name: "asc" }, select: { id: true, stage: true, status: true, amount: true } });

    expect(await saveBusinessSettings({ ...base, stageLabels: 项目制 })).toMatchObject({ ok: true });
    invalidateSettingsCache();
    const b = await getBusiness();
    expect(b.stageLabels).toEqual(项目制);
    expect(b.template).toBe(base.template);
    expect(await prisma.opportunity.findMany({ orderBy: { name: "asc" }, select: { id: true, stage: true, status: true, amount: true } })).toEqual(前);

    const ctx = { userId: 我, userName: "QA", b, recordOffset: 0, proposals: [] };
    const 工具 = TOOLS.find((t) => t.name === "list_opportunities")!;
    const r = await 工具.run({ stage: "投标" }, ctx);
    expect((r.data as { 商机: { 名称: string; 阶段: string }[] }).商机).toEqual([expect.objectContaining({ 名称: "展厅灯具", 阶段: "投标" })]);
  });
});
