/**
 * 本人的新电脑经配对批准连上团队，**这台电脑上本来就有客户**（2026-10-16 用户问到）：
 * 电脑 A 已在团队里、云上有客户；电脑 B 连上前自己也录了客户。连接页答应用户的是：
 * 「这台电脑上已有的 N 位客户会带进团队，和云上的合在一起、不覆盖；同一位客户两边各有一份的列在疑似重复；连上之前会先自动备份」。
 * 合并靠 lib/sync/device-link.ts 收下() → 本机开同步(true) 记全量（和邀请码加入同一段），这里端到端核一遍：
 *   - 先备份（backups/before-device-link-*.db，是连之前原样的库）
 *   - B 的客户 / 联系人 / 跟进 / 商机 / 计划作为本人的推上去；A、B 最后都是两边的总和，谁也没盖掉谁
 *   - B 的业务配置（模版、币种）不推，以团队为准
 *   - 同一位客户两边各一份：两边都在「疑似重复」里
 *   - B 上有客户挂在模板占位账号（张三 / 李四）名下：业务员身份连上不被范围策略拒、本机不被当失权清掉（修了：归到本人）；
 *     老板身份连上照原样带进团队（老板什么都能推），「没同步上」「待老板核对」都是空的
 *   - 老板本人的第二台电脑：建团队那台批准（能管理团队）、手机批准（只同步、管不了）两种
 * 台子照抄 sync-device-link.test.ts / mobile-approve.test.ts：真实桌面端 lib/sync/client.ts + 真实中转（临时控制库），令牌真签发；手机走 lib/mobile。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

type 谁 = "boss" | "li" | "zhao" | "li2" | "boss2" | "boss3" | "wang";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-device-link-merge-"));
  for (const who of ["boss", "li", "zhao", "li2", "boss2", "boss3", "wang"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "zhao" | "li2" | "boss2" | "boss3" | "wang" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), zhao: mk("zhao"), li2: mk("li2"), boss2: mk("boss2"), boss3: mk("boss3"), wang: mk("wang") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 新机 from "@/lib/sync/device-link";
import * as 密 from "@/lib/sync/crypto-web";
import * as 手机 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import { 疑似重复 } from "@/lib/sync/dupes";
import { 没同步上 } from "@/lib/sync/local";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
let 我的: typeof import("@/lib/tenant/my-devices");
const 令牌: Record<string, string> = {};
const 账号: Record<"boss" | "li" | "zhao" | "wang", string> = { boss: "", li: "", zhao: "", wang: "" };
const 账号的: Record<谁, "boss" | "li" | "zhao" | "wang"> = { boss: "boss", li: "li", zhao: "zhao", li2: "li", boss2: "boss", boss3: "boss", wang: "wang" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[账号的[w]]}`;

async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const tk = await 令牌库.认领(raw);
  if (!tk) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const a = tk.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/sync/my-devices") {
    if (b.action === "list") return 回(await 我的.我的设备(a, String(b.teamId), tk.id) as never);
    if (b.action === "remove") return 回(await 我的.移除我的设备(a, String(b.teamId), String(b.device), tk.id));
  }
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
  if (u.pathname === "/api/sync/leave") return 回(await relay.退队(a, String(b.teamId), typeof b.device === "string" ? b.device : undefined));
  if (u.pathname === "/api/sync/remove") return 回(await relay.移除成员(a, String(b.teamId), String(b.accountId)));
  if (u.pathname === "/api/sync/secret") return 回(await relay.换口令(a, String(b.teamId)));
  if (u.pathname === "/api/sync/devices") return 回(await relay.团队设备(a, u.searchParams.get("teamId")!));
  if (u.pathname === "/api/sync/rotate") return 回(await relay.换钥匙(a, String(b.teamId), Number(b.epoch), String(b.ring), b.envelopes as never));
  if (u.pathname === "/api/sync/scoped") {
    const t = String(b.teamId), act = String(b.action);
    try {
      if (act !== "state" && !(await scoped.范围开放(t))) return { 状态: 404, json: { error: "范围同步尚未开放" } };
      if (act === "directory" || act === "pull" || act === "push") await scoped.核设备(a, t, b.device, tk.id);
      let r: unknown;
      if (act === "state") r = await scoped.范围状态(a, t);
      else if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied } : { error: e.message } };
      throw e;
    }
  }
  if (u.pathname === "/api/mobile/link") {
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const act = b.action;
    if (act === "request") return 回(await link.申请(a, tk.id, { device: b.device, pubKey: b.pubKey, label: b.label }));
    if (act === "status") return 回(await link.我的申请(a, tk.id));
    if (act === "pending") return 回(await link.待授权(a) as never);
    if (act === "challenge") return 回(await link.挑战(a, s(b.id), s(b.teamId), s(b.device)));
    if (act === "approve") return 回(await link.允许(a, s(b.id), s(b.teamId), s(b.sealed), s(b.nonce)));
    if (act === "deny") return 回(await link.拒绝(a, s(b.id)));
    if (act === "list") return 回(await link.已连接(a) as never);
    if (act === "remove") return 回(await link.移除(a, s(b.id)));
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 桌面传: 传输 = async (方法, 路径, body) => 过线(await 调中转(令牌[临时.谁], 方法, 路径, body));
const 用令牌 = (名: string): 手机.传输 => async (方法, 路径, body) => 过线(await 调中转(令牌[名], 方法, 路径, body));

/** 桌面端模板库里固定种的三个账号：每台电脑上 id 都一样（scripts/build-template.mjs） */
const 模板 = { 管理员: "cmusc55660000dulko96ek8kr", 张三: "cmusc55680001dulki71dcsts", 李四: "cmusc55690002dulk1u0ifs17" };
async function 清空种模板(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 起 = new Date("2026-10-01T00:00:00Z");
  await d.user.create({ data: { id: 模板.管理员, email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: 起 } });
  await d.user.create({ data: { id: 模板.张三, email: "zhangsan", name: "张三", role: "SALES", password: "x", title: "销售", createdAt: 起 } });
  await d.user.create({ data: { id: 模板.李四, email: "lisi", name: "李四", role: "SALES", password: "x", title: "销售", createdAt: 起 } });
}
const 业务配置 = (币种: string) => JSON.stringify({ currency: 币种, template: 币种 === "CNY" ? "edu" : "trade" });
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w), w).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };
const 客户们 = async (w: 谁) => (await db(w).customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
const 设置 = async (w: 谁) => (await db(w).setting.findUnique({ where: { key: "business" } }))?.value ?? null;
/** 「没同步上」「待老板核对」都要是空的（团队状态 里给界面的那两样） */
async function 都同步上了(w: 谁) {
  当(w);
  expect((await 没同步上(db(w))).条数, `${w} 没同步上`).toBe(0);
  expect((await client.范围同步概况()).冲突, `${w} 待老板核对`).toBe(0);
  // 界面上不算的「孤儿」（父记录没到）也不能有：有就是哪条没落下来
  expect(await db(w).$queryRawUnsafe("SELECT tbl, pk, why FROM _sync_skip"), `${w} 回放跳过`).toEqual([]);
}
const 备份们 = (w: 谁) => { const d = path.join(临时.root, w, "backups"); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("before-device-link-")) : []; };
/** 打开备份：看里面的客户和负责人 */
function 备份里的客户(w: 谁) {
  const [f] = 备份们(w);
  const d = new DatabaseSync(path.join(临时.root, w, "backups", f));
  try { return d.prepare('SELECT id, salesOwnerId FROM "Customer" ORDER BY id').all() as { id: string; salesOwnerId: string }[]; } finally { d.close(); }
}
/** 在本人已连上的电脑上批准（电脑的授权框） */
async function 电脑批(w: 谁) {
  当(w);
  const p = await 授权.待授权手机();
  expect(p.ok && p.手机.length, `${w} 待授权`).toBe(1);
  expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
}

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
  link = await import("@/lib/tenant/mobile-link");
  我的 = await import("@/lib/tenant/my-devices");
  令牌库 = await import("@/lib/tenant/device-token");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li", "zhao", "wang"] as const) 账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
  for (const w of ["boss", "li", "zhao", "li2", "boss2", "boss3", "wang"] as const) {
    const 号 = 账号[账号的[w]];
    令牌[w] = (await 令牌库.签发(号, `${w}-机器`)).token;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 号, name: 账号的[w], contact: `${账号的[w]}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空种模板(db(w));
  }
  client.设传输(桌面传);
  // 电脑 A：老板建团队（团队的业务配置是人民币那套），li、zhao 用邀请码加入；云上已有 li 的客户（带联系人、跟进、商机）和老板的私客
  await db("boss").setting.create({ data: { key: "business", value: 业务配置("CNY") } });
  当("boss");
  const 码 = await client.建团队("合并QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await 都轮("boss");
  for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true }); }
  await 都轮("li", "zhao", "boss", "li", "zhao");
  await db("li").customer.create({ data: { id: "c-li", name: "Atlas Home Supplies", phone: "+14155550132", salesOwnerId: A("li"), remark: "云上这份" } });
  await db("li").contact.create({ data: { id: "ct-li", name: "Tom", customerId: "c-li", isPrimary: true } });
  await db("li").followUp.create({ data: { id: "f-li", customerId: "c-li", ownerId: A("li"), type: "SMS", title: "", content: "样品周一到仓" } });
  await db("li").opportunity.create({ data: { id: "o-li", name: "Atlas 首单", amount: 1200, customerId: "c-li", ownerId: A("li") } });
  await db("boss").customer.create({ data: { id: "c-boss", name: "老板自己的客户", phone: "+8613900000001", salesOwnerId: A("boss") } });
  await 都轮("li", "zhao", "boss", "li", "zhao");
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "zhao", "li2", "boss2", "boss3", "wang"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

describe("业务员 li 的第二台电脑 B（本来就有客户）经配对连上", () => {
  it("B 连上前录的：自己的客户（联系人、跟进、商机、计划）、和云上同一位客户的另一份、挂在张三 / 李四名下的；业务配置是美元那套", async () => {
    const d = db("li2");
    await d.setting.create({ data: { key: "business", value: 业务配置("USD") } });
    await d.customer.create({ data: { id: "c-b-own", name: "B 上自己录的", phone: "+8613900000222", salesOwnerId: 模板.管理员 } });
    await d.contact.create({ data: { id: "ct-b-own", name: "王经理", customerId: "c-b-own" } });
    await d.followUp.create({ data: { id: "f-b-own", customerId: "c-b-own", ownerId: 模板.管理员, type: "PHONE", title: "", content: "B 上记的跟进" } });
    await d.opportunity.create({ data: { id: "o-b-own", name: "B 上的商机", amount: 300, customerId: "c-b-own", ownerId: 模板.管理员 } });
    await d.followPlan.create({ data: { id: "p-b-own", subject: "下周回访", plannedAt: new Date("2026-10-20T02:00:00Z"), customerId: "c-b-own", ownerId: 模板.管理员 } });
    // 同一位客户：号码和云上 c-li 一样，B 上另录了一份
    await d.customer.create({ data: { id: "c-b-dup", name: "Atlas（B 上录的）", phone: "+14155550132", salesOwnerId: 模板.管理员, remark: "B 上这份" } });
    // 单机时分给了模板里的张三、李四（跟进是张三记的）
    await d.customer.create({ data: { id: "c-b-zs", name: "分给张三的", phone: "+8613900000333", salesOwnerId: 模板.张三 } });
    await d.followUp.create({ data: { id: "f-b-zs", customerId: "c-b-zs", ownerId: 模板.张三, type: "PHONE", title: "", content: "张三记的" } });
    await d.customer.create({ data: { id: "c-b-ls", name: "渠道是李四的", phone: "+8613900000444", salesOwnerId: 模板.管理员, channelOwnerId: 模板.李四 } });
    当("li2");
    expect((await 新机.连接概况()).本机客户).toBe(4);
  });

  it("li 的电脑 A 批准：B 连上前先原样备份了一份（还是单机时的样子）", async () => {
    当("li2");
    expect((await 新机.发起连接()).ok).toBe(true);
    await 电脑批("li");
    当("li2");
    expect(await 新机.查连接()).toEqual({ ok: true, status: "joined", teamName: "合并QA" });
    expect(备份们("li2")).toHaveLength(1);
    expect(备份里的客户("li2")).toEqual([
      { id: "c-b-dup", salesOwnerId: 模板.管理员 },
      { id: "c-b-ls", salesOwnerId: 模板.管理员 },
      { id: "c-b-own", salesOwnerId: 模板.管理员 },
      { id: "c-b-zs", salesOwnerId: 模板.张三 },
    ]);
  });

  it("同步后 A、B 都是两边的总和；谁也没盖掉谁；老板看得到、同事 zhao 看不到", async () => {
    await 都轮("li2", "li", "boss", "zhao", "li2", "li");
    const 应有 = ["c-b-dup", "c-b-ls", "c-b-own", "c-b-zs", "c-li"];
    expect(await 客户们("li")).toEqual(应有);
    expect(await 客户们("li2")).toEqual(应有);
    expect(await 客户们("boss")).toEqual(["c-boss", ...应有].sort());
    expect(await 客户们("zhao")).toEqual([]);
    for (const w of ["li", "li2", "boss"] as const) {
      const d = db(w);
      expect(await d.customer.findUnique({ where: { id: "c-li" } }), w).toMatchObject({ name: "Atlas Home Supplies", remark: "云上这份", salesOwnerId: A("li") });
      expect(await d.customer.findUnique({ where: { id: "c-b-dup" } }), w).toMatchObject({ name: "Atlas（B 上录的）", remark: "B 上这份", salesOwnerId: A("li") });
      expect(await d.customer.findUnique({ where: { id: "c-b-own" } }), w).toMatchObject({ name: "B 上自己录的", salesOwnerId: A("li") });
      expect(await d.contact.findUnique({ where: { id: "ct-b-own" } }), w).toMatchObject({ name: "王经理", customerId: "c-b-own" });
      expect(await d.followUp.findUnique({ where: { id: "f-b-own" } }), w).toMatchObject({ content: "B 上记的跟进", ownerId: A("li") });
      expect(await d.opportunity.findUnique({ where: { id: "o-b-own" } }), w).toMatchObject({ name: "B 上的商机", amount: 300, ownerId: A("li") });
      expect(await d.followPlan.findUnique({ where: { id: "p-b-own" } }), w).toMatchObject({ subject: "下周回访", ownerId: A("li") });
      expect(await d.contact.findUnique({ where: { id: "ct-li" } }), w).toMatchObject({ name: "Tom" });
      expect(await d.followUp.findUnique({ where: { id: "f-li" } }), w).toMatchObject({ content: "样品周一到仓" });
      expect(await d.opportunity.findUnique({ where: { id: "o-li" } }), w).toMatchObject({ name: "Atlas 首单", amount: 1200 });
    }
  });

  it("挂在张三 / 李四名下的：业务员身份连上，归到本人，推上去没被拒、本机也没被当失权清掉", async () => {
    for (const w of ["li", "li2", "boss"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-b-zs" } }), w).toMatchObject({ name: "分给张三的", salesOwnerId: A("li") });
      expect(await db(w).followUp.findUnique({ where: { id: "f-b-zs" } }), w).toMatchObject({ content: "张三记的", ownerId: A("li") });
      expect(await db(w).customer.findUnique({ where: { id: "c-b-ls" } }), w).toMatchObject({ salesOwnerId: A("li"), channelOwnerId: A("li") });
    }
    // 占位账号不再留在 B 上，也没有变成团队里多出来的「人」
    expect(await db("li2").user.count({ where: { name: { in: ["张三", "李四"] } } })).toBe(0);
    for (const w of ["li", "boss", "zhao"] as const) expect(await db(w).user.count({ where: { email: { startsWith: "zhangsan" } } }), w).toBe(0);
    for (const w of ["li2", "li", "boss", "zhao"] as const) await 都同步上了(w);
  });

  it("B 的业务配置（美元那套）没推上去：团队还是人民币那套，B 同步后也跟着团队", async () => {
    expect(await 设置("boss")).toBe(业务配置("CNY"));
    expect(await 设置("li")).toBe(业务配置("CNY"));
    expect(await 设置("li2")).toBe(业务配置("CNY"));
  });

  it("同一位客户两边各一份：A、B、老板那台的「疑似重复」里都有这一组", async () => {
    for (const w of ["li", "li2", "boss"] as const) {
      当(w);
      const 组 = (await 疑似重复()).find((g) => g.记录.some((r) => r.id === "c-li"));
      expect(组, w).toBeTruthy();
      expect(组!.记录.map((r) => r.id).sort(), w).toEqual(["c-b-dup", "c-li"]);
    }
  });

  it("连上之后两边照常互通：B 改自己那份、A 记一笔，各自看得到", async () => {
    当("li2");
    await db("li2").customer.update({ where: { id: "c-b-own" }, data: { remark: "B 连上后改的" } });
    当("li");
    await db("li").followUp.create({ data: { id: "f-li-after", customerId: "c-b-own", ownerId: A("li"), type: "PHONE", title: "", content: "A 上给 B 的客户记的" } });
    await 都轮("li2", "li", "li2");
    expect(await db("li").customer.findUnique({ where: { id: "c-b-own" } })).toMatchObject({ remark: "B 连上后改的" });
    expect(await db("li2").followUp.findUnique({ where: { id: "f-li-after" } })).toMatchObject({ content: "A 上给 B 的客户记的" });
    for (const w of ["li2", "li"] as const) await 都同步上了(w);
  });
});

describe("老板本人的第二台电脑（我是建的人）", () => {
  it("建团队那台批准 boss2：带着张三 / 李四名下的客户连上，推送没被拒，老板能管理团队；同事看不到老板的私客", async () => {
    const d = db("boss2");
    await d.setting.create({ data: { key: "business", value: 业务配置("USD") } });
    await d.customer.create({ data: { id: "c-b2-own", name: "boss2 自己录的", phone: "+8613900000555", salesOwnerId: 模板.管理员 } });
    await d.followUp.create({ data: { id: "f-b2-own", customerId: "c-b2-own", ownerId: 模板.管理员, type: "PHONE", title: "", content: "boss2 记的" } });
    await d.customer.create({ data: { id: "c-b2-zs", name: "boss2 分给张三的", phone: "+8613900000666", salesOwnerId: 模板.张三 } });
    await d.opportunity.create({ data: { id: "o-b2-zs", name: "张三的商机", customerId: "c-b2-zs", ownerId: 模板.张三 } });
    // 和云上老板的私客同一位
    await d.customer.create({ data: { id: "c-b2-dup", name: "老板的客户（boss2 上录的）", phone: "+8613900000001", salesOwnerId: 模板.管理员 } });
    当("boss2");
    expect((await 新机.发起连接()).ok).toBe(true);
    await 电脑批("boss");
    当("boss2");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    expect(备份里的客户("boss2").map((c) => c.id)).toEqual(["c-b2-dup", "c-b2-own", "c-b2-zs"]);
    const c = 读配置("boss2");
    expect(client.能管理团队(c)).toBe(true);
    await 都轮("boss2", "boss", "li", "zhao", "boss2");
    for (const w of ["boss", "boss2"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-boss" } }), w).toMatchObject({ name: "老板自己的客户" });
      expect(await db(w).customer.findUnique({ where: { id: "c-b2-own" } }), w).toMatchObject({ salesOwnerId: A("boss") });
      expect(await db(w).followUp.findUnique({ where: { id: "f-b2-own" } }), w).toMatchObject({ content: "boss2 记的", ownerId: A("boss") });
      // 老板身份：张三名下的照原样带进团队（挂在改了 id 的张三名下），老板那台看得到
      const zs = await db(w).customer.findUnique({ where: { id: "c-b2-zs" }, include: { salesOwner: true } });
      expect(zs?.salesOwner, w).toMatchObject({ name: "张三" });
      expect(zs?.salesOwnerId, w).not.toBe(模板.张三);
      expect(await db(w).opportunity.findUnique({ where: { id: "o-b2-zs" } }), w).toMatchObject({ ownerId: zs!.salesOwnerId });
      expect(await db(w).customer.findUnique({ where: { id: "c-li" } }), w).toMatchObject({ name: "Atlas Home Supplies" });
      当(w);
      expect((await 疑似重复()).find((g) => g.记录.some((r) => r.id === "c-boss"))?.记录.map((r) => r.id).sort(), w).toEqual(["c-b2-dup", "c-boss"]);
    }
    for (const w of ["li", "zhao"] as const) for (const id of ["c-b2-own", "c-b2-zs", "c-b2-dup", "c-boss"]) expect(await db(w).customer.findUnique({ where: { id } }), `${w} ${id}`).toBeNull();
    expect(await 设置("boss")).toBe(业务配置("CNY"));
    expect(await 设置("boss2")).toBe(业务配置("CNY"));
    for (const w of ["boss2", "boss", "li", "zhao"] as const) await 都同步上了(w);
  });

  it("老板的手机批准 boss3（先在建团队那台移掉 boss2 腾出名额）：带着李四名下的客户连上，同样都推上去；管不了团队", async () => {
    // 老板这时有：建团队那台、boss2；再连手机就满 3 台了，先移掉 boss2
    const boss2 = 读配置("boss2").device;
    当("boss");
    expect(await 授权.移除设备(boss2)).toEqual({ ok: true });
    当("boss");
    expect(await client.老板补换钥匙(true)).toMatchObject({ ok: true, 换了: true });
    令牌["boss-p"] = (await 令牌库.签发(账号.boss, "手机 · boss-p")).token;
    const 钥 = await 密.设备钥匙对();
    const device = 连.新设备号();
    const 云 = 用令牌("boss-p");
    expect((await 云("POST", "/api/mobile/link", { action: "request", device, pubKey: 钥.公钥, label: "iPhone · boss-p" })).状态).toBe(200);
    await 电脑批("boss");
    const r = await 连.查申请(云, { device, 私钥: 钥.私钥 });
    if (r.status !== "approved") throw Error("手机没批下来");
    const 库 = new 手机.内存库(), 态 = 手机.新状态();
    const 团 = (await 手机.同步一轮(r.团队, 云, 库, 态)).c;

    const d = db("boss3");
    await d.setting.create({ data: { key: "business", value: 业务配置("USD") } });
    await d.customer.create({ data: { id: "c-b3-own", name: "boss3 自己录的", phone: "+8613900000777", salesOwnerId: 模板.管理员 } });
    await d.customer.create({ data: { id: "c-b3-ls", name: "boss3 渠道是李四的", phone: "+8613900000888", salesOwnerId: 模板.管理员, channelOwnerId: 模板.李四 } });
    await d.followPlan.create({ data: { id: "p-b3-ls", subject: "李四的计划", plannedAt: new Date("2026-10-21T02:00:00Z"), customerId: "c-b3-ls", ownerId: 模板.李四 } });
    当("boss3");
    expect((await 新机.发起连接()).ok).toBe(true);
    const [x] = await 连.待授权的(云);
    expect(x).toMatchObject({ 电脑: true });
    await 连.允许设备(云, 团, "合并QA", x.id);
    当("boss3");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    expect(备份们("boss3")).toHaveLength(1);
    const c = 读配置("boss3");
    expect(c.signPriv).toBeUndefined();
    expect(client.能管理团队(c)).toBe(false);
    await 都轮("boss3", "boss", "li", "zhao", "boss3");
    for (const w of ["boss", "boss3"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-b3-own" } }), w).toMatchObject({ salesOwnerId: A("boss") });
      const ls = await db(w).customer.findUnique({ where: { id: "c-b3-ls" }, include: { channelOwner: true } });
      expect(ls?.channelOwner, w).toMatchObject({ name: "李四" });
      expect(await db(w).followPlan.findUnique({ where: { id: "p-b3-ls" } }), w).toMatchObject({ subject: "李四的计划", ownerId: ls!.channelOwnerId });
      // 前面几台带进来的都在
      for (const id of ["c-boss", "c-b2-own", "c-b2-zs", "c-b-own", "c-li"]) expect(await db(w).customer.findUnique({ where: { id } }), `${w} ${id}`).toBeTruthy();
    }
    expect(await 设置("boss3")).toBe(业务配置("CNY"));
    for (const id of ["c-b3-own", "c-b3-ls"]) expect(await db("li").customer.findUnique({ where: { id } }), id).toBeNull();
    for (const w of ["boss3", "boss", "li", "zhao"] as const) await 都同步上了(w);
  });
});

describe("同一段代码的另一条路：新同事用邀请码加入", () => {
  it("wang 单机时把客户分给了张三：业务员身份加入，同样归到本人，老板看得到，什么都没被拒", async () => {
    const d = db("wang");
    await d.customer.create({ data: { id: "c-w-zs", name: "wang 分给张三的", phone: "+8613900000999", salesOwnerId: 模板.张三 } });
    await d.followUp.create({ data: { id: "f-w-zs", customerId: "c-w-zs", ownerId: 模板.张三, type: "PHONE", title: "", content: "wang 单机时记的" } });
    const 码 = client.邀请码(读配置("boss"));
    当("wang");
    expect(await client.加入团队(码)).toMatchObject({ ok: true });
    await 都轮("wang", "boss", "wang");
    for (const w of ["wang", "boss"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-w-zs" } }), w).toMatchObject({ salesOwnerId: A("wang") });
      expect(await db(w).followUp.findUnique({ where: { id: "f-w-zs" } }), w).toMatchObject({ ownerId: A("wang") });
    }
    expect(await db("li").customer.findUnique({ where: { id: "c-w-zs" } })).toBeNull();
    for (const w of ["wang", "boss"] as const) await 都同步上了(w);
  });
});
