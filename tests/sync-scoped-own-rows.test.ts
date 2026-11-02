/**
 * 业务员本机的记录不能因为一份坏目录被当失权删光（2026-11-02，团队实机两次：本机客户、跟进全没了，云端一条没少）。
 * 老板 + 业务员 li，走真实 lib/sync/client.ts 和真实 sync-relay + sync-scoped：
 *   - 目录回 200 但正文没读全 / 空 / 半截：这一轮失败，一条不删，本来的目录缓存也不用
 *   - 增量目录合错、重拿全量才知道都还在：不删；重拿失败：这一轮不清理
 *   - 真转走一两位：照删；本人名下大半同时不在目录里：不删
 *   - 升级上来补一遍：本机被删过、游标却到头的记录（含自己推出去的、含孤儿跳过）补回来，只补一次
 */
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scoped-own-rows-"));
  for (const who of ["boss", "li"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输, 团队配置 } from "@/lib/sync/client";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let local: typeof import("@/lib/sync/scoped-local");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
/** 改 li 的目录回包：第几次请求回什么，「真」拿的是全量（增量里没东西可砍）；不设就走真回包 */
let 改目录: ((真: () => Promise<{ 状态: number; json: Record<string, unknown> }>, 第: number) => Promise<{ 状态: number; json: Record<string, unknown> }>) | null = null;
let 目录次数 = 0;
let 拉取次数 = 0;

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
    if (act === "directory" && 临时.谁 === "li" && 改目录) return 改目录(async () => ({ 状态: 200, json: (await scoped.范围目录(a, t)) as unknown as Record<string, unknown> }), ++目录次数);
    if (act === "pull-many" && 临时.谁 === "li") 拉取次数++;
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t, { base: b.base });
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
const 几位 = (w: 谁) => db(w).customer.count({ where: { salesOwnerId: A(w) } });
/** 直接改 .team.json：造「游标到头、补过记满、还没全补」的现场 */
function 改配置(w: 谁, 改: (c: 团队配置) => 团队配置) {
  当(w);
  fs.writeFileSync(path.join(临时.root, w, ".team.json"), JSON.stringify(改(client.读团队()!)));
}
const 共 = 8;
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
  client = await import("@/lib/sync/client");
  local = await import("@/lib/sync/scoped-local");
  for (const w of ["boss", "li"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(传);
  当("boss");
  const 码 = await client.建团队("本人记录QA");
  if (!码.ok) throw Error(码.error);
  team = 读配置("boss").teamId;
  await relay.设开通(team, true);
  await 都轮("boss");
  当("li");
  expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true });
  await 都轮("li", "boss", "li");
  for (let i = 1; i <= 共; i++) {
    await db("li").customer.create({ data: { id: `li-c${i}`, name: `QA客户${i}`, phone: `1390000${String(i).padStart(4, "0")}`, salesOwnerId: A("li") } });
    await db("li").followUp.create({ data: { id: `li-f${i}`, customerId: `li-c${i}`, type: "PHONE", title: "电话", content: `跟进${i}`, ownerId: A("li") } });
  }
  await 都轮("li", "boss", "li");
  expect(await 几位("li")).toBe(共);
}, 180_000);

afterAll(async () => {
  client?.设传输(null);
  改目录 = null;
  for (const w of ["boss", "li"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

it.each([
  ["正文没读全（空对象）", {}],
  ["scopes 不是数组", { owner: false, scopes: "x" }],
  ["全量却没有团队范围（什么都看不到）", { owner: false, share: false, manager: false, scopes: [], epoch: 0 }],
  ["范围缺 records", { owner: false, scopes: [{ id: "team", revision: 0 }] }],
])("目录回 200 但%s：这一轮失败，一条不删", async (_名, 坏) => {
  改目录 = async () => ({ 状态: 200, json: 坏 as Record<string, unknown> });
  const r = await 轮("li");
  改目录 = null;
  expect(r).toMatchObject({ ok: false });
  expect(await 几位("li")).toBe(共);
  expect(await db("li").followUp.count()).toBe(共);
  await 都轮("li");
  expect(读配置("li").lastError).toBeFalsy();
});

it("HTTP 传输：200 但正文读不出来 = 连不上（状态 0），不当空对象往下走", async () => {
  const 原 = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>半截", { status: 200 })) as typeof fetch;
  client.设传输(null);
  try {
    const r = await 轮("li");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("云端回的内容没收全") });
    expect(await 几位("li")).toBe(共);
  } finally { globalThis.fetch = 原; client.设传输(传); }
});

it("这一份目录里本人的客户少了、重拿全量都在：不删（增量合错兜得住）", async () => {
  改目录 = async (真, 第) => {
    const d = await 真();
    if (第 === 1) d.json = { ...d.json, scopes: (d.json.scopes as { id: string }[]).filter((s) => s.id === "team") };
    return d;
  };
  目录次数 = 0;
  await 都轮("li");
  改目录 = null;
  expect(目录次数).toBe(2);
  expect(await 几位("li")).toBe(共);
});

it("重拿全量失败：这一轮不清理（整轮还能继续）", async () => {
  目录次数 = 0;
  改目录 = async (真, 第) => {
    if (第 === 2) return { 状态: 0, json: { error: "超时" } };
    const d = await 真();
    d.json = { ...d.json, scopes: (d.json.scopes as { id: string }[]).filter((s) => s.id === "team") };
    return d;
  };
  await 轮("li");
  改目录 = null;
  expect(目录次数).toBe(2);
  expect(await 几位("li")).toBe(共);
  await 都轮("li");
});

it("两份目录都说本人大半客户不在：拒删，留着；下一轮不再重拿全量", async () => {
  const 砍 = (j: Record<string, unknown>) => ({ ...j, token: undefined, scopes: (j.scopes as { id: string }[]).filter((s) => s.id === "team") });
  目录次数 = 0;
  改目录 = async (真) => { const d = await 真(); d.json = 砍(d.json); return d; };
  await 都轮("li");
  expect(目录次数).toBe(2);
  expect(await 几位("li")).toBe(共);
  expect(读配置("li").scoped?.cleaned).toMatchObject({ 删: 0, 本人失: 共 });
  目录次数 = 0;
  await 都轮("li");
  expect(目录次数).toBe(1);
  改目录 = null;
  await 都轮("li");
  expect(await 几位("li")).toBe(共);
});

it("真不在目录里的只有一两位：照删（失权清理不能被挡死）", async () => {
  const 砍一个 = (j: Record<string, unknown>) => ({
    ...j, token: undefined,
    scopes: (j.scopes as { id: string; records: { k: string }[] }[]).filter((s) => !s.records.some((r) => r.k === `li-c${共}`)),
  });
  改目录 = async (真) => { const d = await 真(); d.json = 砍一个(d.json); return d; };
  await 都轮("li");
  改目录 = null;
  expect(await db("li").customer.findUnique({ where: { id: `li-c${共}` } })).toBeNull();
  expect(await 几位("li")).toBe(共 - 1);
});

it("实机现场：本机全被清、游标到头、补过记满，升级后补一遍全回来，只补这一次", async () => {
  await 都轮("li");
  await local.清理失权副本(db("li"), new Set(), {});
  expect(await db("li").customer.count({ where: { salesOwnerId: A("li") } })).toBe(0);
  expect(await db("li").followUp.count()).toBe(0);
  改配置("li", (c) => {
    const 记满 = Object.fromEntries(Object.entries(c.scoped?.cursors ?? {}).map(([k, v]) => [k, v.after]));
    return { ...c, scoped: { ...c.scoped!, 补过: 记满, 全补: undefined } };
  });
  await 都轮("li");
  expect(读配置("li").scoped?.全补).toBe(client.全补版本);
  expect(await 几位("li")).toBe(共);
  expect(await db("li").followUp.count()).toBe(共);
  拉取次数 = 0;
  await 都轮("li");
  expect(拉取次数).toBe(0);
  expect(await 几位("li")).toBe(共);
});

it("这一轮有范围拉失败：不记「补过了」，下一轮接着补", async () => {
  await local.清理失权副本(db("li"), new Set(), {});
  改配置("li", (c) => ({ ...c, scoped: { ...c.scoped!, 全补: undefined } }));
  const spy = vi.spyOn(scoped, "给多个范围拉取").mockImplementationOnce(async (_a, _t, 要) => ({ results: (要 as { scopeId: string }[]).map((x) => ({ scopeId: x.scopeId, error: "忙" })) }) as never);
  await 轮("li");
  spy.mockRestore();
  expect(读配置("li").scoped?.全补).toBeUndefined();
  await 都轮("li");
  expect(读配置("li").scoped?.全补).toBe(client.全补版本);
  expect(await 几位("li")).toBe(共);
});

it("老板机不补：只记一下补过了", async () => {
  改配置("boss", (c) => ({ ...c, scoped: { ...c.scoped!, 全补: undefined } }));
  await 都轮("boss");
  expect(读配置("boss").scoped?.全补).toBe(client.全补版本);
});

it("孤儿跳过（hlc 是空的）不挡缺行补回：父行回来了跟进也回来", async () => {
  const li = db("li");
  await li.$executeRawUnsafe("UPDATE _sync_state SET applying = 1 WHERE id = 1");
  await li.followUp.delete({ where: { id: "li-f1" } });
  await li.$executeRawUnsafe("UPDATE _sync_state SET applying = 0 WHERE id = 1");
  for (const aux of ["_sync_log", "_sync_field", "_sync_tomb"]) await li.$executeRawUnsafe(`DELETE FROM ${aux} WHERE tbl = 'FollowUp' AND pk = 'li-f1'`);
  await li.$executeRawUnsafe("INSERT INTO _sync_skip (tbl, pk, hlc, why, at) VALUES ('FollowUp', 'li-f1', '', '孤儿', 0)");
  改配置("li", (c) => ({ ...c, scoped: { ...c.scoped!, 补过: {} } }));
  await 都轮("li");
  expect(await li.followUp.findUnique({ where: { id: "li-f1" } })).not.toBeNull();
});
