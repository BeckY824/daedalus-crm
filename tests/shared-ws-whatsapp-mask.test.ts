/**
 * 网页共享试用区：WhatsApp 也是号码，每个出口都和电话一样打码（2026-10-06 测试分期 G.1）。
 *
 * 打码的代码各出口都有（lib/shared-ws/current.ts 的 号码脱敏器），之前只有操作日志那一处有用例钉着。
 * 这里把共享区打开，一次查完：客户列表 / 导出（同一个 成客户行）、导出第二张跟进表、AI 读客户、AI 找客户、
 * WhatsApp 链接（打过码的不给 wa.me，剩下几位拼出来是个陌生号）、编辑框交回打码值时库里不变。
 *
 * 跟进正文里人自己写进去的号码不在这里：正文整个产品都原样显示（客户页时间线也是），只有操作日志例外（SettingsBody）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user, requireAdmin: async () => mocks.user }));
vi.mock("@/lib/shared-ws/current", async () => {
  const { maskPhone } = await import("@/lib/utils");
  return {
    当前是共享区: async () => true,
    号码脱敏器: async () => <T extends string | null>(p: T): T => (p ? (maskPhone(p) as T) : p),
  };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { saveCustomer } from "@/app/(app)/customers/actions";
import { TOOLS } from "@/lib/agent/tools";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { WhatsApp网址 } from "@/lib/customer-extra";

const 全号 = "+971 50 123 4567";
const 数字 = "971501234567";
let 客户id = "";

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await setSetting("business", BUSINESS_PRESETS["外贸出口"]);
  invalidateSettingsCache();
  const u = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { ...mocks.user, id: u.id };
  const c = await prisma.customer.create({ data: { name: "Ahmed", phone: "971509998888", salesOwnerId: u.id } });
  await prisma.customerExtra.create({ data: { customerId: c.id, whatsapp: 全号, country: "阿联酋" } });
  await prisma.followUp.create({ data: { customerId: c.id, ownerId: u.id, type: "CALL", title: "电话", content: "他说下周发样品清单", status: "已完成", occurredAt: new Date() } });
  客户id = c.id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const 露了 = (s: string) => s.replace(/\D/g, "").includes(数字) || s.includes(全号);

describe("共享试用区：WhatsApp 每个出口都打码", () => {
  it("客户列表 / 导出第一张表：WhatsApp 打了码，电话也打了码", async () => {
    const r = await 导出客户({});
    if (!r.ok) throw new Error(r.error);
    expect(r.rows[0].extra.whatsapp).toContain("*");
    expect(露了(JSON.stringify(r.rows)), "导出 / 列表里露了全号").toBe(false);
    expect(r.rows[0].phone).toContain("*");
  });

  it("AI 读客户、找客户：交给模型的 WhatsApp 是打过码的", async () => {
    const ctx = { userId: mocks.user.id, userName: "甲", b: BUSINESS_PRESETS["外贸出口"], recordOffset: 0, proposals: [], 号: await 号码脱敏器() };
    const 读 = await TOOLS.find((t) => t.name === "get_customer")!.run({ id: 客户id }, ctx as never);
    const 串 = JSON.stringify(读.data);
    const 位置 = 串.indexOf("123 4567") >= 0 ? 串.indexOf("123 4567") : 串.replace(/\s/g, "").indexOf("4567");
    expect(露了(串), `get_customer 露了全号：…${串.slice(Math.max(0, 位置 - 80), 位置 + 20)}…`).toBe(false);
    expect(JSON.stringify(读.data)).toContain("WhatsApp");
    const 找 = await TOOLS.find((t) => t.name === "search_customers")!.run({ query: "Ahmed" }, ctx as never);
    expect(露了(JSON.stringify(找.data)), "search_customers 露了全号").toBe(false);
  });

  it("打过码的号不给 wa.me 链接（剩下的几位拼出来是个陌生号）", async () => {
    const 号 = await 号码脱敏器();
    expect(WhatsApp网址(号(全号))).toBeNull();
    expect(WhatsApp网址(全号)).toBe(`https://wa.me/${数字}`);
  });

  it("编辑框交回打码的 WhatsApp（人没动那一格）：库里原号不变", async () => {
    const 号 = await 号码脱敏器();
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: 客户id } });
    const r = await saveCustomer({
      id: 客户id, name: "Ahmed 改名", phone: 号(c.phone), school: null, grade: null, major: null, followStatus: c.followStatus, decisionStatus: c.decisionStatus,
      expectedSignAt: null, remark: null, salesOwnerId: c.salesOwnerId, channelId: null, referrerCustomerId: null, updatedAt: c.updatedAt.toISOString(),
      extra: { whatsapp: 号(全号), country: "阿联酋" },
    } as never);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const 后 = await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: 客户id } });
    expect(后.whatsapp).toBe(全号);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户id } })).phone).toBe("971509998888");
  });
});
