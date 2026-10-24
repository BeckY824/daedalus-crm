/**
 * 企业版「字段权限」（角色 × 字段，lib/enterprise/field-perm.ts）。
 * 钉的是：规则没开 = 现在的行为，谁都能改；开了按表管，「只能看」的字段改不了、别的照改；
 * 电话「看不到」从 号码脱敏器 这一个出口打码；老板不受限；设置页交来的表先规整再存。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "a@x", role: "ADMIN", title: "", avatar: null },
  企业版: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user, getCurrentUser: async () => mocks.user }));
vi.mock("@/lib/enterprise/switch", () => ({ 企业版: () => mocks.企业版 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting } from "@/lib/settings";
import { 规则 } from "@/lib/enterprise/rules";
import { 规整字段配置, 字段级别of, 改不了的话, 字段权限of, 字段权限key } from "@/lib/enterprise/field-perm";
import { 号码脱敏器 } from "@/lib/shared-ws/current";
import { patchCustomer, assignSalesOwner, bulkFollowStatus } from "@/app/(app)/customers/actions";
import { saveOpportunity, moveStage } from "@/app/(app)/opportunities/actions";
import { 设字段权限 } from "@/app/(app)/settings/org-actions";

let 老板: string;
let 销售: string;
let 客户: string;

const 当 = (id: string, role = "SALES") => { mocks.user = { ...mocks.user, id, role }; };
const 开规则 = (on = true) => setSetting(规则.字段权限.key, on);

beforeEach(async () => {
  await resetDb();
  mocks.企业版 = true;
  const 建人 = async (email: string, name: string, role: string) => (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
  老板 = await 建人("boss", "老板", "ADMIN");
  销售 = await 建人("s1", "小王", "SALES");
  await prisma.entMember.create({ data: { userId: 销售, bizRole: "sales" } });
  客户 = (await prisma.customer.create({ data: { name: "张三", phone: "13800138000", salesOwnerId: 销售 } })).id;
  await setSetting(字段权限key, { 跟进状态: { sales: "看" }, 电话: { sales: "藏" }, 商机阶段: { sales: "看" } });
  当(销售);
});

describe("纯函数", () => {
  it("规整：不认识的字段、角色、级别丢掉；不能藏的字段写了「藏」按「看」", () => {
    expect(规整字段配置({ 跟进状态: { sales: "藏", 老板: "看", channel_ops: "改" }, 不存在: { sales: "看" }, 电话: { sales: "藏" } })).toEqual({
      跟进状态: { sales: "看" },
      电话: { sales: "藏" },
    });
    expect(规整字段配置(null)).toEqual({});
    expect(规整字段配置("x")).toEqual({});
  });

  it("没写的格是「能改」；改不了的话只说改不了的那几个", () => {
    const 配置 = 规整字段配置({ 跟进状态: { sales: "看" } });
    expect(字段级别of(配置, "跟进状态", "sales")).toBe("看");
    expect(字段级别of(配置, "跟进状态", "sales_mgr")).toBe("改");
    const 级别 = (n: Parameters<typeof 字段级别of>[1]) => 字段级别of(配置, n, "sales");
    expect(改不了的话(级别, ["客户备注"])).toBeNull();
    expect(改不了的话(级别, ["客户备注", "跟进状态", "跟进状态"])).toBe("你的角色不能改「跟进状态」（设置 → 组织架构 → 字段权限）");
  });
});

describe("规则开关", () => {
  it("规则没开（默认）：表填了也不管，照常改、电话不打码", async () => {
    expect((await 字段权限of())("跟进状态")).toBe("改");
    expect(await patchCustomer(客户, "followStatus", "跟进中")).toMatchObject({ ok: true });
    expect((await 号码脱敏器())("13800138000")).toBe("13800138000");
  });

  it("不是企业版：规则开关开着也不管", async () => {
    await 开规则();
    mocks.企业版 = false;
    expect((await 字段权限of())("跟进状态")).toBe("改");
  });

  it("开了：只能看的字段改不了、一行不写；别的字段照改", async () => {
    await 开规则();
    expect(await patchCustomer(客户, "followStatus", "跟进中")).toMatchObject({ ok: false, error: expect.stringContaining("跟进状态") });
    expect(await bulkFollowStatus([客户], "跟进中")).toMatchObject({ ok: false, error: expect.stringContaining("跟进状态") });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 客户 } })).followStatus).not.toBe("跟进中");
    expect(await patchCustomer(客户, "remark", "下周再打")).toMatchObject({ ok: true });
    expect(await assignSalesOwner([客户], 老板)).toMatchObject({ ok: true });
  });

  it("开了：电话设成看不到的角色打码，老板不受限", async () => {
    await 开规则();
    expect((await 号码脱敏器())("13800138000")).not.toBe("13800138000");
    当(老板, "ADMIN");
    expect((await 号码脱敏器())("13800138000")).toBe("13800138000");
    expect(await patchCustomer(客户, "followStatus", "跟进中")).toMatchObject({ ok: true });
  });

  it("开了：组织里没登记的人按账号角色推（销售 → 销售，主管 → 销售管理），照推出来的角色管", async () => {
    await 开规则();
    await prisma.entMember.deleteMany({ where: { userId: 销售 } });
    expect(await patchCustomer(客户, "followStatus", "跟进中")).toMatchObject({ ok: false, error: expect.stringContaining("跟进状态") });
    const 主管 = (await prisma.user.create({ data: { email: "m1", name: "主管", title: "", role: "MANAGER", password: "x" } })).id;
    expect((await 字段权限of(主管))("跟进状态")).toBe("改");
  });

  it("商机：阶段只能看时拖阶段、编辑改阶段都拦，只改名字照存", async () => {
    await 开规则();
    const o = await prisma.opportunity.create({ data: { name: "商机A", customerId: 客户, ownerId: 销售, amount: 100, stage: "方案报价", status: "OPEN", probability: 75 } });
    expect(await moveStage(o.id, "谈判审核")).toMatchObject({ ok: false, error: expect.stringContaining("阶段") });
    const 原样 = { id: o.id, name: "商机A", customerId: 客户, ownerId: 销售, amount: 100, stage: "方案报价", status: "OPEN", probability: 75 };
    expect(await saveOpportunity({ ...原样, stage: "谈判审核" })).toMatchObject({ ok: false, error: expect.stringContaining("阶段") });
    expect(await saveOpportunity({ ...原样, name: "商机B" })).toMatchObject({ ok: true });
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: o.id } })).stage).toBe("方案报价");
  });
});

describe("设置页存表", () => {
  it("老板能存，交来的先规整；普通销售不能存", async () => {
    expect(await 设字段权限({ 客户备注: { sales: "藏" } })).toMatchObject({ ok: false });
    当(老板, "ADMIN");
    expect(await 设字段权限({ 客户备注: { sales: "藏" }, 乱写: 1 })).toEqual({ ok: true });
    const 存 = await prisma.setting.findUniqueOrThrow({ where: { key: 字段权限key } });
    expect(JSON.parse(存.value)).toEqual({ 客户备注: { sales: "看" } });
    expect(await prisma.auditLog.count({ where: { entityId: 字段权限key } })).toBe(1);
  });
});
