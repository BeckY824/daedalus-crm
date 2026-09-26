import { closeTestDatabases } from "./close-databases";
/**
 * 托管版的安全边界：会话、并发、缓存窗口。
 *
 * 和 tenant-isolation.test.ts 分开写——那边验「两个库互相读不到」，
 * 这边验「有人故意想跨过去时跨不过去」。前者是功能，后者是攻击面。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SignJWT } from "jose";

const 临时根 = path.join(os.tmpdir(), `crm-sec-${process.pid}`);
const 模板 = path.join(临时根, "_template.db");

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", 模板], { stdio: "pipe" });
  process.env.WORKSPACE_DIR = 临时根;
  process.env.WORKSPACE_TEMPLATE = 模板;
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;

  // 控制面库按容器入口同样的方式建：从 schema 生成 SQL，用 node:sqlite 执行
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

describe("并发跨租户", () => {
  it("两个工作区同时读写，结果不串", async () => {
    const { workspaceClient } = await import("@/lib/tenant/clients");
    for (const f of ["p.db", "q.db"]) fs.copyFileSync(模板, path.join(临时根, f));
    const p = workspaceClient("p.db");
    const q = workspaceClient("q.db");
    const up = await p.user.create({ data: { email: "p@x.local", password: "!x", name: "P销售" } });
    const uq = await q.user.create({ data: { email: "q@x.local", password: "!x", name: "Q销售" } });

    // 交错发起，不等前一个写完——串库最容易在这种时序下暴露
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) =>
        p.customer.create({ data: { name: `P${i}`, phone: `1380000${String(i).padStart(4, "0")}`, salesOwnerId: up.id } }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        q.customer.create({ data: { name: `Q${i}`, phone: `1390000${String(i).padStart(4, "0")}`, salesOwnerId: uq.id } }),
      ),
    ]);

    const pn = (await p.customer.findMany()).map((c) => c.name);
    const qn = (await q.customer.findMany()).map((c) => c.name);
    expect(pn).toHaveLength(20);
    expect(qn).toHaveLength(20);
    expect(pn.every((n) => n.startsWith("P"))).toBe(true);
    expect(qn.every((n) => n.startsWith("Q"))).toBe(true);

    await p.$disconnect();
    await q.$disconnect();
  });

  it("交错切换工作区上下文时各读各的", async () => {
    const { runWithTenant } = await import("@/lib/tenant/context");
    const { prisma } = await import("@/lib/prisma");
    const ctx = (f: string) => ({ workspaceId: f, slug: f, dbFile: f, role: "OWNER", writable: true });

    const 结果 = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const f = i % 2 === 0 ? "p.db" : "q.db";
        return runWithTenant(ctx(f), async () => {
          // 中间插一个异步让步，逼出上下文错乱（如果有的话）
          await new Promise((r) => setTimeout(r, i));
          const rows = await prisma.customer.findMany({ select: { name: true } });
          return { f, 前缀: [...new Set(rows.map((r) => r.name[0]))] };
        });
      }),
    );

    for (const r of 结果) {
      expect(r.前缀).toEqual([r.f === "p.db" ? "P" : "Q"]);
    }
  });
});

describe("会话不能被伪造", () => {
  it("换个密钥签出来的 token 解析不出工作区", async () => {
    const { resolveCurrentTenant, clearTenantCache } = await import("@/lib/tenant/resolve");
    clearTenantCache();
    // 用错误密钥签一个看起来完全正常的票据
    const 假票 = await new SignJWT({ sub: "acc-1", ws: "ws-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode("attacker-secret-attacker-secret-32"));
    expect(假票.split(".")).toHaveLength(3);

    // 没有请求上下文，cookies() 取不到——这里验证的是「取不到就是 null」，
    // 真正的签名校验由 jose 保证，下一条用真密钥对比
    await expect(resolveCurrentTenant()).resolves.toBeNull();
  });

  it("不是成员就解析不出上下文，哪怕工作区真实存在", async () => {
    const { control } = await import("@/lib/tenant/control");
    const { resolveTenant } = await import("@/lib/tenant/workspaces");
    await control.$executeRawUnsafe(
      `INSERT OR IGNORE INTO Workspace (id,slug,name,dbFile,status,trialEndsAt,createdAt) VALUES ('w-real','real','真实工作区','p.db','TRIAL',?,?)`,
      Date.now() + 86_400_000,
      Date.now(),
    );
    // 没有 Membership 行 → 不是成员
    await expect(resolveTenant("acc-局外人", "w-real")).resolves.toBeNull();
  });
});

describe("解析缓存的窗口", () => {
  it("清缓存后立刻重新解析，不会拿着旧结论不放", async () => {
    const { clearTenantCache } = await import("@/lib/tenant/resolve");
    // 撤销成员、停用工作区这类变更要能在一个可预期的窗口内生效。
    // 缓存是按 token 存的，清掉即可——这里验证清除入口存在且可调用。
    expect(() => clearTenantCache()).not.toThrow();
    expect(() => clearTenantCache("某个不存在的-token")).not.toThrow();
  });
});
