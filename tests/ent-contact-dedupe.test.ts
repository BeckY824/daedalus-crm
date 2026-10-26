/**
 * 企业版建档的全公司号码查重（lib/enterprise/contact-dedupe.ts + customers/number-actions.ts 查号码 +
 * saveCustomer 的 企业号码，测试清单 B5 / B8）：不分谁名下、客户上和联系人上都比；撞到好几条认首条（建档最早）；
 * 旺旺 ID 记进联系方式子表 ContactMethod、换个大小写空格也撞。开关关着：没有号码类型、保存不认 企业号码、查重照旧
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
import { saveCustomer, checkDuplicate, type CustomerInput } from "@/app/(app)/customers/actions";
import { 查号码 } from "@/app/(app)/customers/number-actions";
import { 全公司查号, 撞号结论 } from "@/lib/enterprise/contact-dedupe";
import { 查重提示 } from "@/lib/enterprise/contact-format";
import { invalidateSettingsCache } from "@/lib/settings";

let 甲: string;
let 乙: string;

const 客户 = (补: Partial<CustomerInput> = {}): CustomerInput => ({
  name: "新客户", phone: "", school: null, grade: null, major: null,
  followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null,
  salesOwnerId: 甲, channelId: null, referrerCustomerId: null, ...补,
});
const 建 = (name: string, salesOwnerId: string, 补: Record<string, unknown> = {}) =>
  prisma.customer.create({ data: { name, phone: "", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId, ...补 } });
const 当 = (id: string) => { mocks.user = { ...mocks.user, id }; };

afterEach(() => { vi.unstubAllEnvs(); });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "", role: "SALES", password: "x" } })).id;
  当(甲);
});

describe("企业版开着", () => {
  beforeEach(() => { vi.stubEnv("CRM_ENTERPRISE", "1"); });

  it("首次录入：全公司都没有", async () => {
    expect(await 查号码("手机号", "+86 139 0000 0101")).toMatchObject({ ok: true, 状态: "首次录入", 提示: 查重提示.首次录入, 值: "13900000101" });
  });

  it("格式不对当场说，不去查", async () => {
    expect(await 查号码("手机号", "1390000")).toMatchObject({ ok: false, 状态: "格式错误", 提示: "⚠️手机号格式错误" });
    expect(await 查号码("旺旺ID", "***")).toMatchObject({ ok: false, 状态: "无法识别" });
    expect(await 查号码("", "13900000101")).toMatchObject({ ok: false, 状态: "未选类型" });
  });

  it("撞到别人名下的：号码重复，可与 负责人 沟通核实（客户电话写法不同也撞）", async () => {
    await 建("乙的客户", 乙, { phone: "+86 13900000101" });
    expect(await 查号码("手机号", "13900000101")).toMatchObject({ ok: true, 状态: "重复", 提示: "⛔号码重复，可与 乙 沟通核实", 撞: { salesOwnerName: "乙" } });
  });

  it("撞到我名下的：我的通讯录已有；在公海的：公海待捞", async () => {
    const 我的 = await 建("甲的客户", 甲, { phone: "13900000101" });
    expect(await 查号码("手机号", "13900000101")).toMatchObject({ 状态: "我的通讯录已有", 提示: 查重提示.我的通讯录已有 });
    await prisma.customerPool.create({ data: { customerId: 我的.id } });
    expect(await 查号码("手机号", "13900000101")).toMatchObject({ 状态: "公海待捞", 提示: 查重提示.公海待捞 });
  });

  it("联系人上的电话 / 邮箱 / 微信也比（不分大小写）", async () => {
    const c = await 建("乙的客户", 乙);
    await prisma.contact.create({ data: { customerId: c.id, name: "王经理", phone: "139-0000-0102", email: "Wang@Corp.com", wechat: "WangLi_88" } });
    expect(await 查号码("手机号", "+8613900000102")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("邮箱", "wang@corp.COM")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("微信", "wangli_88")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("微信", "wangli_99")).toMatchObject({ 状态: "首次录入" });
  });

  it("客户档案上的邮箱 / 微信（CustomerExtra）也比", async () => {
    const c = await 建("乙的客户", 乙);
    await prisma.customerExtra.create({ data: { customerId: c.id, email: "boss@corp.com", wechat: "bossWx01" } });
    expect(await 查号码("邮箱", "BOSS@corp.com")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("微信", "bosswx01")).toMatchObject({ 状态: "重复" });
  });

  it("看不到的那位：只说负责人，不给 id / 名字", async () => {
    const c = await 建("乙的客户", 乙, { phone: "13900000101" });
    const r = await 撞号结论(prisma, [c.id], 甲, 甲);
    expect(r).toMatchObject({ 状态: "重复", 撞: { id: null, name: null, school: null, createdAt: null, salesOwnerName: "乙" } });
    expect((await 撞号结论(prisma, [c.id], 甲, null)).撞).toMatchObject({ id: c.id, name: "乙的客户" });
  });

  it("旺旺 ID：保存时存一行；别人换大小写、空格再建就挡下；子账号是另一个号", async () => {
    当(乙);
    const r = await saveCustomer(客户({ name: "旺旺客户", salesOwnerId: 乙, 企业号码: { 类型: "旺旺ID", 值: "My Shop:kefu01" } }));
    expect(r).toMatchObject({ ok: true });
    const 行 = await prisma.contactMethod.findMany();
    expect(行).toMatchObject([{ kind: "wangwang", value: "MyShop:kefu01", numberKey: "myshop:kefu01", contactId: null, formatStatus: "ok", region: null }]);
    当(甲);
    expect(await 查号码("旺旺ID", "myshop:KEFU01")).toMatchObject({ 状态: "重复", 提示: "⛔号码重复，可与 乙 沟通核实" });
    const 再建 = await saveCustomer(客户({ name: "又一个", 企业号码: { 类型: "旺旺ID", 值: "MYSHOP : kefu01" } }));
    expect(再建).toEqual({ ok: false, error: "⛔号码重复，可与 乙 沟通核实" });
    expect(await 查号码("旺旺ID", "MyShop")).toMatchObject({ 状态: "首次录入" });
    expect(await 查号码("旺旺ID", "MyShop:kefu02")).toMatchObject({ 状态: "首次录入" });
    expect(await prisma.customer.count()).toBe(1);
  });

  it("保存：选邮箱 / 微信不要电话，号码记进客户档案；格式不对挡下", async () => {
    const r = await saveCustomer(客户({ name: "邮箱客户", 企业号码: { 类型: "邮箱", 值: " Li@Corp.com " } }));
    expect(r).toMatchObject({ ok: true });
    expect(await prisma.customerExtra.findFirst({ select: { email: true } })).toEqual({ email: "Li@Corp.com" });
    expect(await saveCustomer(客户({ name: "坏号", 企业号码: { 类型: "微信", 值: "1abc" } }))).toEqual({ ok: false, error: "⚠️微信号格式错误" });
    const 手 = await saveCustomer(客户({ name: "手机客户", phone: "", 企业号码: { 类型: "手机号", 值: "+86 139-0000-0103" } }));
    expect(手).toMatchObject({ ok: true });
    expect(await prisma.customer.findFirst({ where: { name: "手机客户" }, select: { phone: true } })).toEqual({ phone: "13900000103" });
    // 子表一行一号，老列照写；手机号带归属地
    expect(await prisma.contactMethod.findMany({ orderBy: { kind: "asc" }, select: { kind: true, value: true, numberKey: true, region: true } })).toEqual([
      { kind: "email", value: "Li@Corp.com", numberKey: "li@corp.com", region: null },
      { kind: "phone", value: "13900000103", numberKey: "13900000103", region: expect.stringContaining("新疆") },
    ]);
  });

  it("保存：撞到另一位负责人联系人上的电话也挡下", async () => {
    const c = await 建("乙的客户", 乙);
    await prisma.contact.create({ data: { customerId: c.id, name: "王经理", phone: "13900000104" } });
    expect(await saveCustomer(客户({ name: "撞了", 企业号码: { 类型: "手机号", 值: "13900000104" } }))).toEqual({ ok: false, error: "⛔号码重复，可与 乙 沟通核实" });
  });

  it("全公司查号在事务里也能用（查完再写那一步）", async () => {
    const c = await 建("乙的客户", 乙, { phone: "13900000105" });
    const ids = await prisma.$transaction((tx) => 全公司查号(tx, "手机号", "13900000105", "13900000105"));
    expect(ids).toEqual([c.id]);
  });

  it("只在子表里的号也撞：手机号 / 邮箱 / 微信 / 旺旺 四种都比", async () => {
    const c = await 建("乙的客户", 乙);
    await prisma.contactMethod.createMany({ data: [
      { customerId: c.id, kind: "phone", value: "13900000106", numberKey: "13900000106" },
      { customerId: c.id, kind: "email", value: "Sub@Corp.com", numberKey: "sub@corp.com" },
      { customerId: c.id, kind: "wechat", value: "SubWx_01", numberKey: "subwx_01" },
      { customerId: c.id, kind: "wangwang", value: "SubShop:kf01", numberKey: "subshop:kf01" },
    ] });
    expect(await 查号码("手机号", "139 0000 0106")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("邮箱", "SUB@corp.com")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("微信", "subwx_01")).toMatchObject({ 状态: "重复" });
    expect(await 查号码("旺旺ID", "SUBSHOP : kf01")).toMatchObject({ 状态: "重复" });
    // 类型不同不算撞：同一串记成微信，拿去查旺旺不撞
    expect(await 查号码("旺旺ID", "SubWx_01")).toMatchObject({ 状态: "首次录入" });
  });

  it("撞到好几条认首条（建档最早）：先建的是同事 → 提示同事；首条在公海 → 公海待捞", async () => {
    const 早 = await 建("乙的老客户", 乙, { phone: "13900000107", createdAt: new Date("2026-01-01") });
    await 建("甲的新客户", 甲, { phone: "13900000107", createdAt: new Date("2026-06-01") });
    expect(await 查号码("手机号", "13900000107")).toMatchObject({ 状态: "重复", 提示: "⛔号码重复，可与 乙 沟通核实" });
    await prisma.customerPool.create({ data: { customerId: 早.id } });
    expect(await 查号码("手机号", "13900000107")).toMatchObject({ 状态: "公海待捞", 提示: 查重提示.公海待捞 });
  });
});

describe("开关关着照旧", () => {
  it("查号码不认；保存不认 企业号码（电话照样必填、不写旺旺行）；只在联系人上的电话不挡（老查重）", async () => {
    expect(await 查号码("旺旺ID", "MyShop")).toMatchObject({ ok: false, 状态: "没开" });
    const 没电话 = await saveCustomer(客户({ name: "旺旺客户", 企业号码: { 类型: "旺旺ID", 值: "MyShop" } }));
    expect(没电话.ok).toBe(false);
    expect(await prisma.contactMethod.count()).toBe(0);
    const 有电话 = await saveCustomer(客户({ name: "旺旺客户", phone: "13900000201", 企业号码: { 类型: "旺旺ID", 值: "MyShop" } }));
    expect(有电话).toMatchObject({ ok: true });
    expect(await prisma.contactMethod.count()).toBe(0);

    const c = await 建("乙的客户", 乙);
    await prisma.contact.create({ data: { customerId: c.id, name: "王经理", phone: "13900000202" } });
    expect(await checkDuplicate("13900000202")).toBeNull();
    expect(await saveCustomer(客户({ name: "照旧能建", phone: "13900000202" }))).toMatchObject({ ok: true });
  });
});
