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
});

afterAll(() => {
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

  it("托管模式下没有工作区上下文就报错，绝不静默落到默认库", async () => {
    const { prisma } = await import("@/lib/prisma");
    const 原值 = process.env.MULTI_TENANT;
    process.env.MULTI_TENANT = "1";
    try {
      expect(() => prisma.customer).toThrow(/工作区上下文/);
    } finally {
      process.env.MULTI_TENANT = 原值;
    }
  });
});
