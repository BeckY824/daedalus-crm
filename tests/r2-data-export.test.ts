/**
 * 二轮排查（r2-data）· 导出。
 *
 * 筛选后导出全部（不是当前一页）、上万行、公式注入防护、中文 / 逗号 / 换行 / 引号。
 * 导出的取数是 customers/export-action.ts 的 导出客户()，拼文件是 lib/csv.ts 的 toCsv()——两样都在这里打。
 * 列表页上那段 exportCsv（拼表头、文件名）是组件内部函数，没法单测，问题写在报告里（代码审读）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人 } from "./r2-data-helpers";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { toCsv, csvCell, BOM } from "@/lib/csv";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 认枚举 } from "@/lib/import/plan";
import { 规整手机号 } from "@/lib/phone";
import { DEFAULT_BUSINESS, statusLabel } from "@/lib/business-config";
import { FOLLOW_STATUSES } from "@/lib/constants";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

async function 灌(n: number, 生成: (i: number) => Record<string, unknown> = () => ({})) {
  const 批 = 2000;
  for (let s = 0; s < n; s += 批) {
    await prisma.customer.createMany({
      data: Array.from({ length: Math.min(批, n - s) }, (_, k) => {
        const i = s + k;
        return { name: `客户${i}`, phone: `135${String(i).padStart(8, "0")}`, salesOwnerId: 我, ...生成(i) };
      }),
    });
  }
}

describe("筛选后导出全部", () => {
  it("按跟进状态筛：导出的是筛出来的全部 45 条，不是当前一页的 20 条", async () => {
    await 灌(100, (i) => ({ followStatus: i % 2 ? "跟进中" : "待跟进", school: i < 45 ? "远山" : null }));
    const r = await 导出客户({ followStatus: "跟进中" });
    if (!r.ok) throw new Error(r.error);
    expect(r.rows).toHaveLength(50);
    const r2 = await 导出客户({ keyword: "远山" });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.rows).toHaveLength(45);
    expect(r2.截断了).toBe(false);
  });

  it("本月新增：和列表同一个口径", async () => {
    await 灌(3);
    await prisma.customer.updateMany({ where: { name: "客户0" }, data: { createdAt: new Date(2020, 0, 1) } });
    const r = await 导出客户({ createdWithin: "本月" });
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.name).sort()).toEqual(["客户1", "客户2"]);
  });

  it("桌面端（非共享区）导出的号码是原号、不打码", async () => {
    await 灌(1);
    const r = await 导出客户({});
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].phone).toBe("13500000000");
  });
});

describe("上万行", () => {
  it("12000 行全导；超过 20000 行导前 20000 并标出截断", async () => {
    await 灌(12000);
    const t0 = Date.now();
    const r = await 导出客户({});
    const 用时 = Date.now() - t0;
    if (!r.ok) throw new Error(r.error);
    expect([r.rows.length, r.截断了]).toEqual([12000, false]);
    expect(用时, `12000 行取数用了 ${用时} ms`).toBeLessThan(15000);
    const csv = toCsv(["姓名", "手机号"], r.rows.map((x) => [x.name, x.phone]));
    expect(csv.split("\r\n")).toHaveLength(12001);

    await prisma.customer.createMany({ data: Array.from({ length: 8001 }, (_, i) => ({ name: `补${i}`, phone: `134${String(i).padStart(8, "0")}`, salesOwnerId: 我 })) });
    const r2 = await 导出客户({});
    if (!r2.ok) throw new Error(r2.error);
    expect([r2.rows.length, r2.截断了]).toEqual([20000, true]);
  }, 120_000);
});

describe("CSV 本身：公式注入、中文、逗号、换行、引号", () => {
  it("以 = + - @ 制表符 回车 开头的格子前面加单引号", () => {
    for (const v of ["=1+1", "+1-2", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\",\"点我\")"]) {
      expect(csvCell(v).startsWith(`"'`), v).toBe(true);
    }
    expect(csvCell("王强")).toBe('"王强"');
  });

  it("【C】前面带空格 / 全角等号的「公式」：Excel 不会执行全角，但前导空格 + = 在部分表格软件里会被算（记录现状，不加前缀）", () => {
    expect(csvCell(" =1+1")).toBe('" =1+1"');
    expect(csvCell("＝1+1")).toBe('"＝1+1"');
  });

  it("中文、逗号、换行、引号、表情：写出去再按导入那条管线读回来，一字不差", () => {
    const 怪 = ['王强,"老王"', "第一行\n第二行", "😀表情", "逗号，全角", "a\r\nb"];
    const csv = toCsv(["备注"], 怪.map((v) => [v]));
    expect(csv.startsWith(BOM)).toBe(true);
    const 回来 = 成表(解析CSV(csv)).数据.map((r) => r[0]);
    expect(回来).toEqual(怪.map((v) => v.trim()));
  });

  it("海外号码 +1… 导出时被加了单引号；再导回来认得出是同一个号", () => {
    const csv = toCsv(["手机号"], [["+14155550123"]]);
    const 回来 = 成表(解析CSV(csv)).数据[0][0];
    expect(回来).toBe("'+14155550123");
    expect(规整手机号(回来)).toBe("+14155550123");
  });

  it.skip("【下一版】【已知 6-X8】导出的跟进状态写显示名（已演示），导回来认不出、落成默认值", () => {
    const 显示名 = statusLabel(DEFAULT_BUSINESS, "已试听");
    expect(显示名).toBe("已演示");
    expect(认枚举(显示名, FOLLOW_STATUSES), "导出→导入一圈，状态丢了").toBe("已试听");
  });
});
