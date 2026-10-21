/**
 * 范围同步的索引缓存 + 目录只发变了的 + 游标到头不拉（2026-10-21 客户 Even 30 人压测：老板一轮每位客户一个拉取请求、每次整表重算）。
 * 台子同 sync-scoped-retry-gaps：三台桌面端（各一个库）+ 进程内中转；传输层数每台发了几个 pull、目录是不是增量。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-cache-"));
  for (const who of ["boss", "li", "zhao"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
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
const A = (w: 谁) => `acct_${账号[w]}`;

/** 和云端说话：桌面端按「当前是谁」，手机固定是 li 的账号 */
async function 调中转(a: string, 方法: string, 路径: string, body: unknown) {
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId), typeof b.device === "string" ? b.device : undefined));
  if (u.pathname === "/api/sync/remove") return 回(await relay.移除成员(a, String(b.teamId), String(b.accountId)));
  if (u.pathname === "/api/sync/devices") return 回(await relay.团队设备(a, u.searchParams.get("teamId")!));
  if (u.pathname === "/api/sync/rotate") return 回(await relay.换钥匙(a, String(b.teamId), Number(b.epoch), String(b.ring), b.envelopes as never));
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t, { device: String(b.device), base: b.base });
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else if (act === "pull-many") { if (插手.老服务端) return { 状态: 400, json: { error: "未知同步操作" } }; r = await scoped.给多个范围拉取(a, t, b.scopes); }
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied } : { error: e.message } };
      throw e;
    }
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
/** 测试里插手：丢回包（中转收下了，桌面端没收到回包）、给一份旧目录（取目录之后、拉取之前别人新建了记录） */
/** pull = 拉取请求数（一个范围一个的 pull 和一次多个的 pull-many 都算一个请求），批量 = 每个 pull-many 带了几个范围 */
const 记数: Record<谁, { pull: number; 批量: number[]; 目录: Record<string, unknown>[] }> = { boss: { pull: 0, 批量: [], 目录: [] }, li: { pull: 0, 批量: [], 目录: [] }, zhao: { pull: 0, 批量: [], 目录: [] } };
const 清数 = () => { for (const w of ["boss", "li", "zhao"] as const) 记数[w] = { pull: 0, 批量: [], 目录: [] }; };
const 插手: { 丢回包?: { 谁: 谁; 动作: string }; 旧目录?: { 谁: 谁; 目录: Record<string, unknown> }; 老服务端?: boolean } = {};
const 桌面传: 传输 = async (方法, 路径, body) => {
  const w = 临时.谁, act = 路径 === "/api/sync/scoped" ? String((body as Record<string, unknown>)?.action) : "";
  if (插手.旧目录 && 插手.旧目录.谁 === w && act === "directory") { const d = 插手.旧目录.目录; delete 插手.旧目录; return { 状态: 200, json: d }; }
  if (act === "pull" || act === "pull-many") 记数[w].pull++;
  if (act === "pull-many") 记数[w].批量.push(((body as { scopes: unknown[] }).scopes).length);
  const r = await 调中转(账号[w], 方法, 路径, body);
  if (act === "directory" && r.状态 === 200) 记数[w].目录.push(r.json);
  if (插手.丢回包 && 插手.丢回包.谁 === w && 插手.丢回包.动作 === act && r.状态 === 200) { delete 插手.丢回包; return { 状态: 0, json: { error: "连不上云端，检查一下网络" } }; }
  return r;
};

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) { const r = await 轮(w); expect(r, `${w}：${JSON.stringify(r)}`).toMatchObject({ ok: true }); } };
const 全轮 = () => 都轮("li", "zhao", "boss", "li", "zhao");
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };

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
  client.设传输(桌面传);
  // 老板库里先有老客户：开通后要做范围迁移、推起点
  for (let i = 0; i < 3; i++) await db("boss").customer.create({ data: { id: `c-old${i}`, name: `老客户${i}`, phone: `1380000000${i}`, salesOwnerId: "cmusc55660000dulko96ek8kr" } });
  当("boss");
  const 码 = await client.建团队("缓存QA");
  if (!码.ok) throw Error(码.error);
  邀请码 = 码.邀请码;
  await relay.设开通(读配置("boss").teamId, true);
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});
let 邀请码 = "";


describe("索引缓存：空转不拉、只拉变了的、目录只发变了的", () => {
  it("老板迁移、两位业务员加入、全员对齐", async () => {
    await 都轮("boss");
    for (const w of ["li", "zhao"] as const) { 当(w); const r = await client.加入团队(邀请码); expect(r, JSON.stringify(r)).toMatchObject({ ok: true }); }
    await 全轮();
    for (let i = 0; i < 3; i++) await db("boss").customer.update({ where: { id: `c-old${i}` }, data: { salesOwnerId: A(i === 0 ? "li" : "boss") } });
    await 都轮("boss", "li", "zhao", "boss", "li");
    expect(await db("li").customer.findUnique({ where: { id: "c-old0" } })).not.toBeNull();
  });

  it("没人改东西：老板、业务员一轮都不发拉取请求，目录是增量、一个范围都不带", async () => {
    await 都轮("boss", "li");
    清数();
    await 都轮("boss", "li", "zhao");
    for (const w of ["boss", "li", "zhao"] as const) {
      expect(记数[w].pull, w).toBe(0);
      expect(记数[w].目录[0], w).toMatchObject({ delta: true, scopes: [], removed: [] });
    }
  });

  it("业务员给自己的客户记一条跟进：老板这一轮只拉那一个范围、收到；目录里只带那一个范围", async () => {
    当("li");
    await db("li").followUp.create({ data: { id: "f-cache-1", customerId: "c-old0", ownerId: A("li"), type: "PHONE", title: "", content: "缓存后记的" } });
    await 都轮("li");
    清数();
    await 都轮("boss");
    expect(记数.boss.pull).toBe(1);
    expect((记数.boss.目录[0].scopes as { id: string }[]).map((x) => x.id)).toEqual(["Customer:c-old0"]);
    expect(await db("boss").followUp.findUnique({ where: { id: "f-cache-1" } })).toMatchObject({ content: "缓存后记的" });
  });

  it("老板把 li 的客户转给 zhao：li 那边目录里这一位没了、本机删掉；zhao 收到；之后空转都不拉", async () => {
    await db("boss").customer.update({ where: { id: "c-old0" }, data: { salesOwnerId: A("zhao") } });
    await 都轮("boss", "li", "zhao", "boss", "zhao");
    expect(await db("li").customer.findUnique({ where: { id: "c-old0" } })).toBeNull();
    expect(await db("zhao").customer.findUnique({ where: { id: "c-old0" } })).not.toBeNull();
    expect(await db("zhao").followUp.findUnique({ where: { id: "f-cache-1" } })).not.toBeNull();
    await 都轮("boss", "li", "zhao");
    清数();
    await 都轮("boss", "li", "zhao");
    for (const w of ["boss", "li", "zhao"] as const) expect(记数[w].pull, w).toBe(0);
  });

  it("开互看：业务员一轮用两个请求拉齐全队 250 位客户（原来一位一个请求），之后空转不拉", async () => {
    const 起 = await db("boss").customer.count();
    for (let i = 0; i < 250; i++) await db("boss").customer.create({ data: { id: `c-many${i}`, name: `批量${i}`, phone: `1390000${String(i).padStart(4, "0")}`, salesOwnerId: A("boss") } });
    await 都轮("boss");
    await relay.设互看(账号.boss, 读配置("boss").teamId, true);
    清数();
    await 都轮("li");
    expect(记数.li.pull).toBe(2);
    expect(记数.li.批量).toEqual([200, expect.any(Number)]);
    expect(await db("li").customer.count()).toBe(起 + 250);
    清数();
    await 都轮("li", "zhao");
    expect(记数.li.pull).toBe(0);
    expect(await db("zhao").customer.count()).toBe(起 + 250);
  });

  it("老服务端不认 pull-many：退回一个范围一个请求，照样拉齐", async () => {
    for (let i = 0; i < 5; i++) await db("boss").customer.create({ data: { id: `c-old-srv${i}`, name: `老服务端${i}`, phone: `1370000000${i}`, salesOwnerId: A("boss") } });
    await 都轮("boss");
    插手.老服务端 = true;
    try {
      清数();
      await 都轮("li");
      expect(记数.li.pull).toBe(1 + 5); // 第一次 pull-many 被拒，之后 5 个范围各一个
      for (let i = 0; i < 5; i++) expect(await db("li").customer.findUnique({ where: { id: `c-old-srv${i}` } })).not.toBeNull();
    } finally { delete 插手.老服务端; }
  });

  it("本地服务重启（内存里上一份目录没了）：拿全的目录，照样不漏不重", async () => {
    vi.resetModules();
    client.设传输(null);
    client = await import("@/lib/sync/client");
    client.设传输(桌面传);
    清数();
    await 都轮("boss");
    expect(记数.boss.目录[0].delta).toBeUndefined();
    expect(记数.boss.pull).toBe(0);
  });
});
