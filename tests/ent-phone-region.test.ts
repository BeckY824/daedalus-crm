/**
 * 企业版号码归属地（lib/enterprise/phone-region.ts + 查号码 回的 归属地，测试清单 B7）：
 * 国内手机号显示省、市、运营商；国外号显示国家；邮箱 / 微信 / 旺旺不查；号段表里没有的不猜。
 * 期望值是拿 scripts/make-phone-region.py 读的那份 phone.dat 另外逐条对过的。开关关着：查号码照旧回「没开」、不带归属地
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/sync/dedupe-client", async (原) => ({ ...(await 原<object>()), 问同事: async () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 查号码 } from "@/app/(app)/customers/number-actions";
import { 号码归属地, 国内归属地, 国外归属地 } from "@/lib/enterprise/phone-region";
import { 验号码 } from "@/lib/enterprise/contact-format";
import { invalidateSettingsCache } from "@/lib/settings";

describe("归属地（纯函数）", () => {
  it("国内手机号：省、市、运营商；直辖市只写一遍", () => {
    expect(国内归属地("18807551234")).toEqual({ 国内: true, 省: "广东", 市: "深圳", 运营商: "中国移动", 文字: "广东 深圳 中国移动" });
    expect(国内归属地("13000001234")).toMatchObject({ 省: "山东", 市: "济南", 运营商: "中国联通" });
    expect(国内归属地("17000001234")).toMatchObject({ 省: "北京", 市: "北京", 运营商: "中国电信", 文字: "北京 中国电信" });
    expect(国内归属地("19200001234")).toMatchObject({ 省: "广东", 市: "佛山", 运营商: "中国广电" });
    expect(国内归属地("13800138000")?.文字).toBe("北京 中国移动");
    expect(国内归属地("13900001234")?.文字).toBe("新疆 乌鲁木齐 中国移动");
  });

  it("号段表的头尾和空档：查不到就 null，不猜", () => {
    expect(国内归属地("13000011234")).toMatchObject({ 市: "常州" }); // 第一段后面紧挨的一段
    expect(国内归属地("14012121234")).toBeNull(); // 表里的空档
    expect(国内归属地("19900001234")).toBeNull(); // 还没放的号段
    expect(国内归属地("12999991234")).toBeNull(); // 表头之前
    expect(国内归属地("1880755123")).toBeNull(); // 位数不对
  });

  it("国外号：显示国家（日常叫法）", () => {
    expect(国外归属地("+447911123456")).toEqual({ 国内: false, 国家: "英国", 文字: "英国" });
    expect(国外归属地("+12025550123")?.国家).toBe("美国");
    expect(国外归属地("+81312345678")?.国家).toBe("日本");
    expect(国外归属地("+971501234567")?.国家).toBe("阿联酋");
    expect(国外归属地("+999123456789")).toBeNull(); // 没有这个国家码
  });

  it("只有手机号查：邮箱 / 微信 / 旺旺 / 二维码一律不查", () => {
    expect(号码归属地("手机号", "18807551234")?.文字).toBe("广东 深圳 中国移动");
    expect(号码归属地("手机号", "+447911123456")?.文字).toBe("英国");
    expect(号码归属地("邮箱", "18807551234@qq.com")).toBeNull();
    expect(号码归属地("微信", "wx18807551234")).toBeNull();
    expect(号码归属地("旺旺ID", "18807551234")).toBeNull();
    expect(号码归属地("二维码", "")).toBeNull();
  });

  it("接 验号码 规整过的值：+86、0044 这些写法都认", () => {
    const 国内 = 验号码("手机号", "+86 188-0755-1234");
    const 国外 = 验号码("手机号", "0044 7911 123456");
    expect(国内.ok && 号码归属地(国内.类型, 国内.值)?.文字).toBe("广东 深圳 中国移动");
    expect(国外.ok && 号码归属地(国外.类型, 国外.值)?.文字).toBe("英国");
  });
});

describe("查号码 带归属地", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    mocks.user = { ...mocks.user, id: (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id };
  });

  it("企业版开着：手机号回归属地，撞了也回；别的类型是 null", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "1");
    expect(await 查号码("手机号", "18807551234")).toMatchObject({ ok: true, 状态: "首次录入", 归属地: "广东 深圳 中国移动" });
    expect(await 查号码("手机号", "+44 7911 123456")).toMatchObject({ ok: true, 归属地: "英国" });
    await prisma.customer.create({ data: { name: "已有", phone: "18807551234", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: mocks.user.id } });
    expect(await 查号码("手机号", "18807551234")).toMatchObject({ ok: true, 状态: "我的通讯录已有", 归属地: "广东 深圳 中国移动" });
    expect(await 查号码("微信", "wx_18807551234")).toMatchObject({ ok: true, 归属地: null });
    expect(await 查号码("旺旺ID", "tb18807551234")).toMatchObject({ ok: true, 归属地: null });
  });

  it("开关关着照旧：查号码回「没开」，不带归属地", async () => {
    const r = await 查号码("手机号", "18807551234");
    expect(r).toEqual({ ok: false, 状态: "没开", 提示: "企业版才有号码类型" });
  });
});
