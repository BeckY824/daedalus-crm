/**
 * 企业版 · 飞书 / 钉钉通讯录 → 组织架构（src/lib/enterprise/org-sync.ts）。
 *
 * 真适配器 + 假网（tests/helpers/ent-fake-net.ts），录制在 tests/fixtures/ent-{feishu,dingtalk}-contacts.json。
 * 裁判：
 *   - 部门 / 成员 / 直属上级 / 业务角色按规矩落库，再跑一次没变化；
 *   - 超时、429、5xx 能自己恢复的这次就成；恢复不了的（一直 5xx、翻页翻到一半断）一行不写，下次能接着来；
 *   - 开关关着：同步、定时都什么都不做，库不变。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import feishuContacts from "./fixtures/ent-feishu-contacts.json";
import dingtalkContacts from "./fixtures/ent-dingtalk-contacts.json";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { 换联网, 连接键 } from "@/lib/enterprise-import/adapter";
import { 定时扫一遍 } from "@/lib/enterprise-import/sync";
import {
  同步通讯录,
  定时同步通讯录,
  开关通讯录同步,
  存角色对照,
  读通讯录设置,
  通讯录到点了,
  通讯录间隔毫秒,
} from "@/lib/enterprise/org-sync";
import { 假网, 断网, 超时, type 录制, type 响应 } from "./helpers/ent-fake-net";

const 飞书录 = feishuContacts as unknown as 录制;
const 钉钉录 = dingtalkContacts as unknown as 录制;
const 部门第一页 = "GET /open-apis/contact/v3/departments/0/children";
const 部门第二页 = "GET /open-apis/contact/v3/departments/0/children?page_token=dp2";
const 成员 = (id: string, pt?: string) => `GET /open-apis/contact/v3/users/find_by_department?department_id=${id}${pt ? `&page_token=${pt}` : ""}`;
const 限流: 响应 = { status: 429, body: { code: 99991400, msg: "request trigger frequency limit" } };
const 五百: 响应 = { status: 503, body: { code: 1, msg: "service unavailable" } };

let 老板: string;
let 经理: string;
let 张三: string;
let 离职的: string;

const 接飞书 = async (先给: Record<string, 响应[]> = {}) => {
  await setSetting(连接键("feishu"), { appId: "cli_fake", appSecret: "fake-secret" });
  const n = 假网(飞书录, 先给);
  换联网(n.网);
  return n;
};
const 接钉钉 = async () => {
  await setSetting(连接键("dingtalk"), { appKey: "ding-fake", appSecret: "fake-secret" });
  const n = 假网(钉钉录);
  换联网(n.网);
  return n;
};

/** 库里组织架构的样子（比对「一行没写」用） */
const 库样子 = async () => ({
  部门: await prisma.entDept.findMany({ orderBy: { id: "asc" } }),
  成员: await prisma.entMember.findMany({ orderBy: { userId: "asc" } }),
  用户: await prisma.user.findMany({ orderBy: { id: "asc" }, select: { id: true, email: true, role: true, active: true } }),
});
const 部门id = async (name: string) => (await prisma.entDept.findFirstOrThrow({ where: { name } })).id;
const 人 = async (email: string) => prisma.user.findUniqueOrThrow({ where: { email } });
const 成员行 = async (userId: string) => prisma.entMember.findUnique({ where: { userId } });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  process.env.CRM_ENTERPRISE = "1";
  const 建人 = async (email: string, name: string, role: string) => (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
  老板 = await 建人("boss@example.com", "老板", "ADMIN");
  经理 = await 建人("mgr@example.com", "王经理", "MANAGER");
  张三 = await 建人("zs@example.com", "张三", "SALES");
  离职的 = await 建人("gone@example.com", "周离职", "SALES");
});

afterEach(() => {
  换联网(null);
  delete process.env.CRM_ENTERPRISE;
  for (const k of ["ENT_FEISHU_APP_ID", "ENT_FEISHU_APP_SECRET"]) delete process.env[k];
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("飞书整本同步", () => {
  it("部门按树建、第 4 层并到第 3 层；成员认邮箱、认不出就建不能登录的账号；直属上级照上游；离职只进报告", async () => {
    await 接飞书();
    const r = await 同步通讯录("feishu", { 用户: { id: 老板, name: "老板" } });
    expect(r.结果).toBe("成功");
    expect(r.话).toContain("部门 4 个");
    expect(r.话).toContain("新建 3 个账号");

    // 部门：4 个，层级对
    const 部门们 = await prisma.entDept.findMany();
    expect(部门们.map((d) => d.name).sort()).toEqual(["华东一队", "华东组", "市场部", "销售部"]);
    const 销售部 = await 部门id("销售部");
    const 华东组 = await 部门id("华东组");
    const 华东一队 = await 部门id("华东一队");
    expect(部门们.find((d) => d.name === "销售部")!.parentId).toBeNull();
    expect(部门们.find((d) => d.name === "华东组")!.parentId).toBe(销售部);
    expect(部门们.find((d) => d.name === "华东一队")!.parentId).toBe(华东组);
    expect(r.报告.some((x) => x.includes("华东一队A小组") && x.includes("第 4 层"))).toBe(true);

    // 新建的账号：普通销售、密码不是 bcrypt 串（登录永远对不上）
    const 李组长 = await 人("lead@example.com");
    const 赵四 = await 人("feishu-ou-s2@contacts.invalid");
    const 孙市场 = await 人("feishu-ou-m1@contacts.invalid");
    for (const u of [李组长, 赵四, 孙市场]) {
      expect(u.role).toBe("SALES");
      expect(u.password.startsWith("$2")).toBe(false);
    }
    expect(李组长.title).toBe("大区经理");

    // 成员：部门、角色、上级
    expect(await 成员行(老板)).toMatchObject({ deptId: null, bizRole: "director", managerId: null });
    expect(await 成员行(经理)).toMatchObject({ deptId: 销售部, bizRole: "sales_mgr", managerId: 老板 });
    expect(await 成员行(李组长.id)).toMatchObject({ deptId: 华东组, bizRole: "sales_mgr", managerId: 经理 });
    expect(await 成员行(张三)).toMatchObject({ deptId: 华东一队, bizRole: "sales", managerId: 李组长.id });
    expect(await 成员行(赵四.id)).toMatchObject({ deptId: 华东一队, bizRole: "sales", managerId: 李组长.id });
    expect(await 成员行(孙市场.id)).toMatchObject({ deptId: await 部门id("市场部"), bizRole: "sales", managerId: null });

    // 离职：账号还开着、没进组织，只进报告
    expect((await prisma.user.findUniqueOrThrow({ where: { id: 离职的 } })).active).toBe(true);
    expect(await 成员行(离职的)).toBeNull();
    expect(r.报告.some((x) => x.includes("周离职") && x.includes("离职交接"))).toBe(true);

    // 状态、职务们、操作日志
    const s = await 读通讯录设置("feishu");
    expect(s.上次).toMatchObject({ 结果: "成功" });
    expect(s.职务们).toEqual(["外贸专员", "大区经理", "市场专员", "总经理", "销售", "销售总监"].sort());
    const 日志 = await prisma.auditLog.findMany({ where: { entity: "EntOrgSync" } });
    expect(日志.map((x) => x.action)).toEqual(["sync"]);
  });

  it("再跑一次没变化：不重复建部门、不重复建账号", async () => {
    await 接飞书();
    await 同步通讯录("feishu");
    const 前 = await 库样子();
    换联网(假网(飞书录).网);
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("没变化");
    expect(await 库样子()).toEqual(前);
  });

  it("第一次同步认领同一级同名的现有部门，不重复建", async () => {
    const 原销售部 = (await prisma.entDept.create({ data: { name: "销售部", parentId: null, sort: 0 } })).id;
    await 接飞书();
    await 同步通讯录("feishu");
    expect(await prisma.entDept.count({ where: { name: "销售部" } })).toBe(1);
    expect(await 部门id("销售部")).toBe(原销售部);
  });

  it("上游改名、挪部门：按对照改，不新建", async () => {
    await 接飞书();
    await 同步通讯录("feishu");
    const 华东组 = await 部门id("华东组");
    const 改: Record<string, 响应[]> = {
      [部门第一页]: [{ body: { code: 0, msg: "success", data: { has_more: true, page_token: "dp2", items: [
        { open_department_id: "od-sales", name: "销售中心", parent_department_id: "0", order: "10", leader_user_id: "ou-mgr" },
        { open_department_id: "od-east", name: "华东大区", parent_department_id: "od-mkt", order: "1", leader_user_id: "ou-lead" },
        { open_department_id: "od-mkt", name: "市场部", parent_department_id: "0", order: "20" },
      ] } } }],
    };
    换联网(假网(飞书录, {}, 改).网);
    expect((await 同步通讯录("feishu")).结果).toBe("成功");
    expect(await prisma.entDept.count()).toBe(4);
    const 新 = await prisma.entDept.findUniqueOrThrow({ where: { id: 华东组 } });
    expect(新).toMatchObject({ name: "华东大区", parentId: await 部门id("市场部") });
    expect(await 部门id("销售中心")).toBeTruthy();
  });
});

describe("业务角色", () => {
  it("角色对照：职务对上了就照对照给（现有账号第一次也改）；对照里给总管理会被丢掉", async () => {
    await 存角色对照("feishu", { 外贸专员: "sales_mgr", 市场专员: "director", " ": "sales" }, { id: 老板, name: "老板" });
    expect((await 读通讯录设置("feishu")).角色对照).toEqual({ 外贸专员: "sales_mgr" });
    await 接飞书();
    await 同步通讯录("feishu");
    expect((await 成员行(张三))!.bizRole).toBe("sales_mgr");
    const 孙市场 = await 人("feishu-ou-m1@contacts.invalid");
    expect((await 成员行(孙市场.id))!.bizRole).toBe("sales");
  });

  it("第一次认到的现有账号不按负责人改角色；之后上游变了跟着变；这边手动改过的不覆盖", async () => {
    // 经理原来是销售（账号 SALES），在飞书是销售部负责人：第一次不动
    await prisma.user.update({ where: { id: 经理 }, data: { role: "SALES" } });
    await 接飞书();
    await 同步通讯录("feishu");
    expect((await 成员行(经理))!.bizRole).toBe("sales");
    // 第二次（已认过）：负责人 → 销售管理
    换联网(假网(飞书录).网);
    await 同步通讯录("feishu");
    expect((await 成员行(经理))!.bizRole).toBe("sales_mgr");
    // 这边手动改回销售：再同步不覆盖
    await prisma.entMember.update({ where: { userId: 经理 }, data: { bizRole: "sales" } });
    换联网(假网(飞书录).网);
    await 同步通讯录("feishu");
    expect((await 成员行(经理))!.bizRole).toBe("sales");
  });

  it("老板和总管理的角色从来不动，角色对照也改不了", async () => {
    await prisma.entMember.create({ data: { userId: 张三, bizRole: "director" } });
    await 存角色对照("feishu", { 总经理: "sales", 外贸专员: "sales" }, { id: 老板, name: "老板" });
    await 接飞书();
    await 同步通讯录("feishu");
    expect((await 成员行(老板))!.bizRole).toBe("director");
    expect((await 成员行(张三))!.bizRole).toBe("director");
  });
});

describe("直属上级", () => {
  it("会绕成环的不设，进报告", async () => {
    // 这边已经设了：王经理的直属上级是张三
    await prisma.entMember.create({ data: { userId: 经理, bizRole: "sales_mgr", managerId: 张三 } });
    // 张三在飞书的上级是王经理（ou-mgr）
    const 改: Record<string, 响应[]> = {
      [成员("od-east-a")]: [{ body: { code: 0, msg: "success", data: { has_more: false, items: [
        { open_id: "ou-s1", name: "张三", enterprise_email: "zs@example.com", job_title: "外贸专员", leader_user_id: "ou-mgr", department_ids: ["od-east-a"], status: { is_resigned: false } },
      ] } } }],
      [成员("od-east", "up2")]: [{ body: { code: 0, msg: "success", data: { has_more: false, items: [] } } }],
      // 王经理在飞书没给上级：这边的不动
      [成员("od-sales")]: [{ body: { code: 0, msg: "success", data: { has_more: false, items: [
        { open_id: "ou-mgr", name: "王经理", enterprise_email: "mgr@example.com", job_title: "销售总监", department_ids: ["od-sales"], status: { is_resigned: false } },
      ] } } }],
    };
    换联网(假网(飞书录, {}, 改).网);
    await setSetting(连接键("feishu"), { appId: "cli_fake", appSecret: "fake-secret" });
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("成功");
    expect((await 成员行(经理))!.managerId).toBe(张三);
    expect((await 成员行(张三))!.managerId).toBeNull();
    expect(r.报告.some((x) => x.includes("张三 的直属上级没设成 王经理"))).toBe(true);
  });
});

describe("上游删了的部门", () => {
  const 没市场部: Record<string, 响应[]> = {
    [部门第一页]: [{ body: { code: 0, msg: "success", data: { has_more: true, page_token: "dp2", items: [
      { open_department_id: "od-sales", name: "销售部", parent_department_id: "0", order: "10", leader_user_id: "ou-mgr" },
      { open_department_id: "od-east", name: "华东组", parent_department_id: "od-sales", order: "1", leader_user_id: "ou-lead" },
    ] } } }],
  };

  it("还有人就留着、进报告；人挪走了再删", async () => {
    await 接飞书();
    await 同步通讯录("feishu");
    const 市场部 = await 部门id("市场部");
    换联网(假网(飞书录, {}, 没市场部).网);
    const r = await 同步通讯录("feishu");
    expect(await prisma.entDept.findUnique({ where: { id: 市场部 } })).not.toBeNull();
    expect(r.报告.some((x) => x.includes("市场部") && x.includes("还有人"))).toBe(true);

    // 孙市场挪到销售部后，再同步就删
    const 孙市场 = await 人("feishu-ou-m1@contacts.invalid");
    await prisma.entMember.update({ where: { userId: 孙市场.id }, data: { deptId: await 部门id("销售部") } });
    换联网(假网(飞书录, {}, { ...没市场部, [成员("od-mkt")]: [{ body: { code: 0, msg: "success", data: { has_more: false, items: [] } } }] }).网);
    await 同步通讯录("feishu");
    expect(await prisma.entDept.findUnique({ where: { id: 市场部 } })).toBeNull();
  });
});

describe("出错：能恢复的这次就成，恢复不了的一行不写", () => {
  it("超时、429、5xx 各来一下：重试后这次就同步成功", async () => {
    const n = await 接飞书({ [部门第一页]: [超时], [部门第二页]: [限流], [成员("od-sales")]: [五百, 断网("ECONNRESET")] });
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("成功");
    expect(n.调过(部门第一页).length).toBeGreaterThanOrEqual(2);
    expect(n.调过(部门第二页).length).toBe(2);
    expect(n.调过(成员("od-sales")).length).toBe(3);
    expect(n.等过.length).toBeGreaterThan(0);
    expect(await prisma.entDept.count()).toBe(4);
  });

  it("一直 5xx：一行不写，只记上次出错；下次能接着同步", async () => {
    const 前 = await 库样子();
    await 接飞书({ [成员("od-mkt")]: [五百, 五百, 五百, 五百, 五百, 五百, 五百, 五百] });
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("出错");
    expect(r.话).toContain("一行没写");
    expect(await 库样子()).toEqual(前);
    expect((await 读通讯录设置("feishu")).上次).toMatchObject({ 结果: "出错" });

    换联网(假网(飞书录).网);
    expect((await 同步通讯录("feishu")).结果).toBe("成功");
    expect(await prisma.entDept.count()).toBe(4);
  });

  it("翻页翻到一半断网（重试也连不上）：一行不写", async () => {
    const 前 = await 库样子();
    await 接飞书({ [成员("od-east", "up2")]: [断网(), 断网(), 断网(), 断网()] });
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("出错");
    expect(await 库样子()).toEqual(前);
  });

  it("没权限（飞书回错误码）：话里说清要开什么权限，一行不写", async () => {
    const 前 = await 库样子();
    await 接飞书({ [部门第一页]: [{ status: 400, body: { code: 99991672, msg: "Access denied" } }] });
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("出错");
    expect(r.话).toContain("通讯录读取权限");
    expect(await 库样子()).toEqual(前);
  });

  it("写库中途出错：整个撤回（部门、账号、成员都没留下）", async () => {
    await 接飞书();
    // 库里装个触发器：写成员行时报错（部门、账号这时已经写进事务里了）
    await prisma.$executeRawUnsafe(`CREATE TRIGGER 测试_成员写不进 BEFORE INSERT ON "EntMember" BEGIN SELECT RAISE(ABORT, '磁盘满了'); END`);
    const 前 = await 库样子();
    try {
      const r = await 同步通讯录("feishu");
      expect(r.结果).toBe("出错");
      expect(r.话).toContain("整个撤回");
      expect(await 库样子()).toEqual(前);
      expect((await 读通讯录设置("feishu")).人对照).toEqual({});
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS 测试_成员写不进`);
    }
    // 去掉以后再跑就成
    换联网(假网(飞书录).网);
    expect((await 同步通讯录("feishu")).结果).toBe("成功");
  });

  it("上游两个人填了同一个新邮箱：第二个用兜底邮箱建，同步照样成", async () => {
    const 改: Record<string, 响应[]> = {
      [成员("od-mkt")]: [{ body: { code: 0, msg: "success", data: { has_more: false, items: [
        { open_id: "ou-m1", name: "孙市场", enterprise_email: "lead@example.com", job_title: "市场专员", department_ids: ["od-mkt"], status: { is_resigned: false } },
      ] } } }],
    };
    await setSetting(连接键("feishu"), { appId: "cli_fake", appSecret: "fake-secret" });
    换联网(假网(飞书录, {}, 改).网);
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("成功");
    expect(r.报告.some((x) => x.includes("同一个邮箱"))).toBe(true);
    expect(await prisma.user.count({ where: { email: "lead@example.com" } })).toBe(1);
    // 再跑一次认得出来，不再建
    const 前 = await 库样子();
    换联网(假网(飞书录, {}, 改).网);
    expect((await 同步通讯录("feishu")).结果).toBe("没变化");
    expect(await 库样子()).toEqual(前);
  });
});

describe("钉钉", () => {
  it("两层部门、成员翻页、一人在两个部门；主管 = 销售管理；manager_userid 给了就设上级", async () => {
    const n = await 接钉钉();
    const r = await 同步通讯录("dingtalk");
    expect(r.结果).toBe("成功");
    expect((await prisma.entDept.findMany()).map((d) => d.name).sort()).toEqual(["深圳组", "渠道部", "销售一部"]);
    const 钱 = await 人("dmgr@example.com");
    const 吴 = await 人("ds1@example.com");
    const 郑 = await 人("dingtalk-dch@contacts.invalid");
    expect(await 成员行(钱.id)).toMatchObject({ deptId: await 部门id("销售一部"), bizRole: "sales_mgr" });
    expect(await 成员行(吴.id)).toMatchObject({ deptId: await 部门id("深圳组"), bizRole: "sales", managerId: 钱.id });
    expect(await 成员行(郑.id)).toMatchObject({ deptId: await 部门id("渠道部") });
    expect((await prisma.entDept.findFirstOrThrow({ where: { name: "深圳组" } })).parentId).toBe(await 部门id("销售一部"));
    expect(n.调过("POST /topapi/v2/user/list?dept_id=100").length).toBe(2);
  });
});

describe("凭据", () => {
  it("没存也没环境变量：没接，一行不写", async () => {
    const 前 = await 库样子();
    换联网(假网(飞书录).网);
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("没接");
    expect(await 库样子()).toEqual(前);
    expect((await 读通讯录设置("feishu")).上次).toMatchObject({ 结果: "没接" });
  });

  it("没存但环境变量里有：用环境变量", async () => {
    process.env.ENT_FEISHU_APP_ID = "cli_env";
    process.env.ENT_FEISHU_APP_SECRET = "env-secret";
    const n = 假网(飞书录);
    换联网(n.网);
    expect((await 同步通讯录("feishu")).结果).toBe("成功");
    expect(n.调用们[0].body).toMatchObject({ app_id: "cli_env", app_secret: "env-secret" });
  });
});

describe("定时：每小时一次", () => {
  it("关着不跑；开着第一次跑、55 分钟内不再跑、满了再跑", async () => {
    const s0 = await 读通讯录设置("feishu");
    expect(通讯录到点了(s0, new Date())).toBe(false);
    await 开关通讯录同步("feishu", true, { id: 老板, name: "老板" });
    const n = await 接飞书();
    const t0 = new Date("2026-10-26T09:00:00Z");
    await 定时同步通讯录(t0);
    expect((await 读通讯录设置("feishu")).上次).toMatchObject({ 结果: "成功", 时间: t0.toISOString() });
    // 记在开的人名下
    expect(await prisma.auditLog.count({ where: { entity: "EntOrgSync", action: "sync", userId: 老板 } })).toBe(1);
    const 调过 = n.调用们.length;
    await 定时同步通讯录(new Date(t0.getTime() + 30 * 60_000));
    expect(n.调用们.length).toBe(调过);
    换联网(假网(飞书录).网);
    await 定时同步通讯录(new Date(t0.getTime() + 通讯录间隔毫秒));
    expect((await 读通讯录设置("feishu")).上次!.时间).toBe(new Date(t0.getTime() + 通讯录间隔毫秒).toISOString());
  });

  it("定时扫一遍（导入的定时钟）也会带上通讯录", async () => {
    await 开关通讯录同步("feishu", true, { id: 老板, name: "老板" });
    await 接飞书();
    await 定时扫一遍(new Date("2026-10-26T09:00:00Z"));
    expect((await 读通讯录设置("feishu")).上次).toMatchObject({ 结果: "成功" });
  });
});

describe("开关关着：个人版 / 团队版不变", () => {
  it("同步通讯录直接跳过，一行不写、不调网", async () => {
    delete process.env.CRM_ENTERPRISE;
    const n = await 接飞书();
    const 前 = await 库样子();
    const r = await 同步通讯录("feishu");
    expect(r.结果).toBe("跳过");
    expect(n.调用们).toEqual([]);
    expect(await 库样子()).toEqual(前);
    expect((await 读通讯录设置("feishu")).上次).toBeNull();
  });

  it("就算设置里开着，定时同步 / 定时扫一遍也什么都不做", async () => {
    process.env.CRM_ENTERPRISE = "1";
    await 开关通讯录同步("feishu", true, { id: 老板, name: "老板" });
    delete process.env.CRM_ENTERPRISE;
    const n = await 接飞书();
    const 前 = await 库样子();
    await 定时同步通讯录(new Date("2026-10-26T09:00:00Z"));
    await 定时扫一遍(new Date("2026-10-26T09:00:00Z"));
    expect(n.调用们).toEqual([]);
    expect(await 库样子()).toEqual(前);
    expect((await 读通讯录设置("feishu")).上次).toBeNull();
  });
});
