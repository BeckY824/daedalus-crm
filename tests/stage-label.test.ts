/**
 * 外贸模版下商机阶段的显示名（2026-10-03）：只改叫法、存的值不动。
 *   - 通用模版原样；外贸模版五档换成 询盘 / 比价中 / 已报价 / 寄样 / 客户确认
 *   - 反查：人或 AI 说「询盘」认回「初步沟通」，认不出原样
 *   - AI 列商机：外贸模版下阶段按外贸叫法写，按外贸叫法筛也能筛到
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { stageLabel, 阶段值, 外贸阶段名, BUSINESS_PRESETS, DEFAULT_BUSINESS } from "@/lib/business-config";
import { OPP_STAGES } from "@/lib/constants";
import { saveOpportunity } from "@/app/(app)/opportunities/actions";
import { TOOLS } from "@/lib/agent/tools";

describe("阶段显示名", () => {
  it("通用原样；外贸五档都有外贸叫法、且互不相同", () => {
    for (const s of OPP_STAGES) expect(stageLabel(DEFAULT_BUSINESS, s)).toBe(s);
    const 外贸 = OPP_STAGES.map((s) => stageLabel(BUSINESS_PRESETS["外贸出口"], s));
    expect(外贸).toEqual(["询盘", "比价中", "已报价", "寄样", "客户确认"]);
    expect(Object.keys(外贸阶段名).sort()).toEqual([...OPP_STAGES].sort());
  });

  it("反查：外贸叫法认回存储值，认不出原样；通用模版不反查", () => {
    const 外 = BUSINESS_PRESETS["外贸出口"];
    expect(阶段值(外, "询盘")).toBe("初步沟通");
    expect(阶段值(外, "方案报价")).toBe("方案报价");
    expect(阶段值(DEFAULT_BUSINESS, "询盘")).toBe("询盘");
  });
});

describe("AI 列商机", () => {
  let 我: string;
  beforeEach(async () => {
    await resetDb();
    我 = (await 造本人()).id;
    mocks.user = { ...mocks.user, id: 我 };
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("外贸模版下阶段按外贸叫法写、按外贸叫法也筛得到", async () => {
    const c = await 造客户(我);
    await saveOpportunity({ name: "面板灯", customerId: c.id, amount: 100, stage: "初步沟通", status: "OPEN", probability: 10, ownerId: 我 });
    await saveOpportunity({ name: "支架", customerId: c.id, amount: 50, stage: "方案报价", status: "OPEN", probability: 50, ownerId: 我 });
    const ctx = { userId: 我, userName: "我", b: BUSINESS_PRESETS["外贸出口"], recordOffset: 0, proposals: [] };
    const 工具 = TOOLS.find((t) => t.name === "list_opportunities")!;
    const r = await 工具.run({ stage: "询盘" }, ctx);
    expect((r.data as { 商机: { 名称: string; 阶段: string }[] }).商机).toEqual([expect.objectContaining({ 名称: "面板灯", 阶段: "询盘" })]);
  });
});
