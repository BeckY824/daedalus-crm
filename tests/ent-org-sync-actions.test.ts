/**
 * 企业版 · 设置页「通讯录同步」那一栏的后台操作（settings/org-actions.ts 里 通讯录概况 / 设通讯录同步 / 立即同步通讯录 / 设职务对照 / 设通讯录凭据）。
 * 钉的是：
 *   - 不是企业版、共享区、普通人一律拦，库和设置一行不动；
 *   - 密钥只写不回显，留空保存 = 不改，留痕里没有密钥；和导入共用的连接配置里别的键原样留着；
 *   - 凭据没填不让打开；老板手动同步成了，组织架构落库。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "boss@example.com", role: "ADMIN", title: "", avatar: null },
  共享区: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => mocks.共享区 }));

import feishuContacts from "./fixtures/ent-feishu-contacts.json";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { getSetting, invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 换联网, 读连接配置, 连接键 } from "@/lib/enterprise-import/adapter";
import { 读通讯录设置 } from "@/lib/enterprise/org-sync";
import { 通讯录概况, 设通讯录同步, 立即同步通讯录, 设职务对照, 设通讯录凭据 } from "@/app/(app)/settings/org-actions";
import { 假网, type 录制 } from "./helpers/ent-fake-net";

const 飞书录 = feishuContacts as unknown as 录制;
let 老板: string;
let 销售: string;
const 当 = (id: string, role: string) => { mocks.user = { ...mocks.user, id, role }; };
const 库样子 = async () => ({
  部门: await prisma.entDept.findMany({ orderBy: { id: "asc" } }),
  成员: await prisma.entMember.findMany({ orderBy: { userId: "asc" } }),
  用户: await prisma.user.count(),
  设置: await prisma.setting.findMany({ orderBy: { key: "asc" } }),
  记录: await prisma.auditLog.count(),
});

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  process.env.CRM_ENTERPRISE = "1";
  mocks.共享区 = false;
  const 建人 = async (email: string, name: string, role: string) => (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
  老板 = await 建人("boss@example.com", "老板", "ADMIN");
  销售 = await 建人("s1@example.com", "小王", "SALES");
  当(老板, "ADMIN");
});

afterEach(() => {
  换联网(null);
  delete process.env.CRM_ENTERPRISE;
  for (const k of ["ENT_FEISHU_APP_ID", "ENT_FEISHU_APP_SECRET"]) delete process.env[k];
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("谁能用", () => {
  it("不是企业版、共享区、普通销售：五个操作都拦，库和设置一行不动", async () => {
    await setSetting(连接键("feishu"), { appId: "cli_fake", appSecret: "fake-secret" });
    换联网(假网(飞书录).网);
    const 前 = await 库样子();
    for (const 设 of [() => { delete process.env.CRM_ENTERPRISE; }, () => { mocks.共享区 = true; }, () => 当(销售, "SALES")]) {
      process.env.CRM_ENTERPRISE = "1"; mocks.共享区 = false; 当(老板, "ADMIN");
      设();
      expect(await 通讯录概况()).toMatchObject({ ok: false, error: expect.stringContaining("只有老板或总管理员") });
      expect(await 设通讯录同步("feishu", true)).toMatchObject({ ok: false });
      expect(await 立即同步通讯录("feishu")).toMatchObject({ ok: false });
      expect(await 设职务对照("feishu", { 销售: "sales" })).toMatchObject({ ok: false });
      expect(await 设通讯录凭据("feishu", { appSecret: "偷换的" })).toMatchObject({ ok: false });
    }
    expect(await 库样子()).toEqual(前);
  });

  it("接口直调塞别的来源：拦", async () => {
    expect(await 设通讯录同步("wecom" as never, true)).toMatchObject({ ok: false, error: "参数不对" });
    expect(await 立即同步通讯录("../x" as never)).toMatchObject({ ok: false, error: "参数不对" });
  });
});

describe("凭据", () => {
  it("密钥只回显后 4 位、存库加密；留空保存不改；导入那边的配置原样留着；留痕里没有密钥", async () => {
    await setSetting(连接键("feishu"), { 表们: [{ 实体: "customer", app: "a", table: "t" }], 基址: "https://open.feishu.cn" });
    expect(await 设通讯录凭据("feishu", { appId: " cli_abc ", appSecret: "s3cret-v1" })).toEqual({ ok: true });

    const 概 = await 通讯录概况();
    if (!概.ok) throw new Error(概.error);
    const 飞书 = 概.来源们.find((s) => s.源 === "feishu")!;
    expect(飞书.凭据.齐了).toBe(true);
    expect(飞书.凭据.字段).toEqual([
      expect.objectContaining({ 键: "appId", 值: "cli_abc", 已填: true, 密: false }),
      expect.objectContaining({ 键: "appSecret", 值: "****t-v1", 已填: true, 密: true }),
    ]);
    expect(JSON.stringify(概)).not.toContain("s3cret");
    // 角色选项里没有总管级
    expect(概.角色们.map((r) => r.value)).not.toContain("director");
    expect(概.角色们.map((r) => r.value)).not.toContain("admin");

    // 只改 appId，密钥留空 = 不改
    expect(await 设通讯录凭据("feishu", { appId: "cli_new", appSecret: "" })).toEqual({ ok: true });
    invalidateSettingsCache();
    const 存的 = (await getSetting<Record<string, unknown>>(连接键("feishu")))!;
    expect(存的).toMatchObject({ 表们: [{ 实体: "customer", app: "a", table: "t" }], 基址: "https://open.feishu.cn", appId: "cli_new" });
    expect(String(存的.appSecret).startsWith("enc:v1:")).toBe(true);
    expect(await 读连接配置("feishu")).toMatchObject({ appId: "cli_new", appSecret: "s3cret-v1" });
    const 留痕 = await prisma.auditLog.findMany({ where: { entity: "EntConn" }, orderBy: { at: "asc" } });
    expect(留痕.map((r) => r.summary)).toEqual(["改飞书连接凭据：App ID、App Secret", "改飞书连接凭据：App ID"]);
    expect(JSON.stringify(留痕)).not.toContain("s3cret");
  });

  it("用服务器环境变量的：标出来，明文的 App ID 也照给", async () => {
    process.env.ENT_FEISHU_APP_ID = "cli_env";
    process.env.ENT_FEISHU_APP_SECRET = "env-secret";
    const 概 = await 通讯录概况();
    if (!概.ok) throw new Error(概.error);
    const 飞书 = 概.来源们.find((s) => s.源 === "feishu")!;
    expect(飞书.凭据.齐了).toBe(true);
    expect(飞书.凭据.字段.every((f) => f.来自环境变量)).toBe(true);
    expect(JSON.stringify(概)).not.toContain("env-secret");
  });
});

describe("开关和立即同步", () => {
  it("凭据没填不让开；填了能开，立即同步落库，结果写进上次", async () => {
    expect(await 设通讯录同步("feishu", true)).toMatchObject({ ok: false, error: expect.stringContaining("先填好飞书") });
    expect((await 读通讯录设置("feishu")).开).toBe(false);

    await 设通讯录凭据("feishu", { appId: "cli_fake", appSecret: "fake-secret" });
    expect(await 设通讯录同步("feishu", true)).toEqual({ ok: true });
    const s = await 读通讯录设置("feishu");
    expect(s.开).toBe(true);
    expect(s.开的人Id).toBe(老板);

    换联网(假网(飞书录).网);
    const r = await 立即同步通讯录("feishu");
    expect(r).toMatchObject({ ok: true, 一次: { 结果: "成功" } });
    expect(await prisma.entDept.count()).toBe(4);
    const 概 = await 通讯录概况();
    if (!概.ok) throw new Error(概.error);
    const 飞书 = 概.来源们.find((x) => x.源 === "feishu")!;
    expect(飞书.上次?.结果).toBe("成功");
    expect(飞书.职务们.length).toBeGreaterThan(0);

    expect(await 设通讯录同步("feishu", false)).toEqual({ ok: true });
    expect((await 读通讯录设置("feishu")).开).toBe(false);
  });

  it("职务对照：只存能给的角色，总管级的丢掉", async () => {
    expect(await 设职务对照("feishu", { 销售总监: "sales_mgr", 总经理: "director", 市场专员: "marketing_mgr" })).toEqual({ ok: true });
    expect((await 读通讯录设置("feishu")).角色对照).toEqual({ 销售总监: "sales_mgr", 市场专员: "marketing_mgr" });
  });
});
