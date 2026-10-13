/**
 * 范围同步：领取与交接（2026-10-14 修复，docs/范围同步-领取与交接修复-2026-10-14.md）。
 * 三台桌面端（老板、li、zhao）都走真实 lib/sync/client.ts；云端是真实的 sync-relay + sync-scoped（临时控制库）。
 *  - Bug 1：业务员按旧顺序（先删公海、再改负责人）领取 → 原来服务端逐包核、删公海那一包 403、各台负责人对不上
 *  - Bug 2：业务员把客户交给同事 → 原来交出去的人补不了起点、接手的人永远拉不到；转交后改的计划 / 操作日志被拒成冲突
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li" | "zhao";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-handover-"));
  for (const who of ["boss", "li", "zhao"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  // 和桌面端一样只开一个连接（lib/sqlite-url 单连接）：secure_delete、VACUUM 都落在同一个连接上
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), zhao: mk("zhao") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "", zhao: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
/** 模拟还没升级的服务端：state 回包里没有 pushRule（客户端按旧规则：100 条一块、起点事后单独补） */
let 旧服务端 = false;
const 推送记录: { 谁: 谁; 包: number; 状态: number }[] = [];

const 传: 传输 = async (方法, 路径, body) => {
  const a = 账号[临时.谁];
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId)));
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") { const s = await scoped.范围状态(a, t); r = 旧服务端 ? { ...s, pushRule: undefined, maxPackets: undefined } : s; }
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") {
        const packets = b.packets as never[];
        if (旧服务端 && packets.length > 100) return { 状态: 413, json: { error: "请分批推送范围改动" } };
        r = await scoped.收范围推送(a, t, String(b.device), packets);
        推送记录.push({ 谁: 临时.谁, 包: packets.length, 状态: 200 });
      } else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) {
        if (act === "push") 推送记录.push({ 谁: 临时.谁, 包: (b.packets as unknown[]).length, 状态: e.状态 });
        // 和 route.ts 一样带上 denied；模拟旧服务端时不带
        return { 状态: e.状态, json: e.denied && !旧服务端 ? { error: e.message, denied: e.denied } : { error: e.message } };
      }
      throw e;
    }
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
};

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };
const A = (w: 谁) => `acct_${账号[w]}`;
const 冲突数 = async (w: 谁) => Number((await db(w).$queryRawUnsafe<{ n: bigint }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0].n);

beforeAll(async () => {
  process.env.MULTI_TENANT = "1";
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(临时.root, "sync");
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时.root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(临时.root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(临时.root, "control.db"), path.join(临时.root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control"));
  relay = await import("@/lib/tenant/sync-relay");
  scoped = await import("@/lib/tenant/sync-scoped");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(传);
  // 老板建团队、开通、迁移（开关开着：第一轮就迁移）；两位业务员加入
  当("boss");
  const 码 = await client.建团队("交接QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  const b = db("boss");
  await b.customer.create({ data: { id: "boss-private", name: "QA老板私客丙", phone: "13900003331", salesOwnerId: A("boss") } });
  await 都轮("boss");
  expect(读配置("boss").scoped?.stage).toBe("ready");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

/** 老板录一位私客（带电话、跟进）放进公海，两位业务员都收到 */
async function 老板放公海(id: string, 电话: string) {
  const b = db("boss");
  await b.customer.create({ data: { id, name: `QA公海${id}`, phone: 电话, salesOwnerId: A("boss") } });
  await b.followUp.create({ data: { id: `${id}-f`, customerId: id, ownerId: A("boss"), type: "PHONE", title: "电话", content: `QA公海跟进${id}` } });
  await b.customerPool.create({ data: { customerId: id, reason: "手动", userId: A("boss") } });
  await 都轮("boss", "li", "zhao");
  for (const w of ["li", "zhao"] as const) expect(await db(w).customer.findUnique({ where: { id } })).not.toBeNull();
}

describe("范围同步：领取与交接（服务端按请求开始时的权限核一次推送）", () => {
  it("Bug 1：li 按旧顺序领取（同一事务里先删公海、再改负责人）→ 各台一致：归 li、出了公海；zhao 库里清掉；li 没有冲突", async () => {
    await 老板放公海("pool-1", "13900004441");
    const l = db("li");
    await l.$transaction(async (tx) => {
      await tx.customerPool.delete({ where: { customerId: "pool-1" } });
      await tx.customer.update({ where: { id: "pool-1" }, data: { salesOwnerId: A("li") } });
      await tx.customerClaim.create({ data: { customerId: "pool-1", userId: A("li") } });
    });
    await 都轮("li", "boss", "zhao");
    expect(await 冲突数("li")).toBe(0);
    expect((await db("boss").customer.findUnique({ where: { id: "pool-1" } }))?.salesOwnerId).toBe(A("li"));
    expect(await db("boss").customerPool.findUnique({ where: { customerId: "pool-1" } })).toBeNull();
    expect(await db("zhao").customer.findUnique({ where: { id: "pool-1" } })).toBeNull();
    expect(await db("zhao").followUp.findUnique({ where: { id: "pool-1-f" } })).toBeNull();
    // 领到之后老板再改这位，li 照样收得到（领取的起点跟着领取一起推上去了）
    await db("boss").customer.update({ where: { id: "pool-1" }, data: { remark: "老板领取后改的" } });
    await 都轮("boss", "li");
    expect((await l.customer.findUnique({ where: { id: "pool-1" } }))?.remark).toBe("老板领取后改的");
  });

  it("Bug 2：li 把客户交给 zhao（转交后再改计划负责人、记操作日志）→ zhao 收到客户 + 计划 + 跟进 + 操作日志；li 库里清掉、没有冲突", async () => {
    const l = db("li");
    await l.customer.create({ data: { id: "hand-1", name: "QA交接客户", phone: "13900005551", salesOwnerId: A("li") } });
    await l.followUp.create({ data: { id: "hand-1-f", customerId: "hand-1", ownerId: A("li"), type: "PHONE", title: "电话", content: "QA交接前的跟进" } });
    await l.followPlan.create({ data: { id: "hand-1-p", customerId: "hand-1", ownerId: A("li"), subject: "QA下周回访", plannedAt: new Date(Date.now() + 86_400_000) } });
    await 都轮("li", "boss");
    // patchCustomer 的顺序：先改负责人、记操作日志，再把没做完的计划带过去
    await l.customer.update({ where: { id: "hand-1" }, data: { salesOwnerId: A("zhao") } });
    await l.auditLog.create({ data: { id: "hand-1-a", userId: A("li"), userName: "li", action: "update", entity: "Customer", entityId: "hand-1", summary: "把 QA交接客户 交给 zhao" } });
    await l.followPlan.update({ where: { id: "hand-1-p" }, data: { ownerId: A("zhao") } });
    推送记录.length = 0;
    await 都轮("li");
    expect(推送记录.filter((x) => x.谁 === "li").map((x) => x.状态)).toEqual([200]);
    await 都轮("zhao");
    const z = db("zhao");
    expect((await z.customer.findUnique({ where: { id: "hand-1" } }))?.salesOwnerId).toBe(A("zhao"));
    expect((await z.followPlan.findUnique({ where: { id: "hand-1-p" } }))?.ownerId).toBe(A("zhao"));
    expect(await z.followUp.findUnique({ where: { id: "hand-1-f" } })).not.toBeNull();
    expect(await z.auditLog.findUnique({ where: { id: "hand-1-a" } })).not.toBeNull();
    await 都轮("li", "boss");
    expect(await 冲突数("li")).toBe(0);
    expect(await l.customer.findUnique({ where: { id: "hand-1" } })).toBeNull();
    expect(await l.followPlan.findUnique({ where: { id: "hand-1-p" } })).toBeNull();
    expect((await db("boss").followPlan.findUnique({ where: { id: "hand-1-p" } }))?.ownerId).toBe(A("zhao"));
    // 交接之后 zhao 改、li 收不到；li 也写不进来
    await z.customer.update({ where: { id: "hand-1" }, data: { remark: "zhao 接手后改的" } });
    await 都轮("zhao", "boss");
    expect((await db("boss").customer.findUnique({ where: { id: "hand-1" } }))?.remark).toBe("zhao 接手后改的");
  });

  it("新建客户和计划、还没同步就交给同事：同一次推送全收，接手的人拿到", async () => {
    const l = db("li");
    await l.customer.create({ data: { id: "hand-2", name: "QA刚建就交", phone: "13900006661", salesOwnerId: A("li") } });
    await l.followPlan.create({ data: { id: "hand-2-p", customerId: "hand-2", ownerId: A("li"), subject: "QA刚建的计划", plannedAt: new Date(Date.now() + 86_400_000) } });
    await l.customer.update({ where: { id: "hand-2" }, data: { salesOwnerId: A("zhao") } });
    await l.followPlan.update({ where: { id: "hand-2-p" }, data: { ownerId: A("zhao") } });
    await 都轮("li", "zhao", "li");
    expect(await 冲突数("li")).toBe(0);
    expect((await db("zhao").followPlan.findUnique({ where: { id: "hand-2-p" } }))?.ownerId).toBe(A("zhao"));
    expect(await l.customer.findUnique({ where: { id: "hand-2" } })).toBeNull();
  });

  it("抢领：li、zhao 离线各自领同一位 → 先推的 li 拿到；zhao 那几条成显式冲突、库里清掉，各台都归 li、出了公海", async () => {
    await 老板放公海("pool-2", "13900007771");
    for (const w of ["li", "zhao"] as const) {
      await db(w).$transaction(async (tx) => {
        await tx.customer.update({ where: { id: "pool-2" }, data: { salesOwnerId: A(w) } });
        await tx.customerClaim.create({ data: { customerId: "pool-2", userId: A(w) } });
        await tx.customerPool.delete({ where: { customerId: "pool-2" } });
      });
    }
    // zhao 同一批里还有一条自己的正常改动：不该被一起拒
    await db("zhao").customer.create({ data: { id: "zhao-own", name: "QA赵自有", phone: "13900007779", salesOwnerId: A("zhao") } });
    await 都轮("li", "zhao", "boss", "li", "zhao");
    expect((await db("boss").customer.findUnique({ where: { id: "pool-2" } }))?.salesOwnerId).toBe(A("li"));
    expect(await db("boss").customerPool.findUnique({ where: { customerId: "pool-2" } })).toBeNull();
    expect(await db("boss").customer.findUnique({ where: { id: "zhao-own" } })).not.toBeNull();
    expect((await db("li").customer.findUnique({ where: { id: "pool-2" } }))?.salesOwnerId).toBe(A("li"));
    expect(await db("zhao").customer.findUnique({ where: { id: "pool-2" } })).toBeNull();
    expect(await 冲突数("zhao")).toBeGreaterThanOrEqual(2);
    expect(await 冲突数("li")).toBe(0);
  });

  it("交出去的人连的是没升级的服务端规则（不附起点、事后补被拒）：老板那台按 needBaseline 补上，接手的人拿到", async () => {
    const l = db("li");
    await l.customer.create({ data: { id: "hand-3", name: "QA旧规则交接", phone: "13900008881", salesOwnerId: A("li") } });
    await l.followUp.create({ data: { id: "hand-3-f", customerId: "hand-3", ownerId: A("li"), type: "PHONE", title: "电话", content: "QA旧规则跟进" } });
    await 都轮("li");
    旧服务端 = true;
    try {
      await l.customer.update({ where: { id: "hand-3" }, data: { salesOwnerId: A("zhao") } });
      await 都轮("li", "zhao");
      expect(await db("zhao").customer.findUnique({ where: { id: "hand-3" } })).toBeNull();
    } finally { 旧服务端 = false; }
    await 都轮("boss", "zhao");
    expect((await db("zhao").customer.findUnique({ where: { id: "hand-3" } }))?.salesOwnerId).toBe(A("zhao"));
    expect(await db("zhao").followUp.findUnique({ where: { id: "hand-3-f" } })).not.toBeNull();
    当("boss");
    expect(((await scoped.范围目录(账号.boss, 读配置("boss").teamId)) as { needBaseline?: string[] }).needBaseline).toEqual([]);
  });
});
