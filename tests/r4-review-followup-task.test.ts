/**
 * 第四轮对抗复查 · 跟进联动待办「只动一条」（953a7b2）和撤销删除配合不上
 *
 * 红的保持红，等修。
 *   两条同标题、同时间的提醒各带一条待办。删掉一条 → 只带走一条待办（953a7b2 的修法，对）。
 *   撤销删除 → restoreFollowUp 用「同标题同时间、没做完的待办还有没有」判断要不要补建：另一条提醒的待办还在，于是不补——
 *   两条提醒、一条待办，被撤回来的那条到点不会叫。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null as string | null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user, getCurrentUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { saveFollowUp, deleteFollowUp, restoreFollowUp } from "@/app/(app)/customers/[id]/actions";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

describe("同名同时间的两条提醒：删一条再撤销", () => {
  it("撤销后两条提醒都在，待办也该是两条", async () => {
    const c = await 造客户(我);
    const t = new Date(Date.now() + 86400000).toISOString();
    const 一 = await saveFollowUp({ customerId: c.id, type: "REMIND", content: "周五回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t });
    const 二 = await saveFollowUp({ customerId: c.id, type: "REMIND", content: "周五回电", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t });
    if (!一.ok || !二.ok) throw new Error("建不出来");
    expect(await prisma.task.count({ where: { done: false } })).toBe(2);

    const 删 = await deleteFollowUp(一.id, c.id);
    if (!删.ok) throw new Error("删不掉");
    expect(await prisma.task.count({ where: { done: false } })).toBe(1);

    const 回 = await restoreFollowUp(删.快照);
    expect(回.ok).toBe(true);
    expect(await prisma.followUp.count({ where: { type: "REMIND" } })).toBe(2);
    expect(await prisma.task.count({ where: { done: false } }), "两条提醒、只有一条待办").toBe(2);
  });
});
