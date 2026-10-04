/**
 * 带分机的号码查重（第三轮 B4 → 第四轮 B3/B4/B5，规矩见 lib/phone-dedupe）。
 * 分机现在留在号码里（「01012345678转801」），0.46.15 之前的老记录存的是主号「01012345678」。
 * 主号只认「分机开始留着」那一刻之前建的记录；之后新录的总机是另一个人。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u-dd", name: "甲", email: "a@x", role: "ADMIN", title: "" }) }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { checkDuplicate } from "@/app/(app)/customers/actions";
import { 认人表, 记下分机留存起, 分机留存起 } from "@/lib/phone-dedupe";

const 一天前 = new Date(Date.now() - 86400_000);

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: "u-dd", email: "a@x", name: "甲", role: "ADMIN", password: "x" } });
  // 老版本建的：分机被丢了，只剩主号
  await prisma.customer.create({ data: { name: "老张", phone: "01012345678", salesOwnerId: "u-dd", createdAt: 一天前 } });
  await prisma.customer.create({ data: { name: "小李", phone: "07551234567转802", salesOwnerId: "u-dd" } });
  // 升级后第一次打开：记下这一刻
  await 记下分机留存起();
});
afterAll(async () => { await prisma.$disconnect(); });

describe("表单查重", () => {
  it("老库里存主号，新写法带分机：认得出", async () => {
    expect((await checkDuplicate("010-12345678 转 801"))?.name).toBe("老张");
    expect((await checkDuplicate("010-12345678 ext. 801"))?.name).toBe("老张");
  });
  it("同一个总机、分机不同：不算同一个人", async () => {
    expect(await checkDuplicate("0755-1234567 转 803")).toBeNull();
    expect((await checkDuplicate("0755-1234567 转 802"))?.name).toBe("小李");
  });
  it("升级之后新录的总机（前台）不挡同一总机下带分机的人（第四轮 B5）", async () => {
    await prisma.customer.create({ data: { name: "前台", phone: "02088886666", salesOwnerId: "u-dd" } });
    expect(await checkDuplicate("020-88886666 转 802")).toBeNull();
    expect((await checkDuplicate("020-88886666"))?.name).toBe("前台");
  });
  it("没记下时间点的库：只按整串比，主号不认", async () => {
    await prisma.setting.deleteMany();
    invalidateSettingsCache();
    expect(await 分机留存起()).toBeNull();
    expect(await checkDuplicate("010-12345678 转 801")).toBeNull();
  });
  it("只记一次：再调不会把时间点往后挪", async () => {
    const 第一次 = await 分机留存起();
    await new Promise((r) => setTimeout(r, 5));
    await 记下分机留存起();
    expect((await 分机留存起())?.getTime()).toBe(第一次?.getTime());
  });
});

describe("导入认人表", () => {
  const 起 = new Date();
  const 老 = { phone: "01012345678", createdAt: 一天前, name: "老张" };
  it("两位分机不同的人都认到同一位老客户：都算说不清（第四轮 B4）", () => {
    const 表 = 认人表([老], ["01012345678转801", "01012345678转802"], 起);
    expect(表.认("01012345678转801").n).toBe(2);
    expect(表.认("01012345678转802").n).toBe(2);
  });
  it("只有一位：认到老客户", () => {
    expect(认人表([老], ["01012345678转801"], 起).认("01012345678转801").旧?.name).toBe("老张");
  });
  it("这一批里刚建的总机不会把后一行带分机的认成他（第四轮 B3）", () => {
    const 表 = 认人表<{ phone: string; createdAt: Date; name: string }>([], ["01099990000", "01099990000转802"], 起);
    表.记下({ phone: "01099990000", createdAt: new Date(), name: "前台" });
    expect(表.认("01099990000转802").n).toBe(0);
  });
  it("设置里存的值不是数字：当没记过", async () => {
    await setSetting("phone.extKeptSince", "坏的");
    expect(await 分机留存起()).toBeNull();
  });
});

/*
  2026-10-04（回归核对 H-017）：这一步在 (app)/layout 里每次进页面都调。库锁着 / 磁盘满时 setSetting 一抛，
  原来整个应用一页都打不开。现在吞掉、下次再试
*/
describe("记分机留存起点写不进去", () => {
  it("setSetting 抛错：不往外抛（layout 照常渲染），下次能写进去时再记", async () => {
    await prisma.setting.deleteMany({ where: { key: { contains: "extKeptSince" } } });
    invalidateSettingsCache();
    const 设置 = await import("@/lib/settings");
    const 坏 = vi.spyOn(设置, "setSetting").mockRejectedValueOnce(new Error("database is locked"));
    const 静音 = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(记下分机留存起()).resolves.toBeUndefined();
    坏.mockRestore();
    静音.mockRestore();
    invalidateSettingsCache();
    await 记下分机留存起();
    expect(await 分机留存起()).not.toBeNull();
  });
});
