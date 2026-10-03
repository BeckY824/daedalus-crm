/**
 * 第五轮对抗复查 · 导入（057113f 认人表、ec21d6d 表头判断）
 *
 * 红的保持红，等修。
 *   一、表头只看「整格是号码」以后，第三轮 A2（表头比数据窄、第一位客户被当成表头吃掉）又回来了：
 *       第一位客户的号码那格只要不是纯号码——带分机「转 801」、带字「（微信同号）」、两个号、开头的 '、尾巴 .0——
 *       或者他没留号码、那行只有日期，就被认成表头
 *   二、认人表：表里同时有「总机」和「总机转分机」两行、老库里存着这个总机——两行都补进同一位老客户
 *       （第四轮 B4 只数了带分机的行，没算上整串对上的那一行）
 *
 * 绿的钉住：预览和执行的数对得上（随机老库 + 随机表，跑 40 份）、撤销后再导一次数一样
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 预览导入, 执行导入, 撤销批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

const 一天前 = new Date(Date.now() - 86400_000);

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", title: "管理员", role: "ADMIN", password: "x" } });
  // 升级后第一次打开：记下分机开始留着的那一刻（比老记录晚）
  await setSetting("phone.extKeptSince", Date.now() - 3600_000);
});
afterAll(async () => { await prisma.$disconnect(); });

function 方案(csv: string, 重复行: 导入方案["重复行"] = "跳过"): 导入方案 {
  const { 表头, 数据 } = 成表(解析CSV(csv));
  return { 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行 };
}

/* ---------------- 一、表头比数据窄 ---------------- */

describe("成表：表头只起了两列名、数据每行五格（第三轮 A2 的样子）", () => {
  const 后面 = "\n李四,13800000002,上海,女,新客户";
  it.each([
    ["号码带分机", "张三,010-12345678 转 801,北京,男,老客户"],
    ["号码后面带字", "张三,138-0000-0001（微信同号）,北京,男,老客户"],
    ["一格两个号", "张三,13800000001 / 13900000001,北京,男,老客户"],
    ["英文分机带字", "张三,+1 415 555 0132 x12 (office),北京,男,老客户"],
    ["开头一个 '（被存成文本的号）", "张三,'13800000001,北京,男,老客户"],
    ["尾巴 .0（当数字导出的号）", "张三,13800000001.0,北京,男,老客户"],
    ["第一位没留号码、那行有日期", "张三,,北京,2026-09-01,老客户"],
  ])("%s：第一位客户被当成表头吃掉（953a7b2 时是对的）", (_, 第一行) => {
    const t = 成表(解析CSV(`姓名,手机号,,,\n${第一行}${后面}`));
    expect(t.表头.slice(0, 2)).toEqual(["姓名", "手机号"]);
    expect(t.数据.map((r) => r[0])).toEqual(["张三", "李四"]);
  });
});

/* ---------------- 二、总机那一行 + 分机那一行认到同一位老客户 ---------------- */

describe("认人表：表里「总机」和「总机转分机」两行，老库里只存了这个总机", () => {
  it("补空：前台那一行整串对上老客户，王经理那一行靠主号也认到他——两个人的信息写进同一张档案", async () => {
    const 老 = await prisma.customer.create({ data: { name: "某某公司", phone: "01012345678", salesOwnerId: "tester-id", createdAt: 一天前 } });
    const csv = "姓名,手机号,备注,专业\n前台,010-12345678,前台小刘,\n王经理,010-12345678 转 801,,采购部";
    const p = await 预览导入(方案(csv, "补空"));
    if (!p.ok) throw new Error(p.error);
    const w = await 执行导入(方案(csv, "补空"), "c.csv");
    if (!w.ok) throw new Error(w.error);
    const 后 = await prisma.customer.findUniqueOrThrow({ where: { id: 老.id } });
    // 整串对上的那一行（前台）认这位老客户没问题；王经理靠主号认到的也是他——这位老客户已经被整串那行占了，
    // 王经理该算说不清（或新建），不该把「采购部」写进前台的档案。第四轮 B4 只数了带分机的行
    expect(w.补空, `预览补空 ${p.预览.补空}；档案上 备注=${后.remark} 专业=${后.major}`).toBeLessThanOrEqual(1);
  });
});

/* ---------------- 绿的钉住：预览 = 执行 ---------------- */

/** 简单的可复现随机数 */
function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("预览和执行的数对得上（随机老库 + 随机表）", () => {
  const 总机们 = ["01012345678", "02088886666", "075512345678"];
  const 手机们 = ["13800000001", "13800000002", "13900000003"];
  const 写法 = (r: () => number): string => {
    const x = r();
    const 总 = 总机们[Math.floor(r() * 总机们.length)];
    if (x < 0.3) return 总;
    if (x < 0.7) return `${总}转${800 + Math.floor(r() * 3)}`;
    return 手机们[Math.floor(r() * 手机们.length)];
  };

  it("40 份：新建、跳过（含说不清）两边一样", async () => {
    const 不一样: string[] = [];
    for (let k = 0; k < 40; k++) {
      await resetDb();
      invalidateSettingsCache();
      await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", role: "ADMIN", password: "x" } });
      await setSetting("phone.extKeptSince", Date.now() - 3600_000);
      const r = 随机(k + 1);
      const 老几位 = Math.floor(r() * 5);
      for (let i = 0; i < 老几位; i++) {
        await prisma.customer.create({
          data: { name: `老${i}`, phone: 写法(r), salesOwnerId: "tester-id", createdAt: r() < 0.6 ? 一天前 : new Date() },
        });
      }
      const 行 = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => `新${i},${写法(r)}`);
      const csv = `姓名,手机号\n${行.join("\n")}`;
      const p = await 预览导入(方案(csv));
      if (!p.ok) throw new Error(p.error);
      const w = await 执行导入(方案(csv), "p.csv");
      if (!w.ok) throw new Error(w.error);
      if (p.预览.新建 !== w.新建 || p.预览.跳过 !== w.跳过 || p.预览.进不了 !== w.进不了) {
        不一样.push(`#${k} 预览 新建${p.预览.新建}/跳过${p.预览.跳过} 执行 新建${w.新建}/跳过${w.跳过}\n${csv}`);
      }
    }
    expect(不一样, 不一样.join("\n---\n")).toEqual([]);
  });

  it("撤销之后再导一次：数和第一次一样", async () => {
    await prisma.customer.create({ data: { name: "老", phone: "01012345678", salesOwnerId: "tester-id", createdAt: 一天前 } });
    const csv = "姓名,手机号\n王经理,010-12345678 转 801\n前台,020-88886666\n李四,13800000002";
    const 一 = await 执行导入(方案(csv), "a.csv");
    if (!一.ok) throw new Error(一.error);
    const 撤 = await 撤销批次(一.batchId);
    expect(撤.ok).toBe(true);
    const p = await 预览导入(方案(csv));
    const 二 = await 执行导入(方案(csv), "a.csv");
    if (!二.ok || !p.ok) throw new Error("导不进");
    expect([二.新建, 二.跳过]).toEqual([一.新建, 一.跳过]);
    expect([p.预览.新建, p.预览.跳过]).toEqual([一.新建, 一.跳过]);
  });
});
