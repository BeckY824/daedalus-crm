/**
 * 复查 5b64f81 钉住老签约()：先 findMany 再 createMany，中间没有锁、也没有 skipDuplicates（SQLite 不支持）。
 * 升级后第一次换负责人时，两个换人动作同时到（行内连改两位客户的负责人、批量分配与单改并发），
 * 两边都查到同一批缺的，后到的 createMany 撞唯一键直接抛错——那次换负责人整个失败。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

beforeEach(async () => {
  await resetDb();
  const u = (await prisma.user.create({ data: { email: "z3", name: "张三", role: "SALES", password: "x" } })).id;
  const c = (await prisma.customer.create({ data: { name: "老客户", phone: "13800000009", salesOwnerId: u } })).id;
  for (let i = 0; i < 20; i++) await prisma.contract.create({ data: { customerId: c, amount: 1000 + i, signedAt: new Date("2026-08-01") } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("复查：钉住老签约并发", () => {
  it("同时调两次：都不该抛错", async () => {
    const { 钉住老签约 } = await import("@/lib/contract-owner");
    const r = await Promise.allSettled([钉住老签约(), 钉住老签约()]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
