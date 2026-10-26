/**
 * 企业版 · 设置页「飞书连接」（lib/enterprise/feishu-connect.ts + settings/org-actions.ts 里 测试飞书连接动作 / 飞书表概况 / 设飞书表 / 设通讯录间隔）。
 * 钉的是：
 *   - App Secret 存库是密文（enc:v1:），回显只给后 4 位；老的明文照样能用，解不开的当没填；
 *   - 测试连接一步一步说，没过的照飞书错误码说是哪一种：ID / Secret 不对、没开权限或没发版、应用没被加进多维表格、链接不对、连不上；
 *   - table_id 不用手填：列出数据表按名字对上 8 张主表（带 emoji 前缀也认，探针副本不认，拿不准的留空）；
 *   - 存对表：选的必须真在这个多维表格里、一张表只给一类；原来配的 关联 / 视图、凭据原样留着，没接的 3 类进 备用表；
 *   - 同步频率默认每小时、可改半小时；企微 / 微信端口只占位，调到说「还没接」；
 *   - 不是企业版、普通销售一律拦，库一行不动。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "老板", email: "boss@example.com", role: "ADMIN", title: "", avatar: null },
  共享区: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => mocks.共享区 }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { getSetting, invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 换联网, 读连接配置, 连接键, 还没接 } from "@/lib/enterprise-import/adapter";
import { 对上主表, 取appToken, 测试飞书连接, 读飞书表配置, 存飞书表 } from "@/lib/enterprise/feishu-connect";
import { 读凭据概况, 存通讯录凭据, 读通讯录设置, 通讯录到点了, type 通讯录设置 } from "@/lib/enterprise/org-sync";
import { 占位适配器, 端口接好了, 通讯录端口们 } from "@/lib/enterprise/contacts-ports";
import { 测试飞书连接动作, 飞书表概况, 设飞书表, 设通讯录间隔, 设通讯录凭据 } from "@/app/(app)/settings/org-actions";
import { 假网, 断网, type 录制, type 响应 } from "./helpers/ent-fake-net";

const 令牌键 = "POST /open-apis/auth/v3/tenant_access_token/internal";
const 部门键 = "GET /open-apis/contact/v3/departments/0/children";
const 表键 = "GET /open-apis/bitable/v1/apps/bascnTok12345/tables";
const 链接 = "https://demo.feishu.cn/base/bascnTok12345?table=tblX&view=vewY";

const 有的表 = [
  { table_id: "tblCus", name: "✅ 客户数据库" },
  { table_id: "tblCon", name: "联系人" },
  { table_id: "tblOpp", name: "项目全周期数据库" },
  { table_id: "tblProbe", name: "探针-沟通记录数据库" },
  { table_id: "tblFol", name: "沟通记录表" },
  { table_id: "tblLead", name: "🔍 线索分配后台" },
  { table_id: "tblBlk1", name: "卡点数据库" },
  { table_id: "tblBlk2", name: "卡点 数据库" },
  { table_id: "tblPC", name: "项目关联客户数据库" },
  { table_id: "tblPM", name: "项目关联组员数据库" },
];

const 好录: 录制 = {
  路由: {
    [令牌键]: [{ body: { code: 0, tenant_access_token: "t-ok", expire: 7200 } }],
    [部门键]: [{ body: { code: 0, data: { items: [{ open_department_id: "od-1", name: "销售部" }], has_more: false } } }],
    // 翻两页
    [表键]: [{ body: { code: 0, data: { items: 有的表.slice(0, 6), has_more: true, page_token: "p2" } } }],
    [`${表键}?page_token=p2`]: [{ body: { code: 0, data: { items: 有的表.slice(6), has_more: false } } }],
  },
};
const 错 = (code: number, status = 400): 响应 => ({ status, body: { code, msg: `feishu says ${code}` } });

let 老板: string;
let 销售: string;
const 当 = (id: string, role: string) => {
  mocks.user = { ...mocks.user, id, role };
};
const 老板人 = () => ({ id: 老板, name: "老板" });
const 存好凭据 = () => 存通讯录凭据("feishu", { appId: "cli_test01", appSecret: "sec-abcd-9876" }, 老板人());
const 原样 = async () => ({ 设置: await prisma.setting.findMany({ orderBy: { key: "asc" } }), 记录: await prisma.auditLog.count() });

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

describe("凭据存库加密、回显打码", () => {
  it("App Secret 存的是密文，回显只有后 4 位；读出来用的是明文", async () => {
    expect((await 设通讯录凭据("feishu", { appId: "cli_test01", appSecret: "sec-abcd-9876" })).ok).toBe(true);
    const 行 = await prisma.setting.findUnique({ where: { key: 连接键("feishu") } });
    expect(行!.value).not.toContain("sec-abcd-9876");
    const 存的 = JSON.parse(行!.value) as Record<string, string>;
    expect(存的.appSecret.startsWith("enc:v1:")).toBe(true);
    expect(存的.appId).toBe("cli_test01");

    const 概况 = await 读凭据概况("feishu");
    expect(概况.字段.find((f) => f.键 === "appSecret")!.值).toBe("****9876");
    expect(概况.齐了).toBe(true);
    expect((await 读连接配置("feishu"))!.appSecret).toBe("sec-abcd-9876");
    // 留痕不带值
    const 记录 = await prisma.auditLog.findMany();
    expect(JSON.stringify(记录)).not.toContain("sec-abcd-9876");
  });

  it("老的明文配置照样能用；解不开的密文当没填", async () => {
    await setSetting(连接键("feishu"), { appId: "cli_old", appSecret: "plain-1234" });
    invalidateSettingsCache();
    const f = 假网(好录);
    换联网(f.网);
    const r = await 测试飞书连接();
    expect(r.步们[0]).toMatchObject({ 名: "App ID / Secret", 通过: true });
    expect(f.调过(令牌键)[0].body).toMatchObject({ app_id: "cli_old", app_secret: "plain-1234" });

    await setSetting(连接键("feishu"), { appId: "cli_old", appSecret: "enc:v1:坏掉的" });
    invalidateSettingsCache();
    expect(await 读连接配置("feishu")).not.toHaveProperty("appSecret");
    const r2 = await 测试飞书连接();
    expect(r2.步们).toEqual([{ 名: "App ID / Secret", 通过: false, 话: "还没填 App ID 和 App Secret" }]);
  });
});

describe("测试连接：一步一步说", () => {
  it("全过：拿到令牌、读得到部门、列出数据表并对上主表（翻页也列全）", async () => {
    await 存好凭据();
    const f = 假网(好录);
    换联网(f.网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们.map((s) => [s.名, s.通过])).toEqual([["App ID / Secret", true], ["通讯录", true], ["多维表格", true]]);
    expect(r.多维表格!.appToken).toBe("bascnTok12345");
    expect(r.多维表格!.表们).toHaveLength(有的表.length);
    expect(r.多维表格!.对上.customer).toBe("tblCus");
    expect(r.步们[2].话).toContain(`有 ${有的表.length} 张数据表`);
  });

  it("页面上刚填、还没存的凭据优先；Secret 空着用存着的", async () => {
    await 存好凭据();
    const f = 假网(好录);
    换联网(f.网);
    await 测试飞书连接({ 填: { appId: "cli_new", appSecret: "typed-secret" } });
    expect(f.调过(令牌键)[0].body).toMatchObject({ app_id: "cli_new", app_secret: "typed-secret" });
    await 测试飞书连接({ 填: { appId: "cli_new", appSecret: "" } });
    expect(f.调过(令牌键)[1].body).toMatchObject({ app_id: "cli_new", app_secret: "sec-abcd-9876" });
  });

  it("没填凭据：只说还没填，一个接口都不调", async () => {
    const f = 假网(好录);
    换联网(f.网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们).toEqual([{ 名: "App ID / Secret", 通过: false, 话: "还没填 App ID 和 App Secret" }]);
    expect(f.调用们).toHaveLength(0);
  });

  it("ID / Secret 不对（10003）：说去哪重新复制，后面不再测", async () => {
    await 存好凭据();
    const f = 假网(好录, {}, { [令牌键]: [错(10003)] });
    换联网(f.网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们).toHaveLength(1);
    expect(r.步们[0].通过).toBe(false);
    expect(r.步们[0].话).toContain("App ID 或 App Secret 不对");
    expect(f.调过(部门键)).toHaveLength(0);
  });

  it("通讯录没开权限 / 没发版（99991672）：通讯录没过，多维表格照测", async () => {
    await 存好凭据();
    const f = 假网(好录, {}, { [部门键]: [错(99991672)] });
    换联网(f.网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们[1]).toMatchObject({ 名: "通讯录", 通过: false });
    expect(r.步们[1].话).toContain("没开通讯录读取权限，或开了还没发布版本");
    expect(r.步们[2]).toMatchObject({ 名: "多维表格", 通过: true });
  });

  it("通讯录权限范围不够（40004）：说去选全部成员", async () => {
    await 存好凭据();
    换联网(假网(好录, {}, { [部门键]: [错(40004)] }).网);
    const r = await 测试飞书连接();
    expect(r.步们[1].话).toContain("通讯录权限范围");
  });

  it.each([
    [91403, "应用没被加进这张多维表格"],
    [1254302, "应用没被加进这张多维表格"],
    [99991672, "没开多维表格读取权限，或开了还没发布版本"],
    [1254040, "链接不对"],
  ])("多维表格 code %i：说「%s」", async (code, 话) => {
    await 存好凭据();
    换联网(假网(好录, {}, { [表键]: [错(code)] }).网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们[2]).toMatchObject({ 名: "多维表格", 通过: false });
    expect(r.步们[2].话).toContain(话);
    expect(r.多维表格).toBeUndefined();
  });

  it("没说法的错误码：把飞书原话带上", async () => {
    await 存好凭据();
    换联网(假网(好录, {}, { [表键]: [错(123456)] }).网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们[2].话).toContain("feishu says 123456");
  });

  it("连不上飞书：第一步没过，说连不上", async () => {
    await 存好凭据();
    const f = 假网(好录, {}, { [令牌键]: [断网()] });
    换联网(f.网);
    const r = await 测试飞书连接({ 链接 });
    expect(r.步们).toHaveLength(1);
    expect(r.步们[0].通过).toBe(false);
    expect(r.步们[0].话).toContain("连不上飞书");
  });

  it("多维表格里一张表都没有 / 知识库链接 / 认不出的链接：各说各的", async () => {
    await 存好凭据();
    换联网(假网(好录, {}, { [表键]: [{ body: { code: 0, data: { items: [], has_more: false } } }] }).网);
    expect((await 测试飞书连接({ 链接 })).步们[2].话).toContain("一张数据表都没有");
    expect((await 测试飞书连接({ 链接: "https://demo.feishu.cn/wiki/wikcnAbc123" })).步们[2].话).toContain("知识库");
    expect((await 测试飞书连接({ 链接: "随便写的" })).步们[2].话).toContain("认不出这个链接");
  });

  it("不填链接：只测凭据和通讯录", async () => {
    await 存好凭据();
    const f = 假网(好录);
    换联网(f.网);
    const r = await 测试飞书连接();
    expect(r.步们.map((s) => s.名)).toEqual(["App ID / Secret", "通讯录"]);
    expect(f.调过("GET /open-apis/bitable")).toHaveLength(0);
  });
});

describe("按名字对上主表", () => {
  it("认 emoji 前缀、去掉「数据库」/ 加「表」；探针副本不认；两张一样名的拿不准留空；项目关联客户不当客户", () => {
    const 对上 = 对上主表(有的表.map((t) => ({ tableId: t.table_id, 名: t.name })));
    expect(对上).toEqual({
      customer: "tblCus",
      contact: "tblCon",
      opportunity: "tblOpp",
      followup: "tblFol",
      lead: "tblLead",
      contactMethod: null,
      blocker: null,
      projectMember: "tblPM",
    });
  });

  it("一张表只给一个槽", () => {
    const 对上 = 对上主表([{ tableId: "t1", 名: "客户数据库" }]);
    expect(Object.values(对上).filter((v) => v === "t1")).toHaveLength(1);
  });
});

describe("多维表格链接", () => {
  it("认 /base/ 链接和直接贴的 token，别的说清怎么复制", () => {
    expect(取appToken(链接)).toEqual({ ok: true, appToken: "bascnTok12345" }); // gitleaks:allow
    expect(取appToken("  bascnTok12345 ")).toEqual({ ok: true, appToken: "bascnTok12345" }); // gitleaks:allow
    expect(取appToken("")).toMatchObject({ ok: false, 话: "没填多维表格链接" });
    expect(取appToken("https://demo.feishu.cn/wiki/wikcnAbc123")).toMatchObject({ ok: false });
    expect(取appToken("abc")).toMatchObject({ ok: false });
  });
});

describe("存对表", () => {
  const 先配过 = async () => {
    await 存好凭据();
    const 原 = (await getSetting<Record<string, unknown>>(连接键("feishu")))!;
    await setSetting(连接键("feishu"), {
      ...原,
      基址: "https://open.feishu.cn",
      表们: [{ 实体: "customer", appToken: "bascnTok12345", tableId: "tblCus", viewId: "vewKeep", 名: "客户", 关联: { 所属公司: "customer" } }], // gitleaks:allow
    });
    invalidateSettingsCache();
  };

  it("存进 表们 / 备用表，原来的 关联 / 视图、凭据、基址都留着；读回来和存的一样", async () => {
    await 先配过();
    换联网(假网(好录).网);
    const r = await 设飞书表(链接, { customer: "tblCus", contact: "tblCon", blocker: "tblBlk1", lead: null });
    expect(r.ok).toBe(true);
    const 存的 = JSON.parse((await prisma.setting.findUnique({ where: { key: 连接键("feishu") } }))!.value) as Record<string, unknown>;
    expect(String(存的.appSecret).startsWith("enc:v1:")).toBe(true);
    expect(存的.基址).toBe("https://open.feishu.cn");
    expect(存的.多维表格).toBe("bascnTok12345");
    expect(存的.表们).toEqual([
      { 实体: "customer", appToken: "bascnTok12345", tableId: "tblCus", 名: "✅ 客户数据库", 关联: { 所属公司: "customer" }, viewId: "vewKeep" }, // gitleaks:allow
      { 实体: "contact", appToken: "bascnTok12345", tableId: "tblCon", 名: "联系人" }, // gitleaks:allow
    ]);
    expect(存的.备用表).toEqual({ blocker: { appToken: "bascnTok12345", tableId: "tblBlk1", 名: "卡点数据库" } }); // gitleaks:allow

    const 读 = await 读飞书表配置();
    expect(读.appToken).toBe("bascnTok12345");
    expect(读.选.customer).toEqual({ tableId: "tblCus", 名: "✅ 客户数据库" });
    expect(读.选.blocker).toEqual({ tableId: "tblBlk1", 名: "卡点数据库" });
    expect(读.选.lead).toBeNull();
    const 概况 = await 飞书表概况();
    expect(概况.ok && 概况.主表们).toHaveLength(8);
    // 留痕写对照，不写密钥
    const 记录 = await prisma.auditLog.findMany({ where: { entity: "EntConn" } });
    expect(记录.some((x) => x.summary?.includes("客户→✅ 客户数据库"))).toBe(true);
    expect(JSON.stringify(记录)).not.toContain("sec-abcd-9876");
  });

  it("换了表，原来的视图不跟过去", async () => {
    await 先配过();
    换联网(假网(好录).网);
    const r = await 存飞书表({ 链接, 选: { customer: "tblPC" } }, 老板人());
    expect(r.ok).toBe(true);
    const 存的 = (await getSetting<Record<string, unknown>>(连接键("feishu")))!;
    expect((存的.表们 as Record<string, unknown>[])[0]).not.toHaveProperty("viewId");
  });

  it("一张没选 / 一张给了两类 / 选的不在这个多维表格 / 没存凭据：不存，说为什么", async () => {
    await 先配过();
    换联网(假网(好录).网);
    const 前 = await 原样();
    expect(await 设飞书表(链接, { customer: null })).toEqual({ ok: false, error: "一张表都没选" });
    expect(await 设飞书表(链接, { customer: "tblCus", contact: "tblCus" })).toEqual({ ok: false, error: "同一张数据表选给了两类，请改一下" });
    const 不在 = await 设飞书表(链接, { customer: "tblGone" });
    expect(不在.ok === false && 不在.error).toContain("这个多维表格里没有选的表（客户）");
    expect(await 设飞书表("https://demo.feishu.cn/wiki/x", { customer: "tblCus" })).toMatchObject({ ok: false });
    expect(await 原样()).toEqual(前);

    await prisma.setting.deleteMany({ where: { key: 连接键("feishu") } });
    invalidateSettingsCache();
    expect(await 设飞书表(链接, { customer: "tblCus" })).toEqual({ ok: false, error: "先存好 App ID 和 App Secret" });
  });

  it("应用没被加进多维表格：存的时候也照样说原因", async () => {
    await 先配过();
    换联网(假网(好录, {}, { [表键]: [错(91403)] }).网);
    const r = await 设飞书表(链接, { customer: "tblCus" });
    expect(r.ok === false && r.error).toContain("应用没被加进这张多维表格");
  });
});

describe("同步频率：默认每小时，可改半小时", () => {
  const 设 = (间隔分钟: 60 | 30 | undefined, 分钟前: number, 现在: Date): 通讯录设置 => ({
    开: true,
    开的人Id: null,
    上次: { 时间: new Date(现在.getTime() - 分钟前 * 60_000).toISOString(), 结果: "成功", 话: "" },
    角色对照: {},
    职务们: [],
    部门对照: {},
    人对照: {},
    给过: {},
    ...(间隔分钟 ? { 间隔分钟 } : {}),
  });

  it("半小时档 26 分钟就到点；每小时档（和没设的）要 55 分钟以上", () => {
    const 现在 = new Date("2026-10-26T12:00:00Z");
    expect(通讯录到点了(设(30, 26, 现在), 现在)).toBe(true);
    expect(通讯录到点了(设(30, 20, 现在), 现在)).toBe(false);
    expect(通讯录到点了(设(60, 26, 现在), 现在)).toBe(false);
    expect(通讯录到点了(设(60, 56, 现在), 现在)).toBe(true);
    expect(通讯录到点了(设(undefined, 26, 现在), 现在)).toBe(false);
    expect(通讯录到点了(设(undefined, 56, 现在), 现在)).toBe(true);
  });

  it("设置页改频率：只认 60 / 30", async () => {
    expect((await 读通讯录设置("feishu")).间隔分钟 ?? 60).toBe(60);
    expect(await 设通讯录间隔("feishu", 45)).toEqual({ ok: false, error: "参数不对" });
    expect(await 设通讯录间隔("feishu", 30)).toEqual({ ok: true });
    invalidateSettingsCache();
    expect((await 读通讯录设置("feishu")).间隔分钟).toBe(30);
  });
});

describe("通讯录端口：飞书 / 钉钉接好了，企微 / 微信占位", () => {
  it("四个端口都列着；没接的调到说「还没接」", async () => {
    expect(通讯录端口们.map((x) => x.端口).sort()).toEqual(["dingtalk", "feishu", "wechat", "wecom"]);
    expect(端口接好了("feishu")).toBe(true);
    expect(端口接好了("dingtalk")).toBe(true);
    expect(端口接好了("wecom")).toBe(false);
    expect(端口接好了("wechat")).toBe(false);
    expect(占位适配器("feishu")).toBeNull();
    for (const p of ["wecom", "wechat"] as const) {
      const a = 占位适配器(p)!;
      await expect(a.拉通讯录()).rejects.toBeInstanceOf(还没接);
      await expect(a.拉通讯录()).rejects.toThrow("通讯录还没接上");
    }
  });
});

describe("谁能用", () => {
  it("不是企业版：测试连接 / 读对照 / 存对照 / 改频率一律拦，库一行不动，一个接口都不调", async () => {
    await 存好凭据();
    const f = 假网(好录);
    换联网(f.网);
    const 前 = await 原样();
    delete process.env.CRM_ENTERPRISE;
    const 拦 = { ok: false, error: "只有老板或总管理员能改组织架构" };
    expect(await 测试飞书连接动作({ 链接 })).toEqual(拦);
    expect(await 飞书表概况()).toEqual(拦);
    expect(await 设飞书表(链接, { customer: "tblCus" })).toEqual(拦);
    expect(await 设通讯录间隔("feishu", 30)).toEqual(拦);
    expect(f.调用们).toHaveLength(0);
    expect(await 原样()).toEqual(前);
  });

  it("普通销售：一样拦", async () => {
    await 存好凭据();
    const f = 假网(好录);
    换联网(f.网);
    当(销售, "SALES");
    const 前 = await 原样();
    expect((await 测试飞书连接动作({ 链接 })).ok).toBe(false);
    expect((await 设飞书表(链接, { customer: "tblCus" })).ok).toBe(false);
    expect((await 设通讯录间隔("feishu", 30)).ok).toBe(false);
    expect(f.调用们).toHaveLength(0);
    expect(await 原样()).toEqual(前);
  });

  it("老板：测试连接动作走得通", async () => {
    await 存好凭据();
    换联网(假网(好录).网);
    const r = await 测试飞书连接动作({ 链接 });
    expect(r.ok && r.结果.步们.every((s) => s.通过)).toBe(true);
  });
});
