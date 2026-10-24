/**
 * 企业版导入 · 先演一遍的上限和限时：预演从第一条写起就占着写锁，别处的写最多等 busy_timeout（5 秒）。
 * 上限那么多条要在限时里演完；超上限不演；演到限时就停下回滚，库里一行不多。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 预演, 预演上限, 预演限时毫秒, 演太久 } from "@/lib/enterprise-import/apply";
import type { 读出的表 } from "@/lib/enterprise-import/excel";
import type { 实体, 映射 } from "@/lib/enterprise-import/types";

const 我 = { id: "tester-id", name: "测试员" };

function 表(名: string, 实体: 实体, 表头: string[], 行: string[][]): 读出的表 {
  return { 名, 实体, 表头, 行, 行号: 行.map((_, i) => i + 2), 提醒: [] };
}

/** n 家客户、每家一条跟进，共 2n 条要写 */
function 一批(n: number): 读出的表[] {
  const 客户 = Array.from({ length: n }, (_, i) => [`C${i}`, `测试客户${i}有限公司`, `138${String(i).padStart(8, "0")}`, "张伟"]);
  const 跟进 = Array.from({ length: n }, (_, i) => [`C${i}`, `测试客户${i}有限公司`, "电话", `第 ${i} 次聊报价`, "2026-10-20"]);
  return [
    表("客户.xlsx", "customer", ["记录ID", "客户名称", "手机号码", "客户负责人"], 客户),
    表("跟进记录.xlsx", "followup", ["客户ID", "客户名称", "跟进方式", "跟进内容", "跟进时间"], 跟进),
  ];
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("先演一遍 · 上限和限时", () => {
  // 本机约 1.5 秒。对不对和快不快分开测：CI 上整套一起跑、机器又慢，计时只打出来不卡，免得时快时慢的红；
  // 慢机器上真超了会走「演太久」退回清洗数（下面第三条测这条路）
  it(`上限（${预演上限} 条）那么多：演得完、数对，本机在限时（${预演限时毫秒 / 1000} 秒）里`, async () => {
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 一批(预演上限 / 2), 建议器: null });
    expect(报告.合计.待写).toBe(预演上限);
    if (报告.预演) expect(报告.预演.合计).toMatchObject({ 新建: 预演上限, 失败: 0 });

    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批次Id } });
    const 起 = performance.now();
    const 数 = await 预演("excel", JSON.parse(批.mapping!) as 映射, JSON.parse(批.plan!), 我, 50_000);
    const 用了 = performance.now() - 起;
    console.info(`预演 ${预演上限} 条用了 ${Math.round(用了)} ms`);
    expect(数?.customer).toMatchObject({ 新建: 预演上限 / 2, 失败: 0 });
    expect(数?.followup).toMatchObject({ 新建: 预演上限 / 2, 失败: 0 });
    if (!process.env.CI) expect(用了).toBeLessThan(预演限时毫秒);
    expect(await prisma.customer.count()).toBe(0);
  }, 120_000);

  it("超过上限不演：报告里提醒数字是按清洗分的", async () => {
    const { 报告 } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 一批(预演上限 / 2 + 1), 建议器: null });
    expect(报告.合计.待写).toBe(预演上限 + 2);
    expect(报告.预演).toBeNull();
    expect(报告.提醒.some((s) => s.includes("没先演一遍"))).toBe(true);
  }, 60_000);

  it("演到限时就停：整个回滚，库里一行不多，说清演到第几条", async () => {
    const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 一批(200), 建议器: null });
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批次Id } });
    const 批数 = await prisma.entImportBatch.count();

    const 演 = 预演("excel", JSON.parse(批.mapping!) as 映射, JSON.parse(批.plan!), 我, 0);
    await expect(演).rejects.toThrow(演太久);
    await expect(演).rejects.toThrow(/才到第 \d+ \/ 400 条，怕挡住别人写库先停了/);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);
    expect(await prisma.entImportRow.count()).toBe(0);
    expect(await prisma.entImportBatch.count()).toBe(批数);
  }, 60_000);
});
