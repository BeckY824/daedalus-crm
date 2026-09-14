/**
 * 共享演示工作区。
 *
 * 它是整套隔离设计里唯一一个「所有人共用」的例外，所以要钉的不是功能，
 * 是这个例外**不会扩散**：
 *   1. 没配 DEMO_WORKSPACE 时它整个不存在（自部署版不该多出免登录入口）
 *   2. 重置只清演示库，隔壁真实工作区一根头发都不能掉
 *   3. 演示区永不过期——它要是变成只读，访客看到的就是一个坏掉的产品
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-demo-${process.pid}`);
const 模板 = path.join(临时根, "_template.db");
const SLUG = "demo";

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板], { stdio: "pipe" });
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = 模板;
  process.env.MULTI_TENANT = "1";
  process.env.DEMO_WORKSPACE = SLUG;
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;

  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  delete process.env.DEMO_WORKSPACE;
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.DEMO_WORKSPACE = SLUG;
});

describe("没配就不存在", () => {
  it("DEMO_WORKSPACE 为空时，演示区识别不出来也建不出来", async () => {
    const { demoSlug, 是演示工作区, 确保演示工作区 } = await import("@/lib/demo/workspace");
    delete process.env.DEMO_WORKSPACE;

    expect(demoSlug()).toBeNull();
    // 关键：不能因为某个工作区恰好叫 demo 就把它当演示区免登录放进去
    expect(是演示工作区("demo")).toBe(false);
    await expect(确保演示工作区()).rejects.toThrow();
  });

  it("只认配置的那一个 slug", async () => {
    const { 是演示工作区 } = await import("@/lib/demo/workspace");
    expect(是演示工作区(SLUG)).toBe(true);
    expect(是演示工作区("demo2")).toBe(false);
    expect(是演示工作区(null)).toBe(false);
    expect(是演示工作区(undefined)).toBe(false);
  });
});

describe("建立", () => {
  it("建出一个有数据的工作区，第二次调用不重复建", async () => {
    const { 确保演示工作区 } = await import("@/lib/demo/workspace");
    const { control } = await import("@/lib/tenant/control");

    const 第一次 = await 确保演示工作区();
    expect(第一次.created).toBe(true);
    // 演示数据要撑得起一个页面，几条记录的演示比没有演示更劝退
    expect(第一次.counts!.学员).toBeGreaterThanOrEqual(30);
    expect(第一次.counts!.跟进).toBeGreaterThan(0);
    expect(第一次.counts!.合同).toBeGreaterThan(0);

    const 第二次 = await 确保演示工作区();
    expect(第二次.created).toBe(false);
    expect(await control.workspace.count({ where: { slug: SLUG } })).toBe(1);
  });

  it("永不过期——变成只读的演示等于展示一个坏掉的产品", async () => {
    const { 确保演示工作区 } = await import("@/lib/demo/workspace");
    const { control } = await import("@/lib/tenant/control");
    const { computeWritable, daysLeft } = await import("@/lib/tenant/workspaces");

    await 确保演示工作区();
    const ws = await control.workspace.findUnique({ where: { slug: SLUG } });
    expect(computeWritable(ws!)).toBe(true);
    expect(daysLeft(ws!)).toBeGreaterThan(3000);
  });

  it("演示账号有 OWNER 成员关系，/demo 才签得出票据", async () => {
    const { 确保演示工作区, 演示票据信息 } = await import("@/lib/demo/workspace");
    await 确保演示工作区();
    const info = await 演示票据信息();
    expect(info).not.toBeNull();
    expect(info!.accountId).toBeTruthy();
    expect(info!.workspaceId).toBeTruthy();
  });
});

describe("重置", () => {
  it("访客写进去的东西被清掉，演示数据回到原样", async () => {
    const { 确保演示工作区, 重置演示工作区 } = await import("@/lib/demo/workspace");
    const { control } = await import("@/lib/tenant/control");
    const { workspaceClient } = await import("@/lib/tenant/clients");

    await 确保演示工作区();
    const ws = await control.workspace.findUnique({ where: { slug: SLUG } });
    const db = workspaceClient(ws!.dbFile);

    const 原有 = await db.customer.count();
    const 销售 = await db.user.findFirst({ where: { role: "SALES" } });
    await db.customer.create({
      data: { name: "访客乱填的", phone: "19900000000", salesOwnerId: 销售!.id },
    });
    expect(await db.customer.count()).toBe(原有 + 1);

    const counts = await 重置演示工作区();
    expect(counts.学员).toBe(原有);

    // 换过文件之后必须重新取客户端——旧的那个已经被 drop 掉了
    const 新db = workspaceClient(ws!.dbFile);
    expect(await 新db.customer.count()).toBe(原有);
    expect(await 新db.customer.findFirst({ where: { phone: "19900000000" } })).toBeNull();
  });

  it("不碰隔壁的真实工作区——这是整个例外唯一不能破的地方", async () => {
    const { 确保演示工作区, 重置演示工作区 } = await import("@/lib/demo/workspace");
    const { createWorkspace } = await import("@/lib/tenant/workspaces");
    const { control } = await import("@/lib/tenant/control");
    const { workspaceClient } = await import("@/lib/tenant/clients");

    await 确保演示工作区();

    const 客户账号 = await control.account.create({
      data: { email: "real@example.com", password: "x", name: "真实客户" },
    });
    const 真实 = await createWorkspace({ name: "启明教育", account: { id: 客户账号.id, name: "王老师", email: "real@example.com" } });
    const 真实db = workspaceClient(真实.dbFile);
    const 老师 = await 真实db.user.findFirst();
    await 真实db.customer.create({ data: { name: "真实学员", phone: "13612341234", salesOwnerId: 老师!.id } });

    await 重置演示工作区();

    const 查 = workspaceClient(真实.dbFile);
    expect(await 查.customer.count()).toBe(1);
    expect((await 查.customer.findFirst())!.name).toBe("真实学员");
    // 文件也还在：重置只该动演示库那一个文件
    expect(fs.existsSync(path.join(临时根, 真实.dbFile))).toBe(true);
  });

  it("没建过就重置要明确报错，而不是默默建一个", async () => {
    const { 重置演示工作区 } = await import("@/lib/demo/workspace");
    process.env.DEMO_WORKSPACE = "从没建过的演示区";
    await expect(重置演示工作区()).rejects.toThrow(/还没建/);
  });
});
