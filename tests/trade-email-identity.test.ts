/**
 * 外贸：没有电话、也没有 WhatsApp 的客户按邮箱认人（2026-10-07 用户拍板，lib/email-dedupe.ts）。
 * 小满导出里邮件开发来的客户常常只有邮箱，原来整行进不来、表单也存不了。
 * 钉的是：表单 / 导入 / 线索转客户三条路都收、都按邮箱查重（不分大小写），有电话的照旧只按电话认，通用模版不变。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user, requireAdmin: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { saveCustomer } from "@/app/(app)/customers/actions";
import { 执行导入, 预览导入, 撤销批次 } from "@/app/(app)/customers/import-actions";
import { convertLead, mergeLeadInto } from "@/app/(app)/leads/actions";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 摊开, 并重复行 } from "@/lib/import/plan";
import { 疑似重复 } from "@/lib/sync/dupes";

let jia: { id: string };
const 外贸配置 = BUSINESS_PRESETS["外贸出口"];

async function 外贸() {
  await setSetting("business", 外贸配置);
  invalidateSettingsCache();
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});
afterAll(async () => { await prisma.$disconnect(); });

const 基本 = { phone: "", school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, channelId: null, referrerCustomerId: null };
const 新建 = (name: string, extra: Record<string, string | null>, phone = "") => saveCustomer({ ...基本, name, phone, extra });

/** 照表单的发法：打开那一刻的整份值原样带回去，只改 patch 里那几项 */
async function 编辑(id: string, patch: Record<string, unknown>) {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = { name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major, followStatus: r.followStatus, decisionStatus: r.decisionStatus, expectedSignAt: r.expectedSignAt, remark: r.remark, salesOwnerId: r.salesOwnerId, channelId: r.channelId, referrerCustomerId: r.referrerCustomerId };
  return saveCustomer({ id, updatedAt: r.updatedAt.toISOString(), base, ...base, ...patch } as Parameters<typeof saveCustomer>[0]);
}

const 邮箱 = async (id: string) => (await prisma.customerExtra.findUnique({ where: { customerId: id } }))?.email;

describe("表单（saveCustomer）", () => {
  it("外贸：只填邮箱能存，电话空着；同一个邮箱（大小写、空格不同）再建一位被挡，说的是邮箱", async () => {
    await 外贸();
    const r = await 新建("Anna Becker", { email: "anna@brightsigns.de", country: "德国" });
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.id } })).phone).toBe("");
    expect(await 邮箱(r.id)).toBe("anna@brightsigns.de");
    const 再 = await 新建("Anna", { email: " Anna@BrightSigns.de " });
    expect(再.ok).toBe(false);
    expect(!再.ok && 再.error).toMatch(/邮箱 Anna@BrightSigns\.de 已存在（Anna Becker）/);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("外贸：电话、WhatsApp、邮箱都没有，说三样至少填一个", async () => {
    await 外贸();
    const r = await 新建("空的", {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("电话、WhatsApp、邮箱至少填一个（没有电话就用它认人）");
  });

  it("通用模版不变：只有邮箱照旧要电话", async () => {
    const r = await 新建("张三", { email: "z@x.com" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("请输入联系电话");
  });

  it("有电话的照旧只按电话认：同一公司两位联系人共用 info@ 都存得下；没电话的再用这个邮箱会撞上", async () => {
    await 外贸();
    expect((await 新建("A", { email: "info@acme.com" }, "+1 408 996 1010")).ok).toBe(true);
    expect((await 新建("B", { email: "info@acme.com" }, "+1 408 996 2020")).ok).toBe(true);
    const 没电话 = await 新建("C", { email: "INFO@acme.com" });
    expect(没电话.ok).toBe(false);
    expect(!没电话.ok && 没电话.error).toMatch(/邮箱 .* 已存在/);
  });

  it("按邮箱认的那位：改别的照常；邮箱不许清空；补上电话之后邮箱就能清了", async () => {
    await 外贸();
    const r = await 新建("Anna", { email: "anna@x.de" });
    if (!r.ok) throw new Error(r.error);
    expect((await 编辑(r.id, { remark: "要样品", extra: { email: "anna@x.de" } })).ok).toBe(true);
    // 没交 extra 的入口（别处调 saveCustomer）：当邮箱没动
    expect((await 编辑(r.id, { remark: "要样品 2" })).ok).toBe(true);
    const 清 = await 编辑(r.id, { extra: { email: null } });
    expect(清.ok).toBe(false);
    expect(!清.ok && 清.error).toMatch(/邮箱不能清空/);
    expect(await 邮箱(r.id)).toBe("anna@x.de");
    expect((await 编辑(r.id, { phone: "+49 30 1234567", extra: { email: null } })).ok).toBe(true);
    expect(await 邮箱(r.id)).toBeNull();
  });

  it("改邮箱撞上别人的被挡；邮箱没动的不查（老库里已经重了的两位照样能改备注）", async () => {
    await 外贸();
    const a = await 新建("A", { email: "a@x.de" });
    const b = await 新建("B", { email: "b@x.de" });
    if (!a.ok || !b.ok) throw new Error("建不出来");
    const 撞 = await 编辑(b.id, { extra: { email: "A@x.de" } });
    expect(撞.ok).toBe(false);
    // 老库里绕过查重已经重了：没动邮箱的保存不该被挡
    await prisma.customerExtra.update({ where: { customerId: b.id }, data: { email: "a@x.de" } });
    expect((await 编辑(b.id, { remark: "x", extra: { email: "a@x.de" } })).ok).toBe(true);
  });
});

describe("导入", () => {
  const 表头 = ["联系人昵称", "联系人邮箱", "国家地区", "联系人电话"];
  const 方案 = (数据: string[][], 重复行: "跳过" | "补空" = "跳过") => ({ 表头, 数据, 映射: 猜列(表头, 字段表(外贸配置)), 重复行 });

  it("只有邮箱的行进得来；再导一次（邮箱大小写不同）认得出、不另建；补空只补空的", async () => {
    await 外贸();
    const 一 = await 执行导入(方案([["Anna Becker", "anna@brightsigns.de", "", ""]]), "a.xlsx");
    if (!一.ok) throw new Error(一.error);
    expect(一.新建).toBe(1);
    const c = await prisma.customer.findFirstOrThrow({ where: { name: "Anna Becker" } });
    expect(c.phone).toBe("");
    expect(await 邮箱(c.id)).toBe("anna@brightsigns.de");

    const 看 = await 预览导入(方案([["Anna", "ANNA@brightsigns.de", "德国", ""]], "补空"));
    if (!看.ok) throw new Error(看.error);
    expect([看.预览.新建, 看.预览.已在库里]).toEqual([0, 1]);
    const 二 = await 执行导入(方案([["Anna", "ANNA@brightsigns.de", "德国", ""]], "补空"), "b.xlsx");
    if (!二.ok) throw new Error(二.error);
    expect([二.新建, 二.补空]).toEqual([0, 1]);
    expect(await prisma.customer.count()).toBe(1);
    const x = await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } });
    // 邮箱那格有值不动（还是原来的小写），国家空着补上
    expect([x.email, x.country]).toEqual(["anna@brightsigns.de", "德国"]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("Anna Becker");
  });

  it("没电话的行邮箱对上库里有电话的那位：就是他，补空不另建", async () => {
    await 外贸();
    const r = await 新建("Tim", { email: "tim@apple.com" }, "+1 800 275 2273");
    if (!r.ok) throw new Error(r.error);
    const w = await 执行导入(方案([["Tim Cook", "Tim@Apple.com", "美国", ""]], "补空"), "a.xlsx");
    if (!w.ok) throw new Error(w.error);
    expect([w.新建, w.补空]).toEqual([0, 1]);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("同一份表：同邮箱的两行合成一条；没电话那行和同邮箱有电话那行也合成一条（预览的数就是结果的数）", async () => {
    await 外贸();
    const 数据 = [
      ["Anna", "anna@x.de", "", ""],
      ["Anna B.", "Anna@x.de", "德国", ""],
      ["Tim", "tim@x.com", "", ""],
      ["Tim Cook", "tim@x.com", "美国", "+1 800 275 2273"],
    ];
    const 表 = 字段表(外贸配置);
    const { 行, 合掉几行 } = 并重复行(摊开({ 表头, 数据, 行号: [2, 3, 4, 5], 映射: 猜列(表头, 表), 字段表: 表 }));
    expect(合掉几行).toBe(2);
    expect(行.map((r) => r.值.name)).toEqual(["Anna", "Tim"]);
    expect(行[1].值.phone?.replace(/\D/g, "")).toBe("18002752273");
    const 看 = await 预览导入(方案(数据));
    if (!看.ok) throw new Error(看.error);
    expect(看.预览.新建).toBe(2);
    const w = await 执行导入(方案(数据), "a.xlsx");
    if (!w.ok) throw new Error(w.error);
    expect(w.新建).toBe(2);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("库里两位没电话的都是这个邮箱：说不清，谁也不动", async () => {
    await 外贸();
    for (const n of ["A", "B"]) await prisma.customer.create({ data: { name: n, phone: "", salesOwnerId: jia.id, extra: { create: { email: "dup@x.de" } } } });
    const 看 = await 预览导入(方案([["C", "dup@x.de", "德国", ""]], "补空"));
    if (!看.ok) throw new Error(看.error);
    expect(看.预览.说不清).toBe(1);
    expect(看.预览.挡下[0].原因).toMatch(/2 位都是这个邮箱/);
    const w = await 执行导入(方案([["C", "dup@x.de", "德国", ""]], "补空"), "a.xlsx");
    if (!w.ok) throw new Error(w.error);
    expect([w.新建, w.补空, w.跳过]).toEqual([0, 0, 1]);
  });

  it("按邮箱建的整批能撤销", async () => {
    await 外贸();
    const w = await 执行导入(方案([["Anna", "anna@x.de", "", ""]]), "a.xlsx");
    if (!w.ok) throw new Error(w.error);
    const 撤 = await 撤销批次(w.batchId);
    expect(撤.ok).toBe(true);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("三样都没有的照旧进不来，说清是三样都没有；通用模版只有邮箱照旧说没有手机号", async () => {
    await 外贸();
    const 表 = 字段表(外贸配置);
    const [r] = 摊开({ 表头, 数据: [["Nobody", "", "德国", ""]], 行号: [2], 映射: 猜列(表头, 表), 字段表: 表 });
    expect(r.进不了).toBe("这一行没有电话、WhatsApp，也没有邮箱");
    // 邮箱格式不对的不算有邮箱
    const [坏] = 摊开({ 表头, 数据: [["Bad", "not-an-email", "", ""]], 行号: [2], 映射: 猜列(表头, 表), 字段表: 表 });
    expect(坏.进不了).toBeTruthy();
    const 通用表 = 字段表(BUSINESS_PRESETS["通用销售"]);
    const 通用头 = ["姓名", "邮箱", "手机号"];
    const [通] = 摊开({ 表头: 通用头, 数据: [["张三", "z@x.com", ""]], 行号: [2], 映射: 猜列(通用头, 通用表), 字段表: 通用表 });
    expect(通.进不了).toBe("这一行没有手机号");
  });
});

describe("线索转客户", () => {
  it("外贸：没电话有邮箱的线索转得了；同邮箱的第二条线索撞上、能并过去", async () => {
    await 外贸();
    const l1 = await prisma.lead.create({ data: { name: "Bright Signs", contact: "Anna", email: "anna@x.de", source: "邮件开发", ownerId: jia.id } });
    const r = await convertLead(l1.id);
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.customerId } })).phone).toBe("");
    expect(await 邮箱(r.customerId)).toBe("anna@x.de");

    const l2 = await prisma.lead.create({ data: { name: "Bright Signs GmbH", email: "ANNA@x.de", ownerId: jia.id } });
    const 撞 = await convertLead(l2.id);
    expect(撞.ok).toBe(false);
    expect(!撞.ok && 撞.error).toMatch(/邮箱已经是.*的邮箱/);
    expect(!撞.ok && 撞.撞号?.能并).toBe(true);
    expect((await mergeLeadInto(l2.id, r.customerId)).ok).toBe(true);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("外贸：电话、邮箱都没有，说两样补一样；通用模版没电话照旧", async () => {
    await 外贸();
    const l = await prisma.lead.create({ data: { name: "x", ownerId: jia.id } });
    const r = await convertLead(l.id);
    expect(!r.ok && r.error).toBe("该线索没有电话也没有邮箱，请先补充一样再转化");
    await setSetting("business", BUSINESS_PRESETS["通用销售"]);
    invalidateSettingsCache();
    const l2 = await prisma.lead.create({ data: { name: "y", email: "y@x.com", ownerId: jia.id } });
    const r2 = await convertLead(l2.id);
    expect(!r2.ok && r2.error).toBe("该线索没有联系电话，请先补充后再转化");
  });
});

describe("团队同步后的疑似重复", () => {
  it("两位没电话、同邮箱的列出来；有电话的几位共用 info@ 不算", async () => {
    for (const n of ["A", "B"]) await prisma.customer.create({ data: { name: n, phone: "", salesOwnerId: jia.id, extra: { create: { email: n === "A" ? "anna@x.de" : "Anna@X.de" } } } });
    for (const [n, p] of [["C", "14089961010"], ["D", "14089962020"]]) await prisma.customer.create({ data: { name: n, phone: p, salesOwnerId: jia.id, extra: { create: { email: "info@acme.com" } } } });
    const 组 = await 疑似重复();
    expect(组.map((g) => [g.依据, g.记录.map((r) => r.name)])).toEqual([["邮箱 anna@x.de", ["A", "B"]]]);
  });
});
