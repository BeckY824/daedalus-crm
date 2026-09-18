/**
 * 「灌一套演示数据」的护栏。
 *
 * 这个功能往人真实的库里写东西，所以它的边界比功能本身重要：
 *   - 托管版不给（多租户，重置走 seed-shared.ts）
 *   - **桌面端不给**（2026-09-18）。一个人自己的库，装完就该录自己的第一位客户
 *   - 但桌面端上**已经灌过**的老库还得留着「清除」那条路，否则灌进去的假数据删不掉
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 查演示数据状态, 灌一套演示数据, 清除演示数据 } from "@/app/(app)/demo-data";

const 原值 = process.env.DESKTOP_LOCAL;

beforeEach(async () => {
  await resetDb();
  const jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
  delete process.env.DESKTOP_LOCAL;
});

afterAll(async () => {
  if (原值 === undefined) delete process.env.DESKTOP_LOCAL;
  else process.env.DESKTOP_LOCAL = 原值;
  await prisma.$disconnect();
});

describe("网页版（自部署）", () => {
  it("空库、管理员：能灌", async () => {
    const s = await 查演示数据状态();
    expect(s.可用).toBe(true);
    expect(s.可灌).toBe(true);
    expect(s.空库).toBe(true);
    expect((await 灌一套演示数据()).ok).toBe(true);
    expect(await prisma.customer.count()).toBeGreaterThan(0);
  });
});

describe("桌面端", () => {
  it("界面上不给灌：可灌 = false", async () => {
    process.env.DESKTOP_LOCAL = "1";
    const s = await 查演示数据状态();
    expect(s.可灌).toBe(false);
  });

  it("绕过界面直接调也拒绝——护栏不能只写在按钮上", async () => {
    process.env.DESKTOP_LOCAL = "1";
    const r = await 灌一套演示数据();
    expect(r.ok).toBe(false);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("之前灌过的库，「清除」这条路还在", async () => {
    // 老版本桌面端上灌的那一套
    expect((await 灌一套演示数据()).ok).toBe(true);
    process.env.DESKTOP_LOCAL = "1";

    const s = await 查演示数据状态();
    expect(s.可灌).toBe(false);
    expect(s.已灌).toBe(true);
    expect(s.可用).toBe(true); // 清除按这一条显示

    expect((await 清除演示数据()).ok).toBe(true);
    expect(await prisma.customer.count()).toBe(0);
  });
});
