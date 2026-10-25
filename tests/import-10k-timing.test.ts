/**
 * D-16 一次导入上万位老客户（2026-10-25）：导入这一半的两条计时 + 查重走索引。
 *
 *   - 1 万行：空库一次导完（抽屉那样分块暂存 + 分段导入），每一趟都往前走、最后一趟说完了
 *   - 库里已经有 1 万位，再导 3000 行（一半是老客户）：1 分钟内。按电话认、外贸只有邮箱按邮箱认各一条
 *   - 查重那几句 SQL 的查询计划用上表达式索引（电话 021、邮箱 / 微信 / 阿里 ID 048）：
 *     计时线放得很宽（本机几秒、线是 1 分钟），CI 上慢几倍也不抖；真退回整表扫靠查询计划这一条挡
 *
 * 本机（16GB Mac，2026-10-25）：1 万行 6–7 秒；已有 1 万再导 3000 按电话约 1.3 秒；
 * 外贸只有邮箱 / 微信 / 阿里 ID 没索引约 2.9 秒、有索引约 1.3 秒（库越大差得越多）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人 } from "./r2-data-helpers";
import { 分段导入, 暂存导入表, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 清空暂存 } from "@/lib/import/staging";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS, BUSINESS_PRESETS, type BusinessConfig } from "@/lib/business-config";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 按号键找SQL, 号键索引名 } from "@/lib/phone-dedupe";
import { 按档案格找SQL, 档案格索引名 } from "@/lib/email-dedupe";

/** 界面上写的：1 分钟内 */
const 一分钟 = 60_000;
const 外贸 = BUSINESS_PRESETS["外贸出口"];
const 外贸表头 = ["客户名称", "联系电话", "国家", "邮箱", "微信", "阿里巴巴ID"];

let 我: string;
beforeEach(async () => {
  await resetDb();
  清空暂存();
  invalidateSettingsCache();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

/** 抽屉那样导：先分块暂存，再一趟一趟分段导入直到说完了。返回用时、每一趟写到哪、最后一趟 */
async function 抽屉导(表头: string[], 数据: string[][], 重复行: 导入方案["重复行"], 业务: BusinessConfig) {
  const 号 = `t-${Math.random().toString(36).slice(2, 10)}`;
  const 起时 = Date.now();
  for (let 起 = 0; 起 < 数据.length; 起 += 2000) {
    const r = await 暂存导入表(号, { 起, 数据: 数据.slice(起, 起 + 2000) }, 起 === 0 ? { 表头, 共: 数据.length } : undefined);
    expect(r.ok).toBe(true);
  }
  const 到哪: number[] = [];
  let 续: { batchId?: string; 起: number } = { 起: 0 };
  for (;;) {
    const r = await 分段导入({ 表头, 数据: [], 映射: 猜列(表头, 字段表(业务)), 重复行, 暂存: 号 }, "大表.csv", 续);
    if (!r.ok) throw new Error(r.error);
    if (r.下一个 === null) return { 用时: Date.now() - 起时, 到哪, 末: r };
    到哪.push(r.下一个);
    续 = { batchId: r.batchId, 起: r.下一个 };
  }
}

/** 库里先放 1 万位：老{i}、138 号段，外贸再带档案（邮箱 / 微信 / 阿里 ID）。裸 SQL 灌，几百毫秒 */
async function 灌一万(带档案: boolean) {
  for (let i = 0; i < 10000; i += 500) {
    const 人: string[] = [], 档: string[] = [];
    for (let j = i; j < i + 500; j++) {
      人.push(`('c${j}', '老${j}', '138${String(j).padStart(8, "0")}', '${我}', '待跟进', '了解中', datetime('now'), datetime('now'))`);
      档.push(`('c${j}', '美国', 'Buyer${j}@Co.com', 'wx${j}', 'ali${j}')`);
    }
    await prisma.$executeRawUnsafe(`INSERT INTO "Customer" (id, name, phone, salesOwnerId, followStatus, decisionStatus, createdAt, updatedAt) VALUES ${人.join(", ")}`);
    if (带档案) await prisma.$executeRawUnsafe(`INSERT INTO "CustomerExtra" (customerId, country, email, wechat, alibabaId) VALUES ${档.join(", ")}`);
  }
}

describe("D-16 计时", () => {
  it("1 万行：空库一次导完，每一趟都往前走", async () => {
    await setSetting("business", 外贸);
    invalidateSettingsCache();
    const 数据 = Array.from({ length: 10000 }, (_, i) => [`客户${i}`, `139${String(i).padStart(8, "0")}`, "德国", `b${i}@x.de`, `w${i}`, `a${i}`]);
    const r = await 抽屉导(外贸表头, 数据, "跳过", 外贸);
    expect(r.末).toMatchObject({ 新建: 10000, 跳过: 0, 进不了: 0, 共: 10000 });
    expect(r.到哪).toEqual([...r.到哪].sort((a, b) => a - b));
    expect(new Set(r.到哪).size).toBe(r.到哪.length);
    expect(await prisma.customer.count()).toBe(10000);
    expect(r.用时).toBeLessThan(一分钟);
  }, 180_000);

  it("已有 1 万再导 3000（一半是老客户，按电话认）：1 分钟内", async () => {
    await 灌一万(false);
    const 数据 = Array.from({ length: 3000 }, (_, i) => [`客户${i}`, i % 2 ? `138${String(i * 3).padStart(8, "0")}` : `137${String(i).padStart(8, "0")}`, "某校", ""]);
    const r = await 抽屉导(["姓名", "手机号", "学校", "备注"], 数据, "补空", DEFAULT_BUSINESS);
    expect(r.末).toMatchObject({ 新建: 1500, 补空: 1500, 进不了: 0, 共: 3000 });
    expect(await prisma.customer.count()).toBe(11500);
    expect(r.用时).toBeLessThan(一分钟);
  }, 180_000);

  it("已有 1 万再导 3000（外贸只有邮箱，大小写不同也认）：1 分钟内", async () => {
    await setSetting("business", 外贸);
    invalidateSettingsCache();
    await 灌一万(true);
    const 数据 = Array.from({ length: 3000 }, (_, i) => [`客户${i}`, "", "美国", i % 2 ? ` buyer${i * 3}@co.COM ` : `new${i}@x.com`, "", ""]);
    const r = await 抽屉导(外贸表头, 数据, "跳过", 外贸);
    expect(r.末).toMatchObject({ 新建: 1500, 跳过: 1500, 进不了: 0, 共: 3000 });
    expect(await prisma.customer.count()).toBe(11500);
    expect(r.用时).toBeLessThan(一分钟);
  }, 180_000);
});

describe("D-16 查重走索引", () => {
  const 计划 = async (sql: string, ...参: string[]) =>
    (await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${sql}`, ...参)).map((x) => x.detail).join(" | ");

  it("电话：号键表达式索引", async () => {
    expect(await 计划(按号键找SQL(2), "13800001111", "13900002222")).toContain(号键索引名);
  });

  for (const 列 of ["email", "wechat", "alibabaId"] as const) {
    it(`${列}：lower(trim()) 表达式索引，不整表扫 CustomerExtra`, async () => {
      const p = await 计划(按档案格找SQL(列, 2), "a@x.com", "b@x.com");
      expect(p).toContain(档案格索引名[列]);
      expect(p).not.toMatch(/SCAN "?CustomerExtra"?(?! USING)/);
    });
  }
});
