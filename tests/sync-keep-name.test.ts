/**
 * 改过的名字不被改回注册名（2026-10-15，0.46.17 Windows 实测：0.46.16 里先改了名字再建团队，名字变回注册时填的「测试老板」）。
 *
 * 台子照抄 sync-device-link.test.ts（真实桌面端 lib/sync/client.ts + 真实中转、令牌真签发），只留三台：
 * boss、li、boss2（boss 账号的第二台电脑，新装的，本机名字是模板的「管理员」）。
 * 云端账号名注册时是 boss / li；.cloud.json 里的名字也是这两个（boss2 那份一直是旧的，验它不拿旧名字）。
 *
 * 验的是：
 *   - 先改名再建团队：名字留着，云端账号名跟着改
 *   - 先改名再加入：名字留着，老板那边同步看到的是新名字，云端跟着改
 *   - 第二台电脑连接：拿到云端现在的名字（不是登录时的旧名字），同步之后老板那台的名字也没被盖回去
 *   - 改名后云端名变化：在线改马上到云端；断网改的下次对一次时推上去；别处改的、本机没动过的跟云端
 *   - 云端改名接口的校验；手机「我的」页优先用团队里自己那行的名字
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li" | "boss2";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-keep-name-"));
  for (const who of ["boss", "li", "boss2"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as "boss" | "li" | "boss2" };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const mk = (w: string) => new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  const dbs = { boss: mk("boss"), li: mk("li"), boss2: mk("boss2") };
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  return { prisma };
});

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 新机 from "@/lib/sync/device-link";
import * as 名字 from "@/lib/desktop/my-name";
import { 我的名字 } from "@/lib/mobile/view";
import { 规整名字 } from "@/lib/tenant/account-name";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
let 账号名: typeof import("@/lib/tenant/account-name");
const 令牌: Record<string, string> = {};
const 账号: Record<"boss" | "li", string> = { boss: "", li: "" };
const 账号的: Record<谁, "boss" | "li"> = { boss: "boss", li: "li", boss2: "boss" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[账号的[w]]}`;
/** 断网开关：开着时桌面端和云端说话一律连不上 */
let 断网 = false;

async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const tk = await 令牌库.认领(raw);
  if (!tk) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const a = tk.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  // 和 app/api/account/name/route.ts 一样
  if (u.pathname === "/api/account/name") return 回(方法 === "GET" ? await 账号名.取账号名(a) : await 账号名.改账号名(a, b.name));
  if (u.pathname === "/api/sync/team" && 方法 === "GET") return { 状态: 200, json: { ok: true, teams: await relay.我的团队(a) } as Record<string, unknown> };
  if (u.pathname === "/api/sync/team") return 回(await relay.建团队(a, String(b.name), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/join") return 回(await relay.入队(a, String(b.teamId), String(b.joinSecret), { device: String(b.device), pubKey: String(b.pubKey), tokenId: tk.id }));
  if (u.pathname === "/api/sync/key") return 回(await relay.取钥匙(a, u.searchParams.get("teamId")!, u.searchParams.get("device")!));
  if (u.pathname === "/api/sync/pull") return 回(await relay.给拉取(a, u.searchParams.get("teamId")!, Number(u.searchParams.get("after"))));
  if (u.pathname === "/api/sync/push") return 回(await relay.收推送(a, String(b.teamId), String(b.device), String(b.data)));
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
  }
  return { 状态: 404, json: { error: `fake: ${路径}` } };
}
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 桌面传: 传输 = async (方法, 路径, body) => (断网 ? { 状态: 0, json: { error: "连不上云端，检查一下网络" } } : 过线(await 调中转(令牌[临时.谁], 方法, 路径, body)));

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
/** 登录时 / 启动时做的那一下：本机「我」对成云端账号（名字跟云端，记账），和 server-entry.js 一样 */
async function 像登录过(w: 谁, 云端名: string) {
  await db(w).user.update({ where: { id: "cmusc55660000dulko96ek8kr" }, data: { email: `${账号的[w]}@example.invalid`, name: 云端名 } });
  await db(w).setting.create({ data: { key: "desktop.syncedName", value: JSON.stringify(云端名) } });
}
/** 设置里「个人资料」改名：本机那一行改掉、云端跟着改（settings/actions.ts 改我的资料 的桌面端那一截） */
async function 设置里改名(w: 谁, 新名: string) {
  当(w);
  const 我 = await db(w).user.findFirst({ where: { OR: [{ id: A(w) }, { id: "cmusc55660000dulko96ek8kr" }] }, orderBy: { createdAt: "asc" } });
  await db(w).user.update({ where: { id: 我!.id }, data: { name: 新名 } });
  return 名字.云端跟着改名(client.调云, 新名);
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 云端名 = async (w: "boss" | "li") => (await control.account.findUnique({ where: { id: 账号[w] } }))!.name;
const 凭据名 = (w: 谁) => (JSON.parse(fs.readFileSync(path.join(临时.root, w, ".cloud.json"), "utf8")) as { name: string }).name;
const 名在 = async (w: 谁, 谁的: 谁) => (await db(w).user.findUnique({ where: { id: A(谁的) } }))?.name;

let 邀请码 = "";
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
  令牌库 = await import("@/lib/tenant/device-token");
  账号名 = await import("@/lib/tenant/account-name");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li"] as const) 账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
  for (const w of ["boss", "li", "boss2"] as const) {
    令牌[w] = (await 令牌库.签发(账号[账号的[w]], `${w}-机器`)).token;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 账号[账号的[w]], name: 账号的[w], contact: `${账号的[w]}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  // boss、li 是用了一阵的老电脑（登录过，名字对成了云端的）；boss2 是新装的，本机还是模板的「管理员」
  await 像登录过("boss", "boss");
  await 像登录过("li", "li");
  client.设传输(桌面传);
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of ["boss", "li", "boss2"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

describe("先改名再建团队 / 加入：改过的名字留着", () => {
  it("老板断网时改了名（云端没跟上），之后建团队：名字还是改过的，建之前先推给了云端", async () => {
    断网 = true;
    expect(await 设置里改名("boss", "王老板")).toBe(false);
    断网 = false;
    expect(await 云端名("boss")).toBe("boss");
    当("boss");
    const 码 = await client.建团队("改名QA");
    if (!码.ok) throw Error(码.error);
    邀请码 = 码.邀请码;
    await relay.设开通(client.读团队()!.teamId, true);
    expect(await 名在("boss", "boss")).toBe("王老板");
    expect(await 云端名("boss")).toBe("王老板");
    expect(凭据名("boss")).toBe("王老板");
    await 都轮("boss");
  });

  it("业务员在线改了名再加入：名字留着，云端跟着改，老板同步后看到的是新名字", async () => {
    expect(await 设置里改名("li", "李小明")).toBe(true);
    expect(await 云端名("li")).toBe("李小明");
    当("li");
    expect(await client.加入团队(邀请码)).toMatchObject({ ok: true });
    expect(await 名在("li", "li")).toBe("李小明");
    await 都轮("li", "boss", "li");
    expect(await 名在("boss", "li")).toBe("李小明");
    expect(await 名在("li", "boss")).toBe("王老板");
  });

  it("改身份本身：本机改过的名字不被云端名盖掉；还是模板「管理员」的才用云端名", async () => {
    const { 改身份 } = await import("@/lib/sync/local");
    当("boss2");
    const 临 = db("boss2");
    await 临.user.create({ data: { id: "u-tmp", email: "tmp", name: "  自己起的  ", role: "ADMIN", password: "x", createdAt: new Date("2026-09-01T00:00:00Z") } });
    await 改身份(临, "acct_tmp", { email: "tmp@example.invalid", name: "注册名" });
    expect(await 临.user.findUnique({ where: { id: "acct_tmp" } })).toMatchObject({ email: "tmp@example.invalid", name: "自己起的" });
    await 临.user.update({ where: { id: "acct_tmp" }, data: { name: "管理员" } });
    await 改身份(临, "acct_tmp", { email: "tmp@example.invalid", name: "注册名" });
    expect((await 临.user.findUnique({ where: { id: "acct_tmp" } }))?.name).toBe("注册名");
    await 临.user.delete({ where: { id: "acct_tmp" } });
  });
});

describe("第二台电脑连接", () => {
  it("新装的 boss2（本机「管理员」、.cloud.json 里还是旧名字）连上后拿到的是现在的名字，同步后老板那台也没被盖回去", async () => {
    当("boss2");
    expect(凭据名("boss2")).toBe("boss");
    const r = await 新机.发起连接();
    expect(r.ok).toBe(true);
    当("boss");
    const p = await 授权.待授权手机();
    expect(p.ok && p.手机.length).toBe(1);
    expect(await 授权.允许手机(p.ok ? p.手机[0].id : "")).toEqual({ ok: true });
    当("boss2");
    expect(await 新机.查连接()).toMatchObject({ ok: true, status: "joined" });
    expect(await 名在("boss2", "boss2")).toBe("王老板");
    expect(凭据名("boss2")).toBe("王老板");
    await 都轮("boss2", "boss", "li", "boss2", "boss");
    for (const w of ["boss", "li", "boss2"] as const) expect(await 名在(w, "boss")).toBe("王老板");
    expect(await 云端名("boss")).toBe("王老板");
  });
});

describe("改名后云端名跟着变", () => {
  it("在团队里再改一次（在线）：云端马上变，团队里同步后都是新名字", async () => {
    expect(await 设置里改名("boss2", "王总")).toBe(true);
    expect(await 云端名("boss")).toBe("王总");
    await 都轮("boss2", "boss", "li");
    expect(await 名在("boss", "boss")).toBe("王总");
    expect(await 名在("li", "boss")).toBe("王总");
    // 老板那台：名字是同步过来的、云端已经是它了，对一次就是「一样」，记账跟上
    当("boss");
    expect(await 名字.对齐我的名字(client.调云)).toBe("一样");
    expect(凭据名("boss")).toBe("王总");
  });

  it("断网时改的：当场推不上，下一次对一次（登录、建团队前）推上去", async () => {
    断网 = true;
    expect(await 设置里改名("li", "李经理")).toBe(false);
    当("li");
    expect(await 名字.对齐我的名字(client.调云)).toBe("没对上");
    断网 = false;
    expect(await 云端名("li")).toBe("李小明");
    当("li");
    expect(await 名字.对齐我的名字(client.调云)).toBe("推了");
    expect(await 云端名("li")).toBe("李经理");
    expect(凭据名("li")).toBe("李经理");
  });

  it("别处改了云端、这台本机没动过：这台跟云端（以最后一次改的为准）", async () => {
    await 账号名.改账号名(账号.li, "李总");
    当("li");
    expect(await 名字.对齐我的名字(client.调云)).toBe("跟了云端");
    expect(await 名在("li", "li")).toBe("李总");
    expect(凭据名("li")).toBe("李总");
    // 改的是自己那一行：同步给团队
    await 都轮("li", "boss");
    expect(await 名在("boss", "li")).toBe("李总");
  });
});

describe("云端改名接口、手机「我的」", () => {
  it("校验：去空白、不能空、最多 20 个字、不收控制字符和非文字", async () => {
    expect(规整名字("  王  小明 \n")).toEqual({ ok: true, name: "王 小明" });
    expect(规整名字("   ")).toMatchObject({ ok: false });
    expect(规整名字("一".repeat(20))).toMatchObject({ ok: true });
    expect(规整名字("一".repeat(21))).toMatchObject({ ok: false });
    expect(规整名字("王\u0000")).toMatchObject({ ok: false });
    expect(规整名字(42)).toMatchObject({ ok: false });
    expect(await 账号名.改账号名(账号.boss, "")).toMatchObject({ ok: false, 状态: 400 });
    expect(await 云端名("boss")).toBe("王总");
    expect(await 账号名.改账号名("没有这个号", "某某")).toMatchObject({ ok: false, 状态: 401 });
  });

  it("只改得了自己：用 li 的令牌改名，老板的云端名不动", async () => {
    当("li");
    const r = await 桌面传("POST", "/api/account/name", { name: "李四" });
    expect(r).toMatchObject({ 状态: 200, json: { name: "李四" } });
    expect(await 云端名("li")).toBe("李四");
    expect(await 云端名("boss")).toBe("王总");
    await 账号名.改账号名(账号.li, "李总");
  });

  it("手机「我的」：有团队里自己那一行就用它的名字，没有才用账号名", () => {
    const 行们 = new Map([["User:acct_x", { t: "User", k: "acct_x", r: { id: "acct_x", name: " 王总 " }, h: "" }]]);
    expect(我的名字(行们 as never, "acct_x", "注册名")).toBe("王总");
    expect(我的名字(行们 as never, "acct_y", "注册名")).toBe("注册名");
    expect(我的名字(new Map(), "", "注册名")).toBe("注册名");
  });
});
