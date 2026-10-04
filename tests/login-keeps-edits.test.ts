/**
 * 上线前第 2 期 2c · 改过的不许被盖回——登录这一条（排查 B4 / D-006）。
 *
 * desktop-name-sync.test.ts 只用源码正则钉着「登录不再无条件写回」；这里真走一遍桌面端登录 action：
 * 改 → 登录 → 值还在。职位改成「销售总监」、名字改成自己起的，登录一次都还在；空职位、模板带的「系统管理员」照旧写成「管理员」。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const 云 = vi.hoisted(() => ({ 名字: "云端名字" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/auth", () => ({ createSession: async () => {} }));
vi.mock("@/lib/desktop/cloud", async (原) => ({
  ...(await 原<typeof import("@/lib/desktop/cloud")>()),
  本地模式: () => true,
  登录: async (t: string) => ({ ok: true, data: { 换了账号: false, contact: t, name: 云.名字 } }),
}));
// 「本机我」= 本机库里那位管理员（真实的取法要读 .cloud.json，这里不搭数据目录）
vi.mock("@/lib/desktop/me", () => ({
  本机我: async (db: { user: { findFirst: (a: unknown) => Promise<unknown> } }) => db.user.findFirst({ where: { role: "ADMIN" } }),
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 桌面端登录 } from "@/app/login/actions";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 同步名字键 } from "@/lib/desktop/synced-name";

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
});
afterAll(async () => {
  invalidateSettingsCache();
  await prisma.$disconnect();
});

async function 本机管理员(title: string, name = "管理员") {
  return prisma.user.create({ data: { email: "admin", name, title, role: "ADMIN", password: "x" } });
}

describe("改过的不许被盖回：登录", () => {
  it("个人资料里把职位改成「销售总监」→ 登录 → 还是「销售总监」，不被写回「管理员」", async () => {
    const u = await 本机管理员("销售总监");
    expect(await 桌面端登录("me@x.com", "pw")).toEqual({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).title).toBe("销售总监");
  });

  it("没改过的（空的、模板带的「系统管理员」）→ 登录后写成「管理员」", async () => {
    const u = await 本机管理员("系统管理员");
    await 桌面端登录("me@x.com", "pw");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).title).toBe("管理员");
    await prisma.user.update({ where: { id: u.id }, data: { title: "  " } });
    await 桌面端登录("me@x.com", "pw");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).title).toBe("管理员");
  });

  it("名字：上次跟云端对过之后人自己改了 → 再登录不改回云端的；没改过的跟着云端变", async () => {
    const u = await 本机管理员("管理员", "云端名字");
    await setSetting(同步名字键, "云端名字");
    await prisma.user.update({ where: { id: u.id }, data: { name: "小王" } });
    云.名字 = "云端新名字";
    await 桌面端登录("me@x.com", "pw");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name, "人改过的名字被云端盖回去了").toBe("小王");

    await prisma.user.update({ where: { id: u.id }, data: { name: "云端新名字" } });
    云.名字 = "又改了";
    await 桌面端登录("me@x.com", "pw");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name).toBe("又改了");
  });
});
