/**
 * 团队版项目模式 1b（2026-10-23）：部门隔离，桌面端这一半。三台都走真实 lib/sync/client.ts，云端是真实的 sync-relay + sync-scoped。
 * 老板 + li（内贸）+ zhao（外贸），开着互看：分部门之前 li 本机有 zhao 的客户，分部门之后——
 *   - 云端答不上来（超时、断网、5xx、云端读部门表出错）：这一轮失败，本机副本一条不删，也不多拿别部门新建的客户
 *   - 云端正常回了目录（别部门的客户不在里面 = 明说「无权」）：才删掉本机的失权副本（10-23 拍板第 4 条）
 */
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li" | "zhao";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-dept-client-"));
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
let dept: typeof import("@/lib/tenant/team-dept");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "", zhao: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
/** 注入目录请求的故障：超时 / 断网（真实传输里都是 状态 0）、网关超时、5xx */
let 目录故障: { 状态: number; json: Record<string, unknown> } | null = null;

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
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    if (act === "directory" && 目录故障) return 目录故障;
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
      else if (act === "dedupe-put") r = await scoped.收查重索引(a, t, String(b.device), b.entries);
      else if (act === "dedupe-find") r = await scoped.查查重(a, t, b.hashes);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied } : { error: e.message } };
      // 和 Next 路由一样：没接住的错误 = 500
      return { 状态: 500, json: { error: "Internal Server Error" } };
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
const 有 = async (w: 谁, id: string) => !!(await db(w).customer.findUnique({ where: { id } }));
let team = "";

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
  dept = await import("@/lib/tenant/team-dept");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(传);
  当("boss");
  const 码 = await client.建团队("部门QA");
  if (!码.ok) throw Error(码.error);
  team = 读配置("boss").teamId;
  await relay.设开通(team, true);
  await 都轮("boss");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");
  expect(await relay.设互看(账号.boss, team, true)).toMatchObject({ ok: true });
  await db("li").customer.create({ data: { id: "li-c", name: "QA内贸客户", phone: "13900005551", salesOwnerId: A("li") } });
  await db("zhao").customer.create({ data: { id: "zhao-c", name: "QA外贸客户", phone: "13900005552", salesOwnerId: A("zhao") } });
  await 都轮("li", "zhao", "li", "zhao");
  // 分部门之前：开着互看，两人本机都有对方的客户
  expect([await 有("li", "zhao-c"), await 有("zhao", "li-c")]).toEqual([true, true]);
  const 内 = await dept.建部门(账号.boss, team, "内贸", null), 外 = await dept.建部门(账号.boss, team, "外贸", null);
  if (!内.ok || !外.ok) throw Error("建部门失败");
  expect(await dept.设成员(账号.boss, team, 账号.li, { deptId: 内.id })).toMatchObject({ ok: true });
  expect(await dept.设成员(账号.boss, team, 账号.zhao, { deptId: 外.id })).toMatchObject({ ok: true });
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

it.each([
  ["超时", "t0", { 状态: 0, json: { error: "连不上云端，检查一下网络" } }],
  ["断网", "n0", { 状态: 0, json: { error: "连不上云端，检查一下网络" } }],
  ["网关超时 504", "g504", { 状态: 504, json: {} }],
  ["502", "e502", { 状态: 502, json: { error: "Bad Gateway" } }],
  ["500", "e500", { 状态: 500, json: { error: "Internal Server Error" } }],
])("云端答不上来（%s）：这一轮失败，本机的别部门副本不删，也不多拿", async (_名, 键, 故障) => {
  await db("zhao").customer.create({ data: { id: `zhao-new-${键}`, name: "QA外贸新客户", phone: `139${String(键.charCodeAt(0)).padStart(3, "0")}${String(1000 + 故障.状态).slice(-4)}1`, salesOwnerId: A("zhao") } });
  await 都轮("zhao");
  目录故障 = 故障;
  try {
    expect(await 轮("li")).toMatchObject({ ok: false });
  } finally { 目录故障 = null; }
  expect(await 有("li", "zhao-c")).toBe(true);
  expect(await 有("li", "li-c")).toBe(true);
  expect(await 有("li", `zhao-new-${键}`)).toBe(false);
});

it("云端读部门表出错（没接住的异常 = 500）：不退回成「不隔离」的目录，本机副本不删", async () => {
  const spy = vi.spyOn(control.syncDept, "findMany").mockRejectedValue(new Error("数据库忙"));
  try {
    expect(await 轮("li")).toMatchObject({ ok: false });
  } finally { spy.mockRestore(); }
  expect(await 有("li", "zhao-c")).toBe(true);
});

it("云端正常回了目录（别部门的不在里面 = 明说无权）：才删掉本机的失权副本，自己的留着", async () => {
  await 都轮("li", "zhao");
  expect([await 有("li", "zhao-c"), await 有("li", "li-c")]).toEqual([false, true]);
  expect([await 有("zhao", "li-c"), await 有("zhao", "zhao-c")]).toEqual([false, true]);
  // 老板看全公司，两边都在
  await 都轮("boss");
  expect([await 有("boss", "li-c"), await 有("boss", "zhao-c")]).toEqual([true, true]);
});

it("跨部门查重：撞到别部门的客户只给概况——「外贸 · 名字」和客户名，本机拿不到这条客户", async () => {
  const { 问同事 } = await import("@/lib/sync/dedupe-client");
  await 都轮("zhao", "li");
  当("li");
  const 撞 = await 问同事("phone", "13900005552");
  expect(撞).toMatchObject({ 同事: "外贸 · zhao", 客户名: "QA外贸客户", k: "zhao-c" });
  expect(await 有("li", "zhao-c")).toBe(false);
  // 同部门、自己的不提示
  expect(await 问同事("phone", "13900005551")).toBeNull();
});
