/**
 * 客户反馈 2026-10-19 采纳的两条团队版改动，和真实桌面端、真实中转一起跑（同 tests/mobile-sync.test.ts 的搭法）：
 *   老板、li、zhao 三台电脑走真实 lib/sync/client.ts；li 的一部手机走 lib/mobile/sync.ts。
 *
 *   1. 老板提醒（lib/sync/team-notice.ts → desktop/team-notices.js）：同事新建客户 / 商机 / 跟进，只有老板那台出提醒；
 *      本人录的不提醒自己；同一个人一分钟内的合成一条；老板电脑离线一阵回来，攒下的几十条只弹一条汇总
 *   2. 手机新建客户 / 商机（lib/mobile/sync.ts 新建客户 / 新建商机）：归本人，推上去后本人和老板的电脑马上看得到，
 *      别的业务员看不到；规矩和电脑上的新建框一样（外贸：电话 / WhatsApp / 邮箱至少一个）
 *
 * 所有设备在一个进程里：回放记新插的箱子是 globalThis 上同一个，所以每台电脑同步完都调一次 同事新建提醒 把箱子取走（非老板那台取走即丢）
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-notice-"));
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
import * as 手机 from "@/lib/mobile/sync";
import * as 密 from "@/lib/sync/crypto-web";

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
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied } : { error: e.message } };
      throw e;
    }
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
const 桌面传: 传输 = (方法, 路径, body) => 调中转(账号[临时.谁], 方法, 路径, body);
const 手机传: 手机.传输 = (方法, 路径, body) => 调中转(账号.li, 方法, 路径, body);

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };

let 机: 手机.手机团队;
const 库 = new 手机.内存库();
const 状态 = 手机.新状态();
const 手机轮 = async () => { const r = await 手机.同步一轮(机, 手机传, 库, 状态); 机 = r.c; return r; };
const 手机有 = async (t: string, k: string) => (await 库.取(t, k))?.r;

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
  当("boss");
  const 码 = await client.建团队("提醒QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await db("boss").customer.create({ data: { id: "boss-private", name: "老板私客丙", phone: "13900003331", salesOwnerId: A("boss") } });
  await 都轮("boss");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");

  // li 的手机：自己生成不可导出的钥匙对，登记成 li 账号的一台设备；团队钥匙照电脑授权时封过去的那份给
  const 钥 = await 密.设备钥匙对();
  const li = 读配置("li");
  expect(await relay.入队(账号.li, li.teamId, li.joinSecret, { device: "m_li_phone", pubKey: 钥.公钥 })).toMatchObject({ ok: true });
  机 = { teamId: li.teamId, device: "m_li_phone", key: li.key, epoch: li.epoch ?? 0, keys: li.keys ?? {}, signPub: li.signPub, userId: A("li"), 私钥: 钥.私钥 };
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});


import { 同事新建提醒, type 同事新建 } from "@/lib/sync/team-notice";
import { 记新插, 取走新插 } from "@/lib/sync/team-notice-box";
import { 分表, 客户们 } from "@/lib/mobile/view";
// 壳里的合并规则（CommonJS）：和 main.js 用的是同一份
import 壳 from "../desktop/team-notices.js";
import 提醒设置 from "../desktop/reminders.js";

const 默认开关 = 提醒设置.默认设置;
/** 同步一轮，再按本地服务 /api/desktop/sync 的做法取这台的提醒 */
async function 轮取(w: 谁, 现在 = Date.now()): Promise<同事新建[]> {
  当(w);
  expect(await client.同步一轮()).toMatchObject({ ok: true });
  return 同事新建提醒(db(w), client.读团队(), 现在);
}
/** 先让手机推，再让三台电脑各同步一轮；返回老板那台这一轮的提醒（li、zhao 两台的一定是空的） */
async function 都同步(): Promise<同事新建[]> {
  const li = await 轮取("li");
  const zhao = await 轮取("zhao");
  expect(li).toEqual([]);
  expect(zhao).toEqual([]);
  const boss = await 轮取("boss");
  expect(await 轮取("li")).toEqual([]);
  return boss;
}
function 假壳(起: number) {
  let 钟 = 起;
  const 发了: { title: string; body: string; 去: string; 收回了: boolean }[] = [];
  const 提醒 = 壳.创建同事提醒({
    发: (x: { title: string; body: string; 去: string }) => { const 条 = { ...x, 收回了: false }; 发了.push(条); return { ok: true, 收回: () => { 条.收回了 = true; } }; },
    现在: () => 钟,
  });
  return { 提醒, 发了, 过: (ms: number) => { 钟 += ms; }, 还在: () => 发了.filter((x) => !x.收回了) };
}

describe("老板提醒 + 手机新建客户 / 商机（两台电脑 + 手机）", () => {
  it("准备：团队用外贸模版、本位币 USD；老板那台第一次取提醒记下起点，之前的历史不提醒", async () => {
    await db("boss").setting.upsert({ where: { key: "business" }, create: { key: "business", value: JSON.stringify({ template: "trade", currency: "USD", customer: "客户" }) }, update: {} });
    // li 先有一位老客户（起点之前就有）
    await db("li").customer.create({ data: { id: "c-li-old", name: "Old Lumen GmbH", phone: "+4930111222", salesOwnerId: A("li") } });
    expect(await 轮取("li")).toEqual([]);
    // 老板那台第一次问：记下起点；这一轮同步下来的 li 老客户算历史（起点就是现在，钟比它早）
    const 起点前 = Date.now();
    取走新插();
    const 第一次 = await 轮取("boss", 起点前 + 60_000);
    expect(第一次).toEqual([]);
    expect(await db("boss").customer.findUnique({ where: { id: "c-li-old" } })).toBeTruthy();
    const 记的 = JSON.parse(fs.readFileSync(path.join(临时.root, "boss", ".team-notice.json"), "utf8"));
    expect(记的).toMatchObject({ teamId: 读配置("boss").teamId });
    当("boss");
    expect(记的.起点).toBe(起点前 + 60_000);
    // 把起点挪回现在，后面的用例按真实时间走
    fs.writeFileSync(path.join(临时.root, "boss", ".team-notice.json"), JSON.stringify({ teamId: 读配置("boss").teamId, 起点: Date.now() - 1000 }));
    await 手机轮();
    expect(await 手机有("Setting", "business")).toBeTruthy();
    expect(await 手机有("Customer", "c-li-old")).toBeTruthy();
  });

  it("手机新建客户 + 商机：li 和老板的电脑同步后看得到（档案、币种、日志都在），zhao 看不到；只有老板那台出提醒，合成一条", async () => {
    const 建的时候 = Date.now();
    const { id: 客户 } = await 手机.新建客户(机, 库, 状态, { name: "  Nordlicht Leuchten GmbH ", phone: "", whatsapp: "+49 151 2345 6789", email: "einkauf@nordlicht.example", country: "germany", source: "展会获取" });
    const { id: 商机 } = await 手机.新建商机(机, 库, 状态, { customerId: 客户, name: "工矿灯 2000 套", amount: 36000.5, stage: "方案报价" });
    // 先在手机上看得到、标着待同步
    expect(await 手机有("Customer", 客户)).toMatchObject({ name: "Nordlicht Leuchten GmbH", salesOwnerId: A("li") });
    expect(状态.待推.map((e) => e.t)).toEqual(["Customer", "CustomerExtra", "AuditLog", "Opportunity", "OpportunityMoney", "AuditLog"]);
    const r = await 手机轮();
    expect(r.推).toBe(6);
    expect(状态.被拒).toEqual([]);

    const 老板的 = await 都同步();
    for (const w of ["li", "boss"] as const) {
      const c = await db(w).customer.findUnique({ where: { id: 客户 }, include: { extra: true } });
      // 没电话、填了 WhatsApp：WhatsApp 号当电话认人（和电脑上 saveCustomer 一样）；国家认成统一叫法
      expect(c).toMatchObject({ name: "Nordlicht Leuchten GmbH", phone: "+4915123456789", salesOwnerId: A("li"), followStatus: "待跟进", decisionStatus: "了解中" });
      expect(c!.extra).toMatchObject({ whatsapp: "+49 151 2345 6789", email: "einkauf@nordlicht.example", country: "德国", source: "展会获取" });
      expect(Math.abs(c!.createdAt.getTime() - 建的时候)).toBeLessThan(2000);
      const o = await db(w).opportunity.findUnique({ where: { id: 商机 }, include: { money: true } });
      expect(o).toMatchObject({ name: "工矿灯 2000 套", amount: 36000.5, stage: "方案报价", status: "OPEN", probability: 60, ownerId: A("li"), customerId: 客户 });
      expect(o!.money?.currency).toBe("USD");
      expect(await db(w).auditLog.findFirst({ where: { entityId: 客户, action: "create" } })).toMatchObject({ userId: A("li"), summary: "新建客户「Nordlicht Leuchten GmbH」" });
      expect(await db(w).auditLog.findFirst({ where: { entityId: 商机, action: "create" } })).toMatchObject({ userId: A("li"), summary: expect.stringContaining("新建商机「工矿灯 2000 套」：方案报价") });
    }
    expect(await db("zhao").customer.findUnique({ where: { id: 客户 } })).toBeNull();
    expect(await db("zhao").opportunity.findUnique({ where: { id: 商机 } })).toBeNull();

    // 老板那台：两条（客户、商机），录的人是 li，点开去那位客户 / 那个商机
    expect(老板的.map((x) => [x.类, x.谁, x.谁名, x.名])).toEqual([["客户", A("li"), "li", "Nordlicht Leuchten GmbH"], ["商机", A("li"), "li", "工矿灯 2000 套"]]);
    expect(老板的[0].去).toBe(`/customers/${客户}`);
    expect(老板的[1].去).toBe(`/opportunities?opportunity=${商机}`);
    // 壳：同一个人这一批两条 → 一条通知
    const 壳们 = 假壳(Date.now());
    壳们.提醒.收(老板的, 默认开关);
    expect(壳们.发了.map((x) => x.title)).toEqual(["li 新增 1 位客户、1 个商机"]);
  });

  it("同一个人一分钟内又建了一位：先弹的那条收回，换成合并的一条；过了一分钟的另起一条", async () => {
    const 壳们 = 假壳(Date.now());
    await 手机.新建客户(机, 库, 状态, { name: "Fjord Lighting AS", email: "post@fjord.example", country: "挪威" });
    await 手机轮();
    壳们.提醒.收(await 都同步(), 默认开关);
    expect(壳们.还在().map((x) => x.title)).toEqual(["li 新建了客户"]);
    壳们.过(30_000);
    await 手机.新建客户(机, 库, 状态, { name: "Sol Iluminación SL", phone: "+34 600 111 222", country: "西班牙" });
    await 手机轮();
    壳们.提醒.收(await 都同步(), 默认开关);
    expect(壳们.发了).toHaveLength(2);
    expect(壳们.发了[0].收回了).toBe(true);
    expect(壳们.还在().map((x) => [x.title, x.body, x.去])).toEqual([["li 新增 2 位客户", "Fjord Lighting AS、Sol Iluminación SL", "/customers"]]);
    壳们.过(61_000);
    await 手机.新建客户(机, 库, 状态, { name: "Adriatic Light d.o.o.", whatsapp: "+385 91 000 1111" });
    await 手机轮();
    壳们.提醒.收(await 都同步(), 默认开关);
    expect(壳们.还在().map((x) => x.title)).toEqual(["li 新增 2 位客户", "li 新建了客户"]);
  });

  it("跟进默认不提醒；老板打开「新跟进」后才提醒", async () => {
    const 客户 = [...库.表("Customer")].find((r) => r.name === "Fjord Lighting AS")!.id as string;
    await 手机.记跟进(机, 库, 状态, { customerId: 客户, type: "EMAIL", content: "发了目录和报价单" });
    await 手机轮();
    const 老板的 = await 都同步();
    expect(老板的.map((x) => [x.类, x.名, x.题])).toEqual([["跟进", "Fjord Lighting AS", ""]]);
    const 关着 = 假壳(Date.now());
    关着.提醒.收(老板的, 默认开关);
    expect(关着.发了).toEqual([]);
    const 开着 = 假壳(Date.now());
    开着.提醒.收(老板的, { ...默认开关, 同事跟进: true });
    expect(开着.发了.map((x) => [x.title, x.去])).toEqual([["li 记了一条跟进", `/customers/${客户}`]]);
  });

  it("老板电脑离线一阵：li 在电脑上建了 12 位、zhao 建了 3 位；老板回来同步只弹一条汇总，不刷屏", async () => {
    当("li");
    for (let i = 1; i <= 12; i++) await db("li").customer.create({ data: { id: `bulk-li-${i}`, name: `批量客户 ${i}`, phone: `+4470000000${String(i).padStart(2, "0")}`, salesOwnerId: A("li") } });
    for (let i = 1; i <= 12; i++) await db("li").auditLog.create({ data: { userId: A("li"), userName: "li", action: "create", entity: "Customer", entityId: `bulk-li-${i}`, summary: `新建客户「批量客户 ${i}」` } });
    expect(await 轮取("li")).toEqual([]);
    当("zhao");
    for (let i = 1; i <= 3; i++) await db("zhao").customer.create({ data: { id: `bulk-zhao-${i}`, name: `赵的客户 ${i}`, phone: `+3360000000${i}`, salesOwnerId: A("zhao") } });
    expect(await 轮取("zhao")).toEqual([]);
    // 老板 20 分钟后才开机
    const 回来 = Date.now() + 20 * 60_000;
    const 老板的 = await 轮取("boss", 回来);
    expect(老板的).toHaveLength(15);
    expect(new Set(老板的.map((x) => x.谁名))).toEqual(new Set(["li", "zhao"]));
    const 壳们 = 假壳(回来);
    壳们.提醒.收(老板的, 默认开关);
    expect(壳们.发了).toHaveLength(1);
    expect(壳们.发了[0]).toMatchObject({ title: "li等 2 人新增 15 位客户", 去: "/customers" });
    expect(壳们.发了[0].body).toMatch(/等$/);
  });

  it("本人录的不提醒自己；起点之前的、同一行记了两遍的只算一次", async () => {
    当("boss");
    const 老板 = await db("boss").customer.create({ data: { id: "boss-own", name: "老板自己的客户", phone: "+861390000999", salesOwnerId: A("boss") } });
    const li的 = await db("boss").customer.findUnique({ where: { id: "bulk-li-1" } });
    const 现在 = Date.now();
    const 钟 = (ms: number) => `${String(ms).padStart(15, "0")}-d_test`;
    取走新插();
    记新插({ t: "Customer", k: 老板.id, h: 钟(现在) });
    记新插({ t: "Customer", k: li的!.id, h: 钟(现在) });
    记新插({ t: "Customer", k: li的!.id, h: 钟(现在 + 5) });
    记新插({ t: "Customer", k: "bulk-li-2", h: "0000000000000-snapshot" });
    记新插({ t: "Contact", k: "whatever", h: 钟(现在) });
    const r = await 同事新建提醒(db("boss"), client.读团队(), 现在);
    expect(r.map((x) => [x.名, x.at])).toEqual([["批量客户 1", 现在]]);
    // 不是老板那台：箱子照样取走，什么都不提醒
    记新插({ t: "Customer", k: li的!.id, h: 钟(现在) });
    当("zhao");
    expect(await 同事新建提醒(db("zhao"), client.读团队(), 现在)).toEqual([]);
    expect(取走新插()).toEqual([]);
  });

  it("手机记跟进挂订单 / 商机、用「微信沟通」：li 和老板的电脑上打开这条跟进看得到挂的是哪张订单 / 哪个商机，类型存 WECHAT（还不认识它的电脑照样落库）", async () => {
    const 客户 = [...库.表("Customer")].find((r) => r.name === "Nordlicht Leuchten GmbH")!.id as string;
    // li 在电脑上给这位客户开了一张订单（外贸模版）
    当("li");
    const 单 = await db("li").tradeOrder.create({ data: { no: "PI-20261019-1", customerId: 客户, ownerId: A("li"), amount: 36000, currency: "USD" } });
    expect(await 轮取("li")).toEqual([]);
    await 手机轮();
    const c = 客户们(分表(库.行.values()), A("li"), new Set()).find((x) => x.id === 客户)!;
    expect(c.可关联.订单).toEqual([{ id: 单.id, no: "PI-20261019-1" }]);
    const 商机 = c.可关联.商机[0].id;

    const { id: 挂单 } = await 手机.记跟进(机, 库, 状态, { customerId: 客户, type: "WECHAT", content: "微信上确认了唛头", 关联: `订单:${单.id}` });
    const { id: 挂商机 } = await 手机.记跟进(机, 库, 状态, { customerId: 客户, type: "WHATSAPP", content: "问了交期", 关联: 商机 });
    expect((await 手机轮()).推).toBe(5);
    expect(状态.被拒).toEqual([]);
    await 都同步();
    for (const w of ["li", "boss"] as const) {
      const a = await db(w).followUp.findUnique({ where: { id: 挂单 }, include: { orderNode: true } });
      expect(a).toMatchObject({ type: "WECHAT", content: "微信上确认了唛头", opportunityId: null, ownerId: A("li") });
      expect(a!.orderNode).toMatchObject({ orderId: 单.id, nodeIdx: 0 });
      const b = await db(w).followUp.findUnique({ where: { id: 挂商机 }, include: { orderNode: true } });
      expect(b).toMatchObject({ type: "WHATSAPP", opportunityId: 商机, orderNode: null });
      expect(await db(w).auditLog.findFirst({ where: { entityId: 挂单 } })).toMatchObject({ summary: expect.stringContaining("一条微信沟通跟进") });
    }
    expect(await db("zhao").followUp.findUnique({ where: { id: 挂单 } })).toBeNull();
  });
});
