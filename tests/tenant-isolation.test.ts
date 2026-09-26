import { closeTestDatabases } from "./close-databases";
/**
 * 租户隔离。这是托管版唯一不能出错的地方——串一次库就是把 A 公司的客户名单
 * 给了 B 公司，没有补救余地。所以这里不测「功能对不对」，只测「隔离破不破得了」。
 *
 * 用真实的库文件和真实的 Prisma 客户端跑，不做 mock：被 mock 掉的正是要验证的那一层。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-tenant-${process.pid}`);
const 模板 = path.join(临时根, "_template.db");

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  // 用真模板：脚本怎么建的，测试就怎么建
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板], { stdio: "pipe" });
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = 模板;
  // 这一整个文件测的都是托管版行为；自部署版根本不走租户这一层
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

describe("两个工作区的数据互相看不见", () => {
  it("各写各的客户，谁也读不到对方的", async () => {
    const { workspaceClient } = await import("@/lib/tenant/clients");
    fs.copyFileSync(模板, path.join(临时根, "a.db"));
    fs.copyFileSync(模板, path.join(临时根, "b.db"));

    const a = workspaceClient("a.db");
    const b = workspaceClient("b.db");
    const 建人 = (db: typeof a, 名: string) => db.user.create({ data: { email: `${名}@x.local`, password: "!x", name: 名 } });
    const ua = await 建人(a, "甲销售");
    const ub = await 建人(b, "乙销售");
    await a.customer.create({ data: { name: "甲家的客户", phone: "13800000001", salesOwnerId: ua.id } });
    await b.customer.create({ data: { name: "乙家的客户", phone: "13800000002", salesOwnerId: ub.id } });

    expect((await a.customer.findMany()).map((c) => c.name)).toEqual(["甲家的客户"]);
    expect((await b.customer.findMany()).map((c) => c.name)).toEqual(["乙家的客户"]);

    // 手机号查重是全局唯一约束，但只在各自库内生效——两家有同一个客户是正常的
    await expect(b.customer.create({ data: { name: "同号不同家", phone: "13800000001", salesOwnerId: ub.id } })).resolves.toBeTruthy();

    await a.$disconnect();
    await b.$disconnect();
  });

  it("同一个文件名拿到同一个客户端，不同文件名拿到不同的", async () => {
    const { workspaceClient } = await import("@/lib/tenant/clients");
    expect(workspaceClient("a.db")).toBe(workspaceClient("a.db"));
    expect(workspaceClient("a.db")).not.toBe(workspaceClient("b.db"));
  });

  it("dbFile 里夹带路径也跳不出工作区目录", async () => {
    const { workspaceDbPath } = await import("@/lib/tenant/clients");
    const 逃逸 = workspaceDbPath("../../../etc/passwd");
    expect(path.dirname(逃逸)).toBe(临时根);
    expect(逃逸.includes("..")).toBe(false);
  });
});

describe("prisma 代理认当前工作区", () => {
  it("进入哪个工作区就读哪个库，出来之后互不影响", async () => {
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { prisma } = await import("@/lib/prisma");
    const ctx = (slug: string, dbFile: string) => ({ workspaceId: slug, slug, dbFile, role: "OWNER", writable: true });

    const 甲 = await runWithTenant(ctx("a", "a.db"), () => prisma.customer.findMany({ select: { name: true } }));
    const 乙 = await runWithTenant(ctx("b", "b.db"), () => prisma.customer.findMany({ select: { name: true } }));

    expect(甲.map((c) => c.name)).toEqual(["甲家的客户"]);
    expect(乙.map((c) => c.name).sort()).toEqual(["乙家的客户", "同号不同家"]);
  });

  it("托管模式下解析不到工作区就报错，绝不静默落到默认库", async () => {
    const { prisma } = await import("@/lib/prisma");
    // 测试进程里没有请求、没有 cookie，解析必然失败——正是要验证它会炸而不是将就
    await expect(prisma.customer.findMany()).rejects.toThrow(/解析不到工作区/);
  });
});

describe("到期后写操作被拦住", () => {
  /**
   * 闸门在 prisma 代理里，不在界面上：Server Action 是公开端点，
   * 到期后照样能被直接 POST。这里验证的就是「绕过界面也写不进去」。
   */
  const 到期 = (dbFile: string) => ({ workspaceId: "x", slug: "x", dbFile, role: "OWNER", writable: false });

  it("读得到，写不了", async () => {
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { prisma } = await import("@/lib/prisma");
    {
      // 读：放行。人得能把自己的数据看完、导出
      await expect(runWithTenant(到期("a.db"), () => prisma.customer.findMany())).resolves.toBeTruthy();

      // 写：拦住。闸门是同步抛出的，在 Server Action 里会变成 rejected promise，
      // 所以这里也包一层 async，测的才是真实调用形态
      const 写 = (fn: () => unknown) => (async () => runWithTenant(到期("a.db"), fn))();

      await expect(写(() => prisma.customer.create({ data: { name: "不该写进去", phone: "13900000001", salesOwnerId: "x" } }))).rejects.toThrow(/试用已结束/);
      await expect(写(() => prisma.customer.deleteMany({ where: { name: "甲家的客户" } }))).rejects.toThrow(/试用已结束/);
      // 裸 SQL 是绕过模型层的路，同样要拦
      await expect(写(() => prisma.$executeRawUnsafe("delete from Customer"))).rejects.toThrow(/试用已结束/);
    }
  });

  it("拦下来之后数据确实没动", async () => {
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { prisma } = await import("@/lib/prisma");
    const 还在 = await runWithTenant(
      { workspaceId: "a", slug: "a", dbFile: "a.db", role: "OWNER", writable: true },
      () => prisma.customer.findMany({ select: { name: true } }),
    );
    expect(还在.map((c) => c.name)).toEqual(["甲家的客户"]);
  });
});

describe("设置也不能串——隔离做在库这一层，就不能被上一层的缓存截胡", () => {
  it("A 填的 AI 配置，B 一个字都读不到", async () => {
    /**
     * 这一条是补上去的，因为它曾经**在全绿的测试套件下破着**。
     *
     * `getSetting` 走一个进程内缓存，而托管版是一个进程伺候所有工作区。
     * 缓存原来是一个全局 Map：谁先访问谁把它填上，之后所有工作区读到的都是那一份。
     * `prisma.setting.findMany()` 确实按租户路由，但缓存命中时那一行根本跑不到。
     * 后果是业务术语串、AI 接口地址串，连加密的 Key 也串——同一个进程、
     * 同一把 AUTH_SECRET，解得开。
     */
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { getSetting, setSetting, invalidateSettingsCache } = await import("@/lib/settings");
    fs.copyFileSync(模板, path.join(临时根, "sa.db"));
    fs.copyFileSync(模板, path.join(临时根, "sb.db"));
    const 甲 = { workspaceId: "ws-甲", slug: "jia", dbFile: "sa.db", role: "ADMIN", writable: true };
    const 乙 = { workspaceId: "ws-乙", slug: "yi", dbFile: "sb.db", role: "ADMIN", writable: true };

    await runWithTenant(甲, () => setSetting("llm", { baseUrl: "https://a.example/v1", apiKeyEnc: "enc:v1:甲的密文" }));
    await runWithTenant(乙, () => setSetting("llm", { baseUrl: "https://b.example/v1", apiKeyEnc: "enc:v1:乙的密文" }));

    // 先让甲读一遍把缓存填上——串库正是从这一步开始的
    const 甲读 = await runWithTenant(甲, () => getSetting<{ baseUrl: string; apiKeyEnc: string }>("llm"));
    const 乙读 = await runWithTenant(乙, () => getSetting<{ baseUrl: string; apiKeyEnc: string }>("llm"));
    expect(甲读?.baseUrl).toBe("https://a.example/v1");
    expect(乙读?.baseUrl, "乙读到的必须是乙自己的").toBe("https://b.example/v1");
    expect(乙读?.apiKeyEnc).not.toContain("甲的");

    // 反过来再来一遍：谁先谁后都不该有影响
    invalidateSettingsCache();
    const 乙先 = await runWithTenant(乙, () => getSetting<{ baseUrl: string }>("llm"));
    const 甲后 = await runWithTenant(甲, () => getSetting<{ baseUrl: string }>("llm"));
    expect(乙先?.baseUrl).toBe("https://b.example/v1");
    expect(甲后?.baseUrl).toBe("https://a.example/v1");
  });

  it("一边改了设置，另一边不受影响", async () => {
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { getSetting, setSetting } = await import("@/lib/settings");
    fs.copyFileSync(模板, path.join(临时根, "sc.db"));
    fs.copyFileSync(模板, path.join(临时根, "sd.db"));
    const 丙 = { workspaceId: "ws-丙", slug: "bing", dbFile: "sc.db", role: "ADMIN", writable: true };
    const 丁 = { workspaceId: "ws-丁", slug: "ding", dbFile: "sd.db", role: "ADMIN", writable: true };

    await runWithTenant(丙, () => setSetting("business", { customer: "学员" }));
    await runWithTenant(丁, () => setSetting("business", { customer: "客户" }));
    await runWithTenant(丙, () => setSetting("business", { customer: "学生" }));
    expect((await runWithTenant(丁, () => getSetting<{ customer: string }>("business")))?.customer).toBe("客户");
    expect((await runWithTenant(丙, () => getSetting<{ customer: string }>("business")))?.customer).toBe("学生");
  });
});
