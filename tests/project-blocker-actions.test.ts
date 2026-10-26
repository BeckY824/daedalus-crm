/**
 * 卡点接口（projects/blocker-actions.ts）：项目模式关着、不是企业版一律拦、一行不写；做成了留一条操作记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  开: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: mocks.开 }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 记项目沟通 } from "@/lib/project/db";
import {
  发布卡点Action, 指认卡点Action, 认领卡点Action, 接受卡点Action, 转让卡点Action, 返回卡点Action, 改卡点进度Action, 解决卡点Action,
  存卡点默认Action, 卡点可选的人Action, 我的卡点Action,
} from "@/app/(app)/projects/blocker-actions";
import { invalidateSettingsCache } from "@/lib/settings";

let 甲: string;
let 项目id: string;
let 沟通id: string;
const 卡 = { obstacle: "价格", description: "报价高" };

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.开 = true;
  vi.stubEnv("CRM_ENTERPRISE", "1");
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  mocks.user = { ...mocks.user, id: 甲, role: "ADMIN" };
  const c = await prisma.customer.create({ data: { name: "客户", phone: "13800000001", salesOwnerId: 甲 } });
  项目id = (await prisma.project.create({ data: { name: "一期", customerId: c.id, ownerId: 甲, creatorId: 甲 } })).id;
  const r = await 记项目沟通({ id: 甲, role: "ADMIN" }, 项目id, { type: "PHONE", content: "聊了", occurredAt: new Date().toISOString().slice(0, 10) });
  沟通id = r.followUpId!;
});
afterEach(() => { vi.unstubAllEnvs(); });

async function 全拦(期望: string) {
  const b = await prisma.entBlocker.create({
    data: { code: "BLK20261026999", projectId: 项目id, followUpId: 沟通id, customerId: (await prisma.project.findUniqueOrThrow({ where: { id: 项目id } })).customerId, phase: "线索", type: "中度卡点", impact: "短期不影响", obstacle: "价格", description: "x", dueDays: 3, dueAt: new Date(), creatorId: 甲 },
  });
  for (const x of [
    await 发布卡点Action(沟通id, 卡), await 指认卡点Action(b.id, 甲), await 认领卡点Action(b.id), await 接受卡点Action(b.id),
    await 转让卡点Action(b.id, 甲), await 返回卡点Action(b.id, "理由"), await 改卡点进度Action(b.id, { progress: "x" }),
    await 解决卡点Action(b.id, { solution: "x", result: "y" }), await 存卡点默认Action({ 默认类型: "轻度卡点" }),
  ]) expect(x).toMatchObject({ ok: false, error: expect.stringContaining(期望) });
  expect(await 卡点可选的人Action(项目id)).toEqual([]);
  expect(await 我的卡点Action()).toEqual([]);
  expect(await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "看板", assigneeId: null });
  expect(await prisma.entBlocker.count()).toBe(1);
  expect(await prisma.entBlockerLog.count()).toBe(0);
  expect(await prisma.auditLog.count({ where: { entity: "EntBlocker" } })).toBe(0);
}

describe("卡点接口", () => {
  it("项目模式关着：全拦", async () => {
    mocks.开 = false;
    await 全拦("项目模式没开");
  });

  it("不是企业版：全拦", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    await 全拦("企业版");
  });

  it("做成了：发布、认领各留一条操作记录", async () => {
    const r = await 发布卡点Action(沟通id, 卡);
    expect(r).toMatchObject({ ok: true, code: expect.stringMatching(/^BLK\d{8}001$/) });
    const b = await prisma.entBlocker.findFirstOrThrow();
    expect(await 认领卡点Action(b.id)).toEqual({ ok: true });
    const 记录 = await prisma.auditLog.findMany({ where: { entity: "EntBlocker" }, orderBy: { at: "asc" }, select: { summary: true } });
    expect(记录.map((x) => x.summary)).toEqual([`发布卡点 ${b.code}`, `认领卡点 ${b.code}`]);
    expect((await 我的卡点Action()).map((x) => x.id)).toEqual([b.id]);
    expect(await 卡点可选的人Action(项目id)).toEqual([{ id: 甲, name: "甲" }]);
  });
});
