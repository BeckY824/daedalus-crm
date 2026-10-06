/**
 * 大库性能（2026-10-06 测试分期第 B 期 B.4）。平时跳过：BIG=1 npx vitest run tests/big-perf.test.ts
 *
 * 造 2 万位客户（一半带外贸档案、一部分带联系人）、10 万条跟进、2 千张订单，量这几样要多久：
 * 客户列表一页 + 总数、关键词搜索（会搜到联系人 / 档案 / 订单号那几路）、按国家筛、导出（取数 + 写 xlsx）、
 * 订单一览、导入 2 万行、撤销这一批。结果打在控制台里，过关线写在断言上（宽松，防的是数量级的退化）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { 客户筛选条件, 客户行字段 } from "@/app/(app)/customers/query";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { 客户导出表, 跟进导出表 } from "@/app/(app)/customers/export-table";
import { 写xlsx } from "@/lib/xlsx-write";
import { 订单列表 } from "@/lib/order-db";
import { 执行导入, 撤销批次 } from "@/app/(app)/customers/import-actions";
import { 字段表, 猜列 } from "@/lib/import/fields";

const 客户数 = Number(process.env.BIG_CUSTOMERS ?? 20_000);
const 跟进数 = Number(process.env.BIG_FOLLOWUPS ?? 100_000);
const 订单数 = Number(process.env.BIG_ORDERS ?? 2_000);
const 结果: string[] = [];

async function 计时<T>(名: string, fn: () => Promise<T>, 上限毫秒: number): Promise<T> {
  const 起 = performance.now();
  const r = await fn();
  const 用 = Math.round(performance.now() - 起);
  结果.push(`${名}：${用} ms（线 ${上限毫秒}）`);
  expect(用, `${名} 太慢`).toBeLessThan(上限毫秒);
  return r;
}

describe.runIf(process.env.BIG === "1")("大库性能（B.4）", () => {
  beforeAll(async () => {
    await resetDb();
    invalidateSettingsCache();
    const jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
    mocks.user = { ...mocks.user, id: jia.id };
    await setSetting("business", BUSINESS_PRESETS["外贸出口"]);
    invalidateSettingsCache();
    const 国 = ["美国", "阿联酋", "德国", "乌兹别克斯坦", "巴西", "日本"];
    const 起 = performance.now();
    // 原生 SQL 批量造：一条一条 create 两万次太慢，量的不是造数据
    const 批 = 500;
    for (let i = 0; i < 客户数; i += 批) {
      const 值 = [];
      for (let j = i; j < Math.min(i + 批, 客户数); j++) {
        值.push(`('c${j}', '客户${j}', '138${String(j).padStart(8, "0")}', 'Company ${j} LLC', '${jia.id}', '跟进中', '了解中', datetime('now'), datetime('now'))`);
      }
      await prisma.$executeRawUnsafe(`INSERT INTO "Customer" (id, name, phone, school, salesOwnerId, followStatus, decisionStatus, createdAt, updatedAt) VALUES ${值.join(",")}`);
      const 档 = 值.map((_, k) => i + k).filter((j) => j % 2 === 0).map((j) => `('c${j}', '${国[j % 国.length]}', '+971 50 ${String(j).padStart(7, "0")}', NULL, 'buyer${j}@co.com', '展会')`);
      if (档.length) await prisma.$executeRawUnsafe(`INSERT INTO "CustomerExtra" (customerId, country, whatsapp, wechat, email, source) VALUES ${档.join(",")}`);
      const 联 = 值.map((_, k) => i + k).filter((j) => j % 5 === 0).map((j) => `('ct${j}', 'Contact ${j}', '+1 415 ${String(j).padStart(7, "0")}', 'c${j}', datetime('now'), datetime('now'))`);
      if (联.length) await prisma.$executeRawUnsafe(`INSERT INTO "Contact" (id, name, phone, customerId, createdAt, updatedAt) VALUES ${联.join(",")}`);
    }
    for (let i = 0; i < 跟进数; i += 1000) {
      const 值 = [];
      for (let j = i; j < Math.min(i + 1000, 跟进数); j++) 值.push(`('f${j}', 'PHONE', '', '第 ${j} 条跟进，聊了报价和交期', '已完成', datetime('now', '-${j % 400} days'), 'c${j % 客户数}', '${jia.id}', datetime('now'), datetime('now'))`);
      await prisma.$executeRawUnsafe(`INSERT INTO "FollowUp" (id, type, title, content, status, occurredAt, customerId, ownerId, createdAt, updatedAt) VALUES ${值.join(",")}`);
    }
    for (let i = 0; i < 订单数; i += 500) {
      const 签 = [], 单 = [];
      for (let j = i; j < Math.min(i + 500, 订单数); j++) {
        签.push(`('k${j}', 'c${j}', ${1000 + j}, datetime('now', '-${j % 300} days'), datetime('now'), datetime('now'))`);
        单.push(`('o${j}', 'PI-${j}', 'c${j}', '${jia.id}', ${1000 + j}, 'USD', 'T/T', 'k${j}', datetime('now'), datetime('now'))`);
      }
      await prisma.$executeRawUnsafe(`INSERT INTO "Contract" (id, customerId, amount, signedAt, createdAt, updatedAt) VALUES ${签.join(",")}`);
      await prisma.$executeRawUnsafe(`INSERT INTO "TradeOrder" (id, no, customerId, ownerId, amount, currency, payment, contractId, createdAt, updatedAt) VALUES ${单.join(",")}`);
    }
    结果.push(`造数据（${客户数} 客户 / ${跟进数} 跟进 / ${订单数} 订单）：${Math.round(performance.now() - 起)} ms`);
  }, 600_000);

  afterAll(async () => {
    const 文 = `==== 大库性能 ${new Date().toISOString()} ====\n${结果.join("\n")}\n`;
    console.log(文);
    if (process.env.BIG_OUT) (await import("node:fs")).appendFileSync(process.env.BIG_OUT, 文);
    await resetDb();
    await prisma.$disconnect();
  });

  it("客户列表、搜索、筛选、订单一览", async () => {
    const 一页 = async (sp: Parameters<typeof 客户筛选条件>[0]) => {
      const where = await 客户筛选条件(sp);
      return Promise.all([prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: 20, select: 客户行字段 }), prisma.customer.count({ where })]);
    };
    await 计时("客户列表第一页 + 总数", () => 一页({}), 1500);
    const [, n1] = await 计时("搜一个公司名（含联系人 / 档案 / 订单号几路）", () => 一页({ keyword: "Company 1234" }), 3000);
    expect(n1).toBeGreaterThan(0);
    await 计时("搜联系人名", () => 一页({ keyword: "Contact 15" }), 3000);
    await 计时("搜订单号", () => 一页({ keyword: "PI-1999" }), 3000);
    await 计时("按国家筛", () => 一页({ country: "阿联酋" }), 1500);
    await 计时("订单一览", () => 订单列表(), 3000);
  }, 120_000);

  it("导出：取数 + 写 xlsx", async () => {
    const r = await 计时("导出取数（2 万客户 + 跟进）", () => 导出客户({}), 30_000);
    if (!r.ok) throw new Error(r.error);
    const b = { ...BUSINESS_PRESETS["外贸出口"] };
    const 字节 = await 计时("写 xlsx 两张表", async () => {
      const 客 = 客户导出表(r.rows, b);
      const 跟 = 跟进导出表(r.跟进, b);
      return 写xlsx([{ 名: "客户", 表头: 客.head, 行: 客.body }, { 名: "跟进记录", 表头: 跟.head, 行: 跟.body }]);
    }, 20_000);
    结果.push(`导出：${r.rows.length} 位客户、${r.跟进.length} 条跟进，xlsx ${(字节.length / 1024 / 1024).toFixed(1)} MB`);
  }, 120_000);

  it("导入 1 万行（一次导入的上限）、撤销这一批", async () => {
    const 行数 = Math.min(客户数, 10_000);
    const 表头 = ["客户名称", "联系电话", "公司", "国家", "WhatsApp", "邮箱", "来源"];
    const 数据 = Array.from({ length: 行数 }, (_, j) => [`新客户${j}`, `137${String(j).padStart(8, "0")}`, `New ${j}`, "美国", `+1 212 ${String(j).padStart(7, "0")}`, `n${j}@x.com`, "展会"]);
    const 映射 = 猜列(表头, 字段表(BUSINESS_PRESETS["外贸出口"]));
    const w = await 计时(`导入 ${行数} 行`, () => 执行导入({ 表头, 数据, 映射, 重复行: "跳过" }, "big.xlsx"), 600_000);
    if (!w.ok) throw new Error(w.error);
    expect(w.新建).toBe(行数);
    // 线收紧（2026-10-06）：客户的 attributionCustomerId 没索引时这一步 2 分钟，补了迁移 024
    const u = await 计时("撤销这一批", () => 撤销批次(w.batchId), 60_000);
    expect(u.ok).toBe(true);
  }, 1_300_000);
});
