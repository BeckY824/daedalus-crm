/**
 * 企业版「后台设置谁能改」（B2 第 6 条，lib/enterprise/edit-perm*.ts）。
 * 钉的是：没存配置时按清单默认；存了按存的；老板总能改；直属 / 虚线上级只对线索配额、只对自己的下属；
 * 字典、组织规则三块、字段权限表各自按自己那一行拦，拦下一行不写；这张表本身只有老板、总管理员能存，存前规整、留记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "a@x", role: "ADMIN", title: "", avatar: null },
  共享区: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => mocks.共享区 }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: true }) };
});

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { getSetting, setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 设字段权限, 设改权限 } from "@/app/(app)/settings/org-actions";
import { 改组织规则 } from "@/app/(app)/projects/actions";
import { 加角色, 加异常类别 } from "@/lib/project/db";
import { 读组织 } from "@/lib/enterprise/org";
import { 改权限key, 规整改权限, 能改设置, 谁能改, 谁能改的话, 设置项, 设置项们, 挡改设置 } from "@/lib/enterprise/edit-perm";

let 老板: string;
let 总管: string;
let 销售经理: string;
let 市场经理: string;
let 销售: string;
let 虚线: string;

const 当 = (id: string, role = "SALES") => { mocks.user = { ...mocks.user, id, role }; };
const 我 = () => ({ id: mocks.user.id, role: mocks.user.role });
const 记录 = () => prisma.auditLog.findMany({ orderBy: { at: "asc" }, select: { entity: true, entityId: true, summary: true } });

beforeEach(async () => {
  vi.stubEnv("CRM_ENTERPRISE", "1");
  await resetDb();
  invalidateSettingsCache();
  mocks.共享区 = false;
  const 建人 = async (email: string, name: string, role: string, bizRole?: string) => {
    const id = (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
    if (bizRole) await prisma.entMember.create({ data: { userId: id, bizRole } });
    return id;
  };
  老板 = await 建人("boss", "老板", "ADMIN");
  总管 = await 建人("dir", "总管", "SALES", "director");
  销售经理 = await 建人("sm", "销售经理", "SALES", "sales_mgr");
  市场经理 = await 建人("mm", "市场经理", "SALES", "marketing_mgr");
  虚线 = await 建人("dot", "虚线", "SALES", "sales");
  销售 = await 建人("s1", "小王", "SALES", "sales");
  await prisma.entMember.update({ where: { userId: 销售 }, data: { managerId: 销售经理, dottedManagerId: 虚线 } });
  当(老板, "ADMIN");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("表和判断", () => {
  it("没存配置 = 清单默认；规整丢掉不认识的项和人、按可选顺序排", () => {
    expect(Object.fromEntries(设置项们.map((项) => [项, 谁能改({}, 项)]))).toEqual({
      节点时限: ["销售管理", "市场管理", "总管理员"],
      必填字段: ["总管理员"],
      线索配额: ["直属上级", "虚线上级"],
      持有上限: ["销售管理", "总管理员"],
      字典: ["总管理员"],
      字段权限: ["总管理员"],
      阶段规则: ["销售管理", "总管理员"],
    });
    expect(规整改权限(null)).toEqual({});
    expect(规整改权限({ 字典: ["总管理员", "销售管理", "老板", "直属上级"], 乱填: ["总管理员"], 字段权限: "总管理员", 必填字段: [] }))
      .toEqual({ 字典: ["销售管理", "总管理员"], 必填字段: [] });
    expect(谁能改的话({}, "持有上限")).toBe("只有老板、销售管理、总管理员能改");
    expect(谁能改的话({ 必填字段: [] }, "必填字段")).toBe("只有老板能改");
  });

  it("老板总能改；三类按自己的类；直属 / 虚线上级只对自己的下属", async () => {
    const org = await 读组织();
    const 人 = (id: string) => ({ id, role: id === 老板 ? "ADMIN" : "SALES" });
    for (const 项 of 设置项们) expect(能改设置(org, 人(老板), 项, { [项]: [] })).toBe(true);
    expect(能改设置(org, 人(总管), "字典", {})).toBe(true);
    expect(能改设置(org, 人(销售经理), "字典", {})).toBe(false);
    expect(能改设置(org, 人(市场经理), "节点时限", {})).toBe(true);
    expect(能改设置(org, 人(市场经理), "持有上限", {})).toBe(false);
    expect(能改设置(org, 人(总管), "字典", { 字典: [] })).toBe(false);
    // 线索配额：默认总管理员不在里面；直属、虚线上级只给自己的下属设
    expect(能改设置(org, 人(总管), "线索配额", {}, 销售)).toBe(false);
    expect(能改设置(org, 人(销售经理), "线索配额", {}, 销售)).toBe(true);
    expect(能改设置(org, 人(虚线), "线索配额", {}, 销售)).toBe(true);
    expect(能改设置(org, 人(销售经理), "线索配额", {}, 虚线)).toBe(false);
    expect(能改设置(org, 人(虚线), "线索配额", { 线索配额: ["直属上级"] }, 销售)).toBe(false);
    expect(能改设置(org, 人(销售经理), "线索配额", {})).toBe(false);
  });

  it("不是企业版：不看这张表，只有老板", async () => {
    await setSetting(改权限key, { 字典: ["销售管理"] });
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 挡改设置({ id: 销售经理, role: "SALES" }, "字典")).toBe("只有老板能改");
    expect(await 挡改设置({ id: 老板, role: "ADMIN" }, "字典")).toBeNull();
  });
});

describe("各处按自己那一行拦", () => {
  it("字典：默认总管理员能加、销售管理不能；勾上销售管理以后能加", async () => {
    当(销售经理);
    expect(await 加角色(我(), "售前")).toMatchObject({ ok: false, error: "组员角色只有老板、总管理员能改" });
    expect(await 加异常类别(我(), "客户失联")).toMatchObject({ ok: false, error: "异常类别只有老板、总管理员能改" });
    expect(await prisma.projectRole.count({ where: { name: "售前" } })).toBe(0);
    当(总管);
    expect(await 加角色(我(), "售前")).toMatchObject({ ok: true });
    await setSetting(改权限key, { 字典: ["销售管理"] });
    当(销售经理);
    expect(await 加异常类别(我(), "客户失联")).toMatchObject({ ok: true });
    当(总管);
    expect(await 加角色(我(), "交付")).toMatchObject({ ok: false, error: "组员角色只有老板、销售管理能改" });
  });

  it("组织规则：持有上限 / 节点时限 / 必填字段各看各的行，一次改几块要每块都能改", async () => {
    当(市场经理);
    expect(await 改组织规则({ 超时回收: { 开: false } })).toEqual({ ok: true, 收回: 0 });
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toMatchObject({ ok: false, error: "项目持有上限只有老板、销售管理、总管理员能改" });
    当(销售经理);
    expect(await 改组织规则({ 公海: { 持有上限开: true } })).toEqual({ ok: true, 收回: 0 });
    expect(await 改组织规则({ 公海: { 默认上限: 5 }, 节点推进: { 开: true } })).toMatchObject({ ok: false, error: "节点必填字段只有老板、总管理员能改" });
    expect((await prisma.auditLog.count({ where: { summary: { contains: "默认 5 个" } } }))).toBe(0);
    当(销售);
    expect(await 改组织规则({ 超时回收: { 开: false } })).toMatchObject({ ok: false, error: "各节点时限只有老板、销售管理、市场管理、总管理员能改" });
    // 老板把节点时限收回成只有自己
    当(老板, "ADMIN");
    expect(await 设改权限({ 节点时限: [] })).toEqual({ ok: true });
    当(市场经理);
    expect(await 改组织规则({ 超时回收: { 开: false } })).toMatchObject({ ok: false, error: "各节点时限只有老板能改" });
  });

  it("字段权限表：默认总管理员能存、销售管理不能；共享区一律拦", async () => {
    当(销售经理);
    expect(await 设字段权限({})).toMatchObject({ ok: false, error: "字段权限表只有老板、总管理员能改" });
    当(总管);
    expect(await 设字段权限({})).toEqual({ ok: true });
    await setSetting(改权限key, { 字段权限: ["销售管理"] });
    当(销售经理);
    expect(await 设字段权限({})).toEqual({ ok: true });
    mocks.共享区 = true;
    expect(await 设字段权限({})).toMatchObject({ ok: false, error: "共享试用区不能改后台设置" });
  });
});

describe("这张表本身", () => {
  it("只有老板、总管理员能存；存前规整，留一条记录", async () => {
    for (const id of [销售经理, 市场经理, 销售]) {
      当(id);
      expect(await 设改权限({ 字典: ["销售管理"] })).toMatchObject({ ok: false });
    }
    expect(await getSetting(改权限key)).toBeFalsy();
    当(总管);
    expect(await 设改权限({ 字典: ["总管理员", "销售管理", "老板"], 乱填: [1] })).toEqual({ ok: true });
    expect(await getSetting(改权限key)).toEqual({ 字典: ["销售管理", "总管理员"] });
    const [r] = await 记录();
    expect(r).toMatchObject({ entity: "Setting", entityId: 改权限key });
    expect(r.summary).toContain(`${设置项.字典.名}：老板、销售管理、总管理员`);
    expect(r.summary).toContain(`${设置项.线索配额.名}：老板、直属上级、虚线上级`);
  });

  it("不是企业版、共享区都拦，一行不写", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    expect(await 设改权限({ 字典: [] })).toMatchObject({ ok: false });
    vi.stubEnv("CRM_ENTERPRISE", "1");
    mocks.共享区 = true;
    expect(await 设改权限({ 字典: [] })).toMatchObject({ ok: false });
    expect(await getSetting(改权限key)).toBeFalsy();
    expect(await 记录()).toEqual([]);
  });
});
