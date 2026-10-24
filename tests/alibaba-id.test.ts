/**
 * 阿里国际站 ID（2026-10-21 客户反馈：「有些没有给联系方式，但是有国际站的 ID。能不能添加一个选项，能填这个 ID」）。
 * 存在 CustomerExtra.alibabaId（迁移 040）。钉的是总控给的验收：
 *   - 外贸：电话 / WhatsApp / 邮箱 / 微信都没有、只有阿里 ID 也能建；按它查重（不分大小写，「Buyer ID:」前缀去掉）；不许清空
 *   - 有电话的照旧只按电话认：两位联系人留了同一个阿里 ID 不挡
 *   - 通用模版不收这一格：电话照旧必填
 *   - Excel 导入认「阿里 ID / 国际站 ID / Alibaba ID / Buyer ID」这类表头；只有阿里 ID 的行进得来，再导一次认出是同一位
 *   - 团队：问同事用「alibaba」这一种（服务端只见哈希）；手机新建也收、也挡
 * 和老版本客户端同步（最要紧的一条）在 tests/alibaba-id-sync.test.ts。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
  问同事: vi.fn(async (..._: unknown[]): Promise<{ 同事: string; 客户名: string; k: string } | null> => null),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user, requireAdmin: async () => mocks.user }));
vi.mock("@/lib/sync/dedupe-client", async (原) => ({ ...(await 原<object>()), 问同事: mocks.问同事 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { saveCustomer, patchCustomer } from "@/app/(app)/customers/actions";
import { 执行导入, 预览导入 } from "@/app/(app)/customers/import-actions";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 摊开, 并重复行 } from "@/lib/import/plan";
import { 规整阿里ID, 外贸键 } from "@/lib/customer-extra";
import { 客户查重值, 查重键 } from "@/lib/sync/dedupe";
import { 客户导出表 } from "@/app/(app)/customers/export-table";
import * as 手机 from "@/lib/mobile/sync";
import * as 电脑密 from "@/lib/sync/crypto";
import { 客户们, 分表 } from "@/lib/mobile/view";

const 外贸配置 = BUSINESS_PRESETS["外贸出口"];
async function 外贸() {
  await setSetting("business", 外贸配置);
  invalidateSettingsCache();
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  mocks.问同事.mockReset();
  mocks.问同事.mockResolvedValue(null);
  const jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});
afterAll(async () => { await prisma.$disconnect(); });

const 基本 = { phone: "", school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, channelId: null, referrerCustomerId: null };
const 新建 = (name: string, extra: Record<string, string | null>, phone = "") => saveCustomer({ ...基本, name, phone, extra });
const 阿里 = async (id: string) => (await prisma.customerExtra.findUnique({ where: { customerId: id } }))?.alibabaId;

async function 编辑(id: string, patch: Record<string, unknown>) {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = { name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major, followStatus: r.followStatus, decisionStatus: r.decisionStatus, expectedSignAt: r.expectedSignAt, remark: r.remark, salesOwnerId: r.salesOwnerId, channelId: r.channelId, referrerCustomerId: r.referrerCustomerId };
  return saveCustomer({ id, updatedAt: r.updatedAt.toISOString(), base, ...base, ...patch } as Parameters<typeof saveCustomer>[0]);
}

describe("规整", () => {
  it("去首尾空格；贴进来带「Buyer ID:」「阿里 ID：」前缀的去掉；空的当没填", () => {
    expect(规整阿里ID("  us1234567890abcd ")).toEqual({ ok: true, v: "us1234567890abcd" });
    expect(规整阿里ID("Buyer ID: us123")).toEqual({ ok: true, v: "us123" });
    expect(规整阿里ID("阿里 ID：cn1520abc")).toEqual({ ok: true, v: "cn1520abc" });
    expect(规整阿里ID("   ")).toEqual({ ok: true, v: null });
    expect(外贸键).toContain("alibabaId");
  });
});

describe("表单（saveCustomer）", () => {
  it("外贸：只填阿里 ID 能存，电话空着；同一个阿里 ID（大小写、前缀不同）再建一位被挡，说的是阿里 ID", async () => {
    await 外贸();
    const r = await 新建("Mohammed", { alibabaId: "ae1029384756xyz", country: "阿联酋" });
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.id } })).phone).toBe("");
    expect(await 阿里(r.id)).toBe("ae1029384756xyz");
    const 再 = await 新建("Mohammed A.", { alibabaId: "Buyer ID: AE1029384756XYZ" });
    expect(再.ok).toBe(false);
    expect(!再.ok && 再.error).toMatch(/阿里 ID ae1029384756xyz/i);
    expect(!再.ok && 再.error).toMatch(/Mohammed/);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("什么都没有照旧挡，说五样至少填一个", async () => {
    await 外贸();
    const r = await 新建("空的", { alibabaId: "  " });
    expect(!r.ok && r.error).toBe("电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个（没有电话就用它认人）");
  });

  it("有电话的只按电话认：两位联系人留了同一个阿里 ID 不挡", async () => {
    await 外贸();
    expect((await 新建("A", { alibabaId: "us001" }, "13900009101")).ok).toBe(true);
    expect((await 新建("B", { alibabaId: "us001" }, "13900009102")).ok).toBe(true);
  });

  it("按阿里 ID 认的那位不许把它清空；补上电话以后就能清", async () => {
    await 外贸();
    const r = await 新建("Li", { alibabaId: "cn777" });
    if (!r.ok) throw new Error(r.error);
    const 清 = await 编辑(r.id, { extra: { alibabaId: "" } });
    expect(!清.ok && 清.error).toMatch(/按阿里 ID 认的：阿里 ID 不能清空/);
    expect(await 阿里(r.id)).toBe("cn777");
    const 补 = await 编辑(r.id, { phone: "+44 7700 900123", extra: { alibabaId: "" } });
    expect(补.ok).toBe(true);
    expect(await 阿里(r.id)).toBeNull();
  });

  it("团队：本机没撞的再问服务端，种类是 alibaba；撞到同事名下的照现有规矩那句话挡下", async () => {
    await 外贸();
    mocks.问同事.mockResolvedValueOnce({ 同事: "赵业务", 客户名: "Globex", k: "c_other" });
    const r = await 新建("Globex 2", { alibabaId: "de555" });
    expect(mocks.问同事).toHaveBeenCalledWith("alibaba", "de555", undefined);
    expect(!r.ok && r.error).toBe("阿里 ID de555 已是同事 赵业务 名下的客户（Globex），请勿重复录入；要接手请找 赵业务 或老板");
    expect(await prisma.customer.count()).toBe(0);
  });

  it("记录页单格改阿里 ID：写进去、留痕叫「阿里国际站 ID」", async () => {
    await 外贸();
    const r = await 新建("Acme", {}, "13900009103");
    if (!r.ok) throw new Error(r.error);
    expect((await patchCustomer(r.id, "alibabaId", " us9 ")).ok).toBe(true);
    expect(await 阿里(r.id)).toBe("us9");
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: "update" } })).summary).toMatch(/阿里国际站 ID/);
  });

  it("通用模版：这一格不算联系方式，电话照旧必填", async () => {
    const r = await 新建("张三", { alibabaId: "cn1" });
    expect(r.ok).toBe(false);
    expect(await prisma.customer.count()).toBe(0);
  });
});

describe("导入", () => {
  it("认得这些表头：阿里 ID / 国际站 ID / 阿里国际站 ID / Alibaba ID / Buyer ID / 国际站买家ID", () => {
    const 表 = 字段表(外贸配置);
    for (const 头 of ["阿里 ID", "国际站ID", "阿里国际站 ID", "Alibaba ID", "Buyer ID", "buyer_id", "国际站买家ID", "阿里巴巴ID"]) {
      expect(猜列(["姓名", 头], 表)[1], 头).toBe("alibabaId");
    }
    // 通用模版没有这一格
    expect(猜列(["姓名", "阿里 ID"], 字段表(BUSINESS_PRESETS["通用销售"]))[1]).not.toBe("alibabaId");
  });

  it("只有阿里 ID 的行进得来；同一份表里同一个阿里 ID 的两行合成一位；什么都没有的说清是五样都没有", () => {
    const 表 = 字段表(外贸配置);
    const 表头 = ["姓名", "国家", "Buyer ID"];
    const 数据 = [["Ali", "阿联酋", "ae01"], ["Ali H.", "", "AE01"], ["无名", "美国", ""]];
    const rows = 摊开({ 表头, 数据, 行号: [2, 3, 4], 映射: 猜列(表头, 表), 字段表: 表 });
    expect(rows[0].进不了).toBeUndefined();
    expect(rows[2].进不了).toBe("这一行没有电话、WhatsApp、邮箱、微信，也没有阿里 ID");
    const { 行, 合掉几行 } = 并重复行(rows);
    expect(合掉几行).toBe(1);
    expect(行.filter((r) => !r.进不了)).toHaveLength(1);
  });

  it("落库：建出来、阿里 ID 在档案里；同一个阿里 ID 再导一次认出是同一位，跳过不另建", async () => {
    await 外贸();
    const 表头 = ["姓名", "阿里国际站ID", "国家"];
    const 方案 = (数据: string[][]) => ({ 表头, 数据, 映射: 猜列(表头, 字段表(外贸配置)), 重复行: "跳过" as const });
    const 一 = await 执行导入(方案([["Hassan", "eg123", "埃及"]]), "a.xlsx");
    if (!一.ok) throw new Error(一.error);
    expect(一.新建).toBe(1);
    const c = await prisma.customer.findFirstOrThrow({ include: { extra: true } });
    expect(c.phone).toBe("");
    expect(c.extra?.alibabaId).toBe("eg123");
    const 看 = await 预览导入(方案([["Hassan B", "EG123", ""]]));
    if (!看.ok) throw new Error(看.error);
    expect([看.预览.新建, 看.预览.已在库里]).toEqual([0, 1]);
    const 二 = await 执行导入(方案([["Hassan B", "EG123", ""]]), "b.xlsx");
    if (!二.ok) throw new Error(二.error);
    expect([二.新建, 二.跳过]).toEqual([0, 1]);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("导出（外贸）带这一列，表头和导入认的一致，导回来落回同一格", () => {
    const { head, body } = 客户导出表([{ id: "x", name: "A", phone: "", school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", signedAmount: 0, salesOwnerName: "甲", remark: null, extra: { country: null, whatsapp: null, wechat: null, email: null, source: null, level: null, website: null, alibabaId: "us42" } } as never], 外贸配置);
    const 列 = head.indexOf("阿里国际站 ID");
    expect(列).toBeGreaterThan(0);
    expect(body[0][列]).toBe("us42");
    expect(猜列(head, 字段表(外贸配置))[列]).toBe("alibabaId");
  });
});

describe("团队查重索引", () => {
  it("一位客户报上去的几样里有阿里 ID（不分大小写），和电话、微信分开", () => {
    expect(客户查重值({ phone: "", email: "", wechat: "", alibaba: "US001" })).toEqual([{ 种: "alibaba", 键: "us001" }]);
    expect(客户查重值({ phone: "13900009100", alibaba: "us001" }).map((x) => x.种)).toEqual(["phone", "alibaba"]);
    expect(查重键("alibaba", " AbC ")).toBe("abc");
  });
});

describe("手机新建客户", () => {
  const 钥 = 电脑密.新钥匙();
  const 机 = { teamId: "t1", device: "m_phone", key: 钥, epoch: 0, keys: { "0": 钥 }, userId: "acct_li", 私钥: new Uint8Array() } as unknown as 手机.手机团队;
  const 钟 = { 钟: { name: "x" } };
  async function 新手机() {
    const 库 = new 手机.内存库();
    const 状态 = 手机.新状态();
    await 库.放({ t: "User", k: "acct_li", r: { id: "acct_li", name: "李娜" }, ...钟 });
    await 库.放({ t: "User", k: "acct_zhao", r: { id: "acct_zhao", name: "赵业务" }, ...钟 });
    await 库.放({ t: "Setting", k: "business", r: { key: "business", value: JSON.stringify({ template: "trade", currency: "USD" }) }, ...钟 });
    return { 库, 状态 };
  }

  it("只填阿里 ID 能建，进档案；手机上已有同一个阿里 ID 的挡下", async () => {
    const { 库, 状态 } = await 新手机();
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "Buyer ID: SA88" });
    expect((await 库.取("Customer", id))?.r).toMatchObject({ phone: "" });
    expect((await 库.取("CustomerExtra", id))?.r).toMatchObject({ alibabaId: "SA88", email: null, wechat: null });
    await expect(手机.新建客户(机, 库, 状态, { name: "Omar 2", alibabaId: "sa88" })).rejects.toThrow("阿里 ID sa88 已经有了：Omar");
  });

  it("联网时问服务端：同事名下的同一个阿里 ID 挡下，问的哈希就是 alibaba 那一种", async () => {
    const { 库, 状态 } = await 新手机();
    const 问过: unknown[] = [];
    const 云 = (async (_m: string, _p: string, body: { action: string; hashes?: string[] }) => {
      问过.push(body);
      return { 状态: 200, json: body.action === "dedupe-find" ? { hits: [{ k: "c_zhao", owner: "acct_zhao", label: "坏的" }] } : {} };
    }) as unknown as Parameters<typeof 手机.新建客户>[5];
    await expect(手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "sa99" }, Date.now(), 云)).rejects.toThrow("阿里 ID sa99 已是同事 赵业务 名下的客户");
    const 期望 = 电脑密.查重哈希(钥, `dedupe-v1|t1|alibaba|sa99`);
    expect(问过).toEqual([expect.objectContaining({ action: "dedupe-find", hashes: [期望] })]);
    expect(状态.待推).toEqual([]);
  });

  it("团队分了两个一级部门：别部门的命中带部门名；部门名超长不认", async () => {
    const { 库, 状态 } = await 新手机();
    let dept = "外贸";
    const 云 = (async (_m: string, _p: string, body: { action: string }) =>
      ({ 状态: 200, json: body.action === "dedupe-find" ? { hits: [{ k: "c_zhao", owner: "acct_zhao", label: "坏的", dept }] } : {} })) as unknown as Parameters<typeof 手机.新建客户>[5];
    await expect(手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "sa98" }, Date.now(), 云)).rejects.toThrow("阿里 ID sa98 已是同事 外贸 · 赵业务 名下的客户");
    dept = "长".repeat(101);
    await expect(手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "sa98" }, Date.now(), 云)).rejects.toThrow("阿里 ID sa98 已是同事 赵业务 名下的客户");
  });

  it("手机客户详情带出阿里 ID", async () => {
    const { 库, 状态 } = await 新手机();
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "sa1", email: "o@x.co" });
    const 行们 = [];
    for (const key of await 库.键们()) {
      const [表, k] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const x = await 库.取(表, k);
      if (x) 行们.push(x);
    }
    expect(客户们(分表(行们), "acct_li", new Set()).find((c) => c.id === id)?.alibabaId).toBe("sa1");
  });
});
