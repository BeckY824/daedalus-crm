/**
 * 网页试用版是几个团队共用一个账号（2026-10-01 排查 A3）。
 * 原来任何一个团队都能在设置里改这个账号的密码和名字：改密码会吊销全部会话，
 * 别的团队全被踢出、也登不回来。共享区里这两件事一律不许做，自部署 / 桌面端照常。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  共享: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));
vi.mock("@/lib/shared-ws/current", () => ({
  当前是共享区: async () => mocks.共享,
  号码脱敏器: async () => (p: string | null) => p,
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改我的资料, changeMyPassword } from "@/app/(app)/settings/actions";

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = u.id;
  mocks.共享 = false;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("A3 共享试用区：共用账号的名字和密码不许改", () => {
  it("共享区里改名字被拦，库里不变", async () => {
    mocks.共享 = true;
    expect(await 改我的资料({ name: "改掉了", title: "" })).toMatchObject({ ok: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mocks.user.id } })).name).toBe("甲");
  });

  it("共享区里改密码被拦，库里不变", async () => {
    mocks.共享 = true;
    expect(await changeMyPassword("x", "newpassword123")).toMatchObject({ ok: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mocks.user.id } })).password).toBe("x");
  });

  it("不是共享区：改名字照常", async () => {
    expect(await 改我的资料({ name: "乙", title: "销售" })).toMatchObject({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mocks.user.id } })).name).toBe("乙");
  });
});
