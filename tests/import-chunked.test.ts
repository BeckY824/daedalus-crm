/**
 * 一次导上万条、带进度（2026-10-21 用户放行）。服务端这一头：
 *   - 表分块暂存：只认紧接着的块、只给本人取、没收齐不算数；暂存没了预览 / 落库回「重送」
 *   - 分段导入：分几趟写和 执行导入 一趟写完结果一样（合并同号行、认人、补空、计数）
 *   - 断了接着导：同一批、从断处（哪怕重复送了已写过的那段）往下，不多建、新建 / 补空不重复计
 *   - 撤销过的批、别人的批不能接着导；分段导完照样整批撤销、再导一遍全算重复
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人 } from "./r2-data-helpers";
import { 预览导入, 执行导入, 分段导入, 暂存导入表, 撤销批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 收块, 取暂存, 清空暂存 } from "@/lib/import/staging";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: string;
beforeEach(async () => {
  await resetDb();
  清空暂存();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterEach(() => { delete process.env.IMPORT_SEGMENT_MS; });
afterAll(async () => { await prisma.$disconnect(); });

const 表头 = ["姓名", "手机号", "学校", "备注"];
/** n 行；第 k 行和第 0 行同号（表里的重复行，要被合成一条）；第 3 行没手机号（进不来） */
function 造表(n: number, 重号行 = n - 7) {
  return Array.from({ length: n }, (_, i) => [
    `客户${i}`,
    i === 3 ? "" : i === 重号行 ? "13900000000" : `139${String(i).padStart(8, "0")}`,
    i === 重号行 ? "补进来的学校" : "",
    `第${i}位`,
  ]);
}
const 方案 = (数据: string[][], 重复行: 导入方案["重复行"] = "跳过"): 导入方案 => ({ 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行 });

/** 照抽屉那样：分块暂存，再一趟一趟调到写完。返回每趟的回话 */
async function 抽屉导(数据: string[][], 重复行: 导入方案["重复行"] = "跳过", 块行数 = 300) {
  const 号 = `t-${Math.random().toString(36).slice(2, 10)}`;
  for (let 起 = 0; 起 < 数据.length; 起 += 块行数) {
    const r = await 暂存导入表(号, { 起, 数据: 数据.slice(起, 起 + 块行数) }, 起 === 0 ? { 表头, 共: 数据.length } : undefined);
    expect(r.ok).toBe(true);
  }
  const 趟们 = [];
  let 续: { batchId?: string; 起: number } = { 起: 0 };
  for (;;) {
    const r = await 分段导入({ ...方案([], 重复行), 暂存: 号 }, "大表.csv", 续);
    if (!r.ok) throw new Error(r.error);
    趟们.push(r);
    if (r.下一个 === null) return { 号, 趟们, 末: r };
    续 = { batchId: r.batchId, 起: r.下一个 };
  }
}

const 客户们 = () => prisma.customer.findMany({ orderBy: { phone: "asc" }, select: { name: true, phone: true, school: true, remark: true } });

describe("暂存", () => {
  it("只认紧接着的块；没收齐不算；别人取不到", () => {
    expect(收块("u1", "abcdefgh", { 起: 0, 数据: [["a"]] }, { 表头: ["x"], 共: 3 })).toEqual({ ok: true, 收到: 1 });
    expect(收块("u1", "abcdefgh", { 起: 5, 数据: [["b"]] })).toMatchObject({ ok: false });
    expect(取暂存("u1", "abcdefgh")).toBeNull();
    expect(收块("u1", "abcdefgh", { 起: 1, 数据: [["b"], ["c"]] })).toEqual({ ok: true, 收到: 3 });
    expect(取暂存("u1", "abcdefgh")?.数据).toEqual([["a"], ["b"], ["c"]]);
    expect(取暂存("u2", "abcdefgh")).toBeNull();
    expect(收块("u2", "abcdefgh", { 起: 3, 数据: [["d"]] })).toMatchObject({ ok: false });
    expect(收块("u1", "abcdefgh", { 起: 3, 数据: [["d"]] })).toMatchObject({ ok: false, error: "这份表比开头说的多" });
    expect(收块("u1", "bad", { 起: 0, 数据: [] }, { 表头: [], 共: 0 })).toMatchObject({ ok: false });
    expect(收块("u1", "abcdefgi", { 起: 0, 数据: [] }, { 表头: [], 共: 10001 })).toMatchObject({ ok: false });
  });

  it("暂存没了：预览、落库都回「重送」，库里不动", async () => {
    const p = { ...方案([]), 暂存: "nothing-here" };
    expect(await 预览导入(p)).toMatchObject({ ok: false, 重送: true });
    expect(await 分段导入(p, "a.csv", { 起: 0 })).toMatchObject({ ok: false, 重送: true });
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it("预览从暂存取表，和整张表当参数送的结果一样", async () => {
    const 数据 = 造表(500);
    const 直接 = await 预览导入(方案(数据));
    const 号 = "preview-1";
    await 暂存导入表(号, { 起: 0, 数据: 数据.slice(0, 250) }, { 表头, 共: 500 });
    await 暂存导入表(号, { 起: 250, 数据: 数据.slice(250) });
    expect(await 预览导入({ ...方案([]), 暂存: 号 })).toEqual(直接);
  });
});

describe("分段导入", () => {
  it.each(["跳过", "补空"] as const)("分好几趟写和一趟写完结果一样（重复行：%s）", async (处置) => {
    // 库里先有一位（第 10 行那个号），让「已在库里」也走一遍
    await prisma.customer.create({ data: { name: "老客户", phone: "13900000010", salesOwnerId: 我 } });
    process.env.IMPORT_SEGMENT_MS = "1";
    const { 趟们, 末 } = await 抽屉导(造表(1000), 处置);
    expect(趟们.length).toBe(5); // 一趟一片（200 行）
    expect(趟们.map((r) => r.下一个)).toEqual([200, 400, 600, 800, null]);
    const 分段后 = { 计数: { 新建: 末.新建, 补空: 末.补空, 跳过: 末.跳过, 进不了: 末.进不了 }, 客户: await 客户们() };

    await resetDb();
    我 = (await 造本人()).id;
    mocks.user = { ...mocks.user, id: 我 };
    await prisma.customer.create({ data: { name: "老客户", phone: "13900000010", salesOwnerId: 我 } });
    const 一趟 = await 执行导入(方案(造表(1000), 处置), "大表.csv");
    if (!一趟.ok) throw new Error(一趟.error);
    expect(分段后.计数).toEqual({ 新建: 一趟.新建, 补空: 一趟.补空, 跳过: 一趟.跳过, 进不了: 一趟.进不了 });
    expect(分段后.客户).toEqual(await 客户们());
    // 第 0 行和倒数第 7 行同号：合成一条，学校补上了
    expect(分段后.客户.find((c) => c.phone === "13900000000")?.school).toBe("补进来的学校");
  });

  it("批次上的数和最后一趟回话一致；写完记一笔操作日志", async () => {
    process.env.IMPORT_SEGMENT_MS = "1";
    const { 末 } = await 抽屉导(造表(450));
    const 批 = await prisma.importBatch.findUniqueOrThrow({ where: { id: 末.batchId } });
    expect({ 新建: 批.created, 补空: 批.updated, 跳过: 批.skipped, 进不了: 批.failed }).toEqual({ 新建: 末.新建, 补空: 末.补空, 跳过: 末.跳过, 进不了: 末.进不了 });
    expect(末.新建).toBe(448); // 450 - 没手机号的 1 行 - 合掉的 1 行
    expect(末.进不了).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "import", entityId: 末.batchId } })).toBe(1);
  });

  it("断了接着导：把已经写过的那段再送一遍，也不多建、不重复计", async () => {
    process.env.IMPORT_SEGMENT_MS = "1";
    const 数据 = 造表(600);
    const 号 = "resume-1";
    await 暂存导入表(号, { 起: 0, 数据 }, { 表头, 共: 600 });
    const p = { ...方案([]), 暂存: 号 };
    const 一 = await 分段导入(p, "a.csv", { 起: 0 });
    if (!一.ok) throw new Error(一.error);
    const 二 = await 分段导入(p, "a.csv", { batchId: 一.batchId, 起: 200 });
    if (!二.ok) throw new Error(二.error);
    // 第二趟的回话丢了：抽屉还以为停在 200，从 200 再来
    let 续 = { batchId: 一.batchId, 起: 200 };
    let 末 = 二;
    for (;;) {
      const r = await 分段导入(p, "a.csv", 续);
      if (!r.ok) throw new Error(r.error);
      末 = r;
      if (r.下一个 === null) break;
      续 = { batchId: r.batchId, 起: r.下一个 };
    }
    expect(await prisma.customer.count()).toBe(598);
    expect(末.新建).toBe(598);
    expect(末.跳过).toBe(0);
    expect(await prisma.importRow.count({ where: { batchId: 一.batchId } })).toBe(598);
  });

  it("撤销过的批、别人的批不能接着导；位置不对也拒", async () => {
    const 号 = "guard-01";
    expect(await 暂存导入表(号, { 起: 0, 数据: 造表(50) }, { 表头, 共: 50 })).toMatchObject({ ok: true });
    const p = { ...方案([]), 暂存: 号 };
    const r = await 分段导入(p, "a.csv", { 起: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(await 分段导入(p, "a.csv", { 起: 999 })).toMatchObject({ ok: false });
    await 撤销批次(r.batchId);
    expect(await 分段导入(p, "a.csv", { batchId: r.batchId, 起: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("撤销") });
    const 别人 = await prisma.importBatch.create({ data: { userId: "someone-else", userName: "别人", fileName: "x.csv" } });
    expect(await 分段导入(p, "a.csv", { batchId: 别人.id, 起: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
  });

  it("分段导完照样整批撤销；再导一遍全算重复", async () => {
    process.env.IMPORT_SEGMENT_MS = "1";
    const 一 = await 抽屉导(造表(500));
    expect(一.末.新建).toBe(498);
    const 二 = await 抽屉导(造表(500));
    expect(二.末).toMatchObject({ 新建: 0, 跳过: 498 });
    const 撤 = await 撤销批次(一.末.batchId);
    expect(撤).toMatchObject({ ok: true, 删掉: 498 });
    expect(await prisma.customer.count()).toBe(0);
  });
});
