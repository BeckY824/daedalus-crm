/**
 * 团队版同步 QA 补测（2026-10-19 团队版主动排查）：tests/team-full-check.test.ts 没走到的多人 / 多设备场景。
 *
 * 一个老板 + 两个业务员（李、赵），电脑 4 台（boss、li、li2、zhao），手机若干（boss-m、li-m、zhao-m，排查设备上限时再加 li-m2、li-m3）。
 * 台子照抄 team-full-check.test.ts：真实桌面端 lib/sync/client.ts + 真实中转（临时控制库、令牌真签发、路由顺序照 route.ts），
 * 手机走 lib/mobile（内存库）。服务端开着范围同步（正式服 CRM_SCOPED_SYNC=1）。
 *
 * 写的是「应该怎样」；产品现在不是这样的用 it.fails 标出来，注释里写清楚是什么问题——整份照样是绿的，问题记在案。
 *
 *   A. 成员（电脑 / 手机）新建客户、商机、跟进 → 老板的电脑和手机都看得到
 *   H. 老板的手机看全队、成员的手机只看本人 + 公海
 *   D. 同时改同一条：电脑 vs 手机（同一条计划）、同一毫秒打平、三台电脑同改一格；D4 两人同时领公海同一位；D5 一边删一边改
 *   F. 手机断网新建客户，同事这期间录了同一个号码；F2 联网时电脑上查重查不查得到同事的号码
 *   G. 手机断网记跟进，这期间客户进了公海 / 被删了；G3 手机断网新建商机、客户被转走
 *   E. 设备上限：第 4 台是手机；两部手机同时等批、批第二部时满了；移除一台腾出位置
 *   C. 到期暂停期间手机新建、电脑交接 → 续费后都补上
 *   B. 移除成员后他名下的客户归谁、老板转给别人；被移除的人重新加入不能抢回；成员自己退出时手机清数据
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 电脑们 = ["boss", "li", "li2", "zhao"] as const;
type 谁 = (typeof 电脑们)[number];
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-qa-sync-"));
  for (const who of ["boss", "li", "li2", "zhao"]) {
    fs.mkdirSync(path.join(root, who), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(root, who, "crm.db"));
    if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(root, who, "crm.db-wal"));
  }
  return { root, 谁: "boss" as string };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const dbs: Record<string, InstanceType<typeof PrismaClient>> = {};
  for (const w of ["boss", "li", "li2", "zhao"]) dbs[w] = new PrismaClient({ datasourceUrl: `file:${path.join(临时.root, w, "crm.db")}?connection_limit=1` });
  // 和真桌面端一样开库（src/lib/prisma.ts）：WAL + synchronous=NORMAL + 等锁 5 秒
  for (const d of Object.values(dbs)) {
    await d.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    await d.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    await d.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  }
  (globalThis as { __dbs?: typeof dbs }).__dbs = dbs;
  const prisma = new Proxy({}, { get: (_t, p) => { const db = dbs[临时.谁] as unknown as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(db) : v; } });
  // 查重里 限定的我(defaultClient) 认「我」用：同一个按当前电脑切换的库
  return { prisma, defaultClient: prisma };
});
// 查重（customers/actions.ts checkDuplicate）要的两样：登录的人、页面缓存
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => (globalThis as { __登录的?: unknown }).__登录的 }));

import type { PrismaClient } from "@/generated/prisma";
import type { 传输 } from "@/lib/sync/client";
import * as 授权 from "@/lib/sync/mobile-desktop";
import * as 新机 from "@/lib/sync/device-link";
import * as 密 from "@/lib/sync/crypto-web";
import * as 手机 from "@/lib/mobile/sync";
import * as 连 from "@/lib/mobile/link";
import { 要清掉 } from "@/lib/mobile/view";
import { 疑似重复 } from "@/lib/sync/dupes";
import { 没同步上 } from "@/lib/sync/local";
import { 列出范围冲突 } from "@/lib/sync/scoped-local";
import { 忘掉限定 } from "@/lib/team-scope";
import { checkDuplicate, saveCustomer } from "@/app/(app)/customers/actions";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let link: typeof import("@/lib/tenant/mobile-link");
let 令牌库: typeof import("@/lib/tenant/device-token");
let 我的: typeof import("@/lib/tenant/my-devices");
let 开通: typeof import("@/lib/tenant/team-plan");
let 账号名: typeof import("@/lib/tenant/account-name");

type 人 = "boss" | "li" | "zhao";
const 账号: Record<人, string> = { boss: "", li: "", zhao: "" };
const 账号的: Record<谁, 人> = { boss: "boss", li: "li", li2: "li", zhao: "zhao" };
const 令牌: Record<string, string> = {};
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (p: 人) => `acct_${账号[p]}`;

/** 假的「云端」：按令牌认人，路径和顺序照 src/app/api/**\/route.ts（scoped 先核设备再分动作）——照抄 team-full-check */
async function 调中转(raw: string, 方法: string, 路径: string, body: unknown) {
  const tk = await 令牌库.认领(raw);
  if (!tk) return { 状态: 401, json: { error: "登录已失效，请重新登录" } };
  const a = tk.accountId;
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const 回 = (r: { ok: boolean; 状态?: number; error?: string }) => ({ 状态: r.ok ? 200 : (r.状态 ?? 500), json: r as unknown as Record<string, unknown> });
  if (u.pathname === "/api/account/name") {
    if (方法 === "GET") return 回(await 账号名.取账号名(a) as never);
    return 回(await 账号名.改账号名(a, b.name) as never);
  }
  if (u.pathname === "/api/sync/pricing") return { 状态: 200, json: { ok: true, ...(await 开通.公开价格()) } as Record<string, unknown> };
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
      if (act === "state") return { 状态: 200, json: await scoped.范围状态(a, t) as unknown as Record<string, unknown> };
      if (act === "directory" || act === "pull" || act === "push" || act === "dedupe-put") await scoped.核设备(a, t, b.device, tk.id);
      let r: unknown;
      if (act === "directory") r = await scoped.范围目录(a, t);
      else if (act === "begin") r = await scoped.开始范围迁移(a, t, String(b.device));
      else if (act === "commit") r = await scoped.完成范围迁移(a, t, String(b.device), Number(b.count));
      else if (act === "push") r = await scoped.收范围推送(a, t, String(b.device), b.packets as never[]);
      else if (act === "dedupe-put") r = await scoped.收查重索引(a, t, String(b.device), b.entries);
      else if (act === "dedupe-find") r = await scoped.查查重(a, t, b.hashes);
      else r = await scoped.给范围拉取(a, t, String(b.scopeId), Number(b.after));
      return { 状态: 200, json: r as Record<string, unknown> };
    } catch (e) {
      if (e instanceof scoped.范围错误) return { 状态: e.状态, json: e.denied ? { error: e.message, denied: e.denied, ...(e.gone?.length ? { gone: e.gone } : {}) } : { error: e.message } };
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
/** 断网开关：断了的设备调什么都是「连不上云端」 */
const 断网 = new Set<string>();
const 过线 = (x: { 状态: number; json: Record<string, unknown> }) => ({ 状态: x.状态, json: JSON.parse(JSON.stringify(x.json)) as Record<string, unknown> });
const 连不上 = { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
const 桌面传: 传输 = async (方法, 路径, body) => (断网.has(临时.谁) ? 连不上 : 过线(await 调中转(令牌[临时.谁], 方法, 路径, body)));
const 用令牌 = (名: string): 手机.传输 => async (方法, 路径, body) => (断网.has(名) ? 连不上 : 过线(await 调中转(令牌[名], 方法, 路径, body)));

/** 桌面端模板库里固定种的三个账号（scripts/build-template.mjs） */
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
async function 登录(w: 谁, 机名 = `${w}-机器`) {
  const 号 = 账号[账号的[w]];
  令牌[w] = (await 令牌库.签发(号, 机名)).token;
  fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: 令牌[w], accountId: 号, name: 账号的[w], contact: `${账号的[w]}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
}
const 轮 = async (w: 谁) => { 当(w); return client.同步一轮(); };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w), w).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };
const 客户们 = async (w: 谁) => (await db(w).customer.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
/** 「没同步上」「待老板核对」两张清单（设置 → 团队里给人看的）。回放跳过的孤儿另算（见 G2） */
async function 清单(w: 谁) {
  当(w);
  return { 没同步上: (await 没同步上(db(w))).条数, 待核对: (await client.范围同步概况()).冲突 };
}
async function 都干净(...ws: 谁[]) { for (const w of ws) expect(await 清单(w), w).toEqual({ 没同步上: 0, 待核对: 0 }); }
async function 跳过的(w: 谁) {
  return (await db(w).$queryRawUnsafe("SELECT tbl, pk, why FROM _sync_skip")) as { tbl: string; pk: string; why: string }[];
}
/** 在本人已连上的电脑上批准一条申请（按申请里的名字挑） */
async function 电脑批(w: 谁, label?: string) {
  当(w);
  const p = await 授权.待授权手机();
  if (!p.ok) throw Error(p.error);
  const x = label ? p.手机.find((m) => m.label === label) : p.手机.length === 1 ? p.手机[0] : undefined;
  if (!x) throw Error(`${w} 上没有待授权的 ${label ?? "（唯一一条）"}：${p.手机.map((m) => m.label).join("、")}`);
  return 授权.允许手机(x.id);
}

/* ---------------- 手机（浏览器版 /m，lib/mobile） ---------------- */
type 一部手机 = { 名: string; 团: 手机.手机团队; 库: 手机.内存库; 态: 手机.同步状态; 云: 手机.传输 };
const 手机们: Record<string, 一部手机> = {};
type 申请中 = { 名: string; device: string; 私钥: 密.设备私钥; 云: 手机.传输 };
/** 手机登录（令牌）→ 发申请。返回申请结果（满了当场就是 409） */
async function 手机申请(名: string, p: 人): Promise<{ ok: true; 申: 申请中 } | { ok: false; error: string }> {
  令牌[名] = (await 令牌库.签发(账号[p], `手机 · ${名}`)).token;
  const 钥 = await 密.设备钥匙对();
  const device = 连.新设备号();
  const 云 = 用令牌(名);
  const r = await 云("POST", "/api/mobile/link", { action: "request", device, pubKey: 钥.公钥, label: `iPhone · ${名}` });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error) };
  return { ok: true, 申: { 名, device, 私钥: 钥.私钥, 云 } };
}
/** 电脑批过之后，手机拿到团队身份、同步一轮 */
async function 手机领身份(申: 申请中) {
  const r = await 连.查申请(申.云, { device: 申.device, 私钥: 申.私钥 });
  if (r.status !== "approved") throw Error(`${申.名} 没批下来：${r.status}`);
  手机们[申.名] = { 名: 申.名, 团: r.团队, 库: new 手机.内存库(), 态: 手机.新状态(), 云: 申.云 };
  return 手机轮(申.名);
}
async function 连手机(名: string, p: 人, 批的电脑: 谁) {
  const a = await 手机申请(名, p);
  if (!a.ok) return a;
  const 批 = await 电脑批(批的电脑, `iPhone · ${名}`);
  if (!批.ok) return 批;
  await 手机领身份(a.申);
  return { ok: true as const };
}
async function 手机轮(名: string) {
  const 机 = 手机们[名];
  try {
    const x = await 手机.同步一轮(机.团, 机.云, 机.库, 机.态);
    机.团 = x.c;
    return { ok: true as const, ...x };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
async function 手机都轮(...名们: string[]) { for (const n of 名们) expect(await 手机轮(n), n).toMatchObject({ ok: true }); }
const 手机表 = (名: string, t: string) => 手机们[名].库.表(t);
const 手机客户 = (名: string) => 手机表(名, "Customer").map((r) => String(r.id)).sort();
const 手机有 = (名: string, t: string, k: string) => 手机表(名, t).find((r) => String(r[t === "CustomerExtra" ? "customerId" : "id"]) === k);
/** 被移出 / 退出后桌面端在后台自动退出：等它退完再切去别的电脑（同 team-full-check） */
async function 等自动退出(w: 谁) {
  for (let i = 0; i < 100 && 读配置(w); i++) await new Promise((x) => setTimeout(x, 20));
  当(w);
  await client.退出团队();
  expect(读配置(w)).toBeNull();
}
/** 客户页改负责人（交接）：客户和没做完的计划一起转 */
async function 交接(w: 谁, id: string, 给: 人) {
  当(w);
  await db(w).$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { salesOwnerId: A(给) } });
    await tx.followPlan.updateMany({ where: { customerId: id, done: false }, data: { ownerId: A(给) } });
  });
}
/** 按界面背后的顺序领取公海（customers/pool-actions.ts：先改负责人、记领取、最后删公海那一行）——同 team-full-check */
async function 领取(w: 谁, 我: 人, id: string) {
  当(w);
  await db(w).$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: { salesOwnerId: A(我) } });
    await tx.customerClaim.upsert({ where: { customerId: id }, update: { userId: A(我), at: new Date() }, create: { customerId: id, userId: A(我) } });
    await tx.customerPool.delete({ where: { customerId: id } });
  });
}
const 歇 = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  开通 = await import("@/lib/tenant/team-plan");
  账号名 = await import("@/lib/tenant/account-name");
  client = await import("@/lib/sync/client");
  const 名字: Record<人, string> = { boss: "王老板", li: "李业务", zhao: "赵业务" };
  for (const p of ["boss", "li", "zhao"] as const) 账号[p] = (await control.account.create({ data: { name: 名字[p], email: `${p}@example.invalid`, password: "not-a-login" } })).id;
  for (const w of 电脑们) { await 登录(w); await 清空种模板(db(w)); }
  client.设传输(桌面传);
}, 120_000);
afterAll(async () => {
  client?.设传输(null);
  for (const w of 电脑们) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

let teamId = "";
let 邀请码 = "";

describe("0. 准备：老板建团队并开通，李、赵加入；李两台电脑 + 一部手机，赵、老板各一部手机", () => {
  it("建团队 → 开通 → 两人加入 → 李的第二台电脑配对 → 三部手机连上", async () => {
    await db("boss").setting.create({ data: { key: "business", value: JSON.stringify({ currency: "CNY", template: "edu" }) } });
    当("boss");
    const r = await client.建团队("QA 贸易");
    if (!r.ok) throw Error(r.error);
    邀请码 = r.邀请码;
    teamId = 读配置("boss").teamId;
    expect((await 开通.开通续费({ teamId, 时长: { months: 12 }, seats: 5, amount: null, by: "测试" })).ok).toBe(true);
    for (const w of ["li", "zhao"] as const) { 当(w); expect(await client.加入团队(邀请码)).toMatchObject({ ok: true }); }
    await 都轮("boss", "li", "zhao", "boss", "li", "zhao");
    当("li2");
    expect((await 新机.发起连接()).ok).toBe(true);
    expect(await 电脑批("li")).toEqual({ ok: true });
    当("li2");
    expect(await 新机.查连接()).toMatchObject({ status: "joined" });
    await 都轮("li2", "li", "li2");
    expect(await 连手机("li-m", "li", "li")).toEqual({ ok: true });
    expect(await 连手机("zhao-m", "zhao", "zhao")).toEqual({ ok: true });
    expect(await 连手机("boss-m", "boss", "boss")).toEqual({ ok: true });
    当("li");
    const 设备 = await 授权.我的设备();
    expect(设备.ok && 设备.设备.map((d) => d.种类)).toEqual(["电脑", "电脑", "手机"]);
  });
});

describe("A / H. 成员新建的东西老板看得到；老板的手机看全队、成员的手机只看本人 + 公海", () => {
  let 手机客户id = "", 手机商机id = "", 手机跟进id = "";
  it("A：李在电脑上建客户 + 商机 + 跟进 + 计划，赵在电脑上建客户 + 商机，李在手机上建客户 + 商机 + 跟进：老板的电脑和手机同步后全都有，内容、负责人都对", async () => {
    const li = db("li");
    await li.customer.create({ data: { id: "c-a-li", name: "李电脑录的客户", phone: "+8613900001001", salesOwnerId: A("li") } });
    await li.opportunity.create({ data: { id: "o-a-li", name: "李的商机", amount: 12000, stage: "需求确认", customerId: "c-a-li", ownerId: A("li") } });
    await li.followUp.create({ data: { id: "f-a-li", customerId: "c-a-li", ownerId: A("li"), type: "PHONE", title: "", content: "李电脑记的跟进" } });
    await li.followPlan.create({ data: { id: "p-a-li", subject: "李的回访计划", plannedAt: new Date("2026-10-25T02:00:00Z"), customerId: "c-a-li", ownerId: A("li") } });
    const zhao = db("zhao");
    await zhao.customer.create({ data: { id: "c-a-zhao", name: "赵电脑录的客户", phone: "+8613900001002", salesOwnerId: A("zhao") } });
    await zhao.opportunity.create({ data: { id: "o-a-zhao", name: "赵的商机", amount: 8000, customerId: "c-a-zhao", ownerId: A("zhao") } });
    await zhao.followUp.create({ data: { id: "f-a-zhao", customerId: "c-a-zhao", ownerId: A("zhao"), type: "VISIT", title: "", content: "赵电脑记的跟进（以前的历史）" } });
    // 老板放一位进公海
    await db("boss").customer.create({ data: { id: "c-a-pool", name: "公海里的", phone: "+8613900001003", salesOwnerId: A("boss") } });
    await db("boss").customerPool.create({ data: { customerId: "c-a-pool", userId: A("boss"), reason: "手动" } });
    await db("boss").customer.create({ data: { id: "c-a-boss", name: "老板私客", phone: "+8613900001004", salesOwnerId: A("boss") } });
    await 都轮("li", "zhao", "boss", "li", "zhao");
    await 手机都轮("li-m");
    const 机 = 手机们["li-m"];
    手机客户id = (await 手机.新建客户(机.团, 机.库, 机.态, { name: "李手机录的客户", phone: "13900001005" })).id;
    手机商机id = (await 手机.新建商机(机.团, 机.库, 机.态, { customerId: 手机客户id, name: "李手机建的商机", amount: 3000, stage: "初步沟通" })).id;
    手机跟进id = (await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-a-li", type: "WECHAT", content: "李手机记的跟进" })).id;
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    await 都轮("li", "li2", "zhao", "boss");
    await 手机都轮("boss-m", "li-m", "zhao-m");

    const b = db("boss");
    expect(await b.customer.findUnique({ where: { id: "c-a-li" } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await b.opportunity.findUnique({ where: { id: "o-a-li" } })).toMatchObject({ name: "李的商机", amount: 12000, stage: "需求确认", ownerId: A("li") });
    expect(await b.opportunity.findUnique({ where: { id: "o-a-zhao" } })).toMatchObject({ name: "赵的商机", ownerId: A("zhao") });
    expect(await b.followUp.findUnique({ where: { id: "f-a-li" } })).toMatchObject({ content: "李电脑记的跟进" });
    expect(await b.followPlan.findUnique({ where: { id: "p-a-li" } })).toMatchObject({ subject: "李的回访计划" });
    expect(await b.customer.findUnique({ where: { id: 手机客户id } })).toMatchObject({ name: "李手机录的客户", salesOwnerId: A("li") });
    expect(await b.opportunity.findUnique({ where: { id: 手机商机id } })).toMatchObject({ name: "李手机建的商机", ownerId: A("li"), customerId: 手机客户id });
    expect(await b.followUp.findUnique({ where: { id: 手机跟进id } })).toMatchObject({ content: "李手机记的跟进", type: "WECHAT", ownerId: A("li") });
    // 老板的手机：一样都有
    expect(手机有("boss-m", "Opportunity", "o-a-li")).toMatchObject({ name: "李的商机" });
    expect(手机有("boss-m", "Opportunity", "o-a-zhao")).toMatchObject({ name: "赵的商机" });
    expect(手机有("boss-m", "Opportunity", 手机商机id)).toMatchObject({ name: "李手机建的商机" });
    expect(手机有("boss-m", "FollowUp", 手机跟进id)).toMatchObject({ content: "李手机记的跟进" });
    expect(手机有("boss-m", "FollowUp", "f-a-zhao")).toMatchObject({ content: "赵电脑记的跟进（以前的历史）" });
    // 李的另一台电脑也收到手机建的
    expect(await db("li2").opportunity.findUnique({ where: { id: 手机商机id } })).toBeTruthy();
    // 同事看不到
    expect(await db("zhao").customer.findUnique({ where: { id: 手机客户id } })).toBeNull();
    expect(await db("zhao").opportunity.findUnique({ where: { id: "o-a-li" } })).toBeNull();
    expect(手机有("zhao-m", "FollowUp", 手机跟进id)).toBeUndefined();
    await 都干净("boss", "li", "li2", "zhao");
  });

  it("H：老板的手机和老板电脑一样看全队；李的手机 = 李本人 + 公海；赵的手机 = 赵本人 + 公海；老板私客只在老板那边", async () => {
    const 全队 = await 客户们("boss");
    expect(全队).toEqual(expect.arrayContaining(["c-a-boss", "c-a-li", "c-a-pool", "c-a-zhao", 手机客户id]));
    expect(手机客户("boss-m")).toEqual(全队);
    expect(手机客户("li-m")).toEqual([...(await 客户们("li"))]);
    expect(手机客户("li-m")).toEqual(["c-a-li", "c-a-pool", 手机客户id].sort());
    expect(手机客户("zhao-m")).toEqual(["c-a-pool", "c-a-zhao"]);
    // 跟进、商机也一样分：李的手机上没有赵的
    expect(手机有("li-m", "Opportunity", "o-a-zhao")).toBeUndefined();
    expect(手机有("li-m", "FollowUp", "f-a-zhao")).toBeUndefined();
  });
});

describe("D. 同时改同一条：结果每台一样，另一边改的格不丢", () => {
  it("电脑 vs 手机，同一条计划：李的手机断网把计划标完成，李的电脑断网改了主题和时间 → 各台（两台电脑、老板、两部手机）一样：完成 + 新主题 + 新时间", async () => {
    断网.add("li-m"); 断网.add("li");
    const 机 = 手机们["li-m"];
    await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-a-li", type: "PHONE", content: "打过电话了，计划完成", 完成计划: "p-a-li" });
    await 歇(5);
    await db("li").followPlan.update({ where: { id: "p-a-li" }, data: { subject: "改到下周回访", plannedAt: new Date("2026-10-28T02:00:00Z") } });
    // 电脑先联网、手机后联网
    断网.delete("li");
    await 都轮("li");
    断网.delete("li-m");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    await 都轮("li", "li2", "boss");
    await 手机都轮("li-m", "boss-m");
    const 看 = (r: Record<string, unknown> | null | undefined) => ({ subject: r?.subject, plannedAt: new Date(r?.plannedAt as never).getTime(), done: !!r?.done, updatedAt: new Date(r?.updatedAt as never).getTime() });
    const 期望 = { subject: "改到下周回访", plannedAt: Date.parse("2026-10-28T02:00:00Z"), done: true };
    const 各台 = [
      ...(await Promise.all((["li", "li2", "boss"] as const).map(async (w) => 看(await db(w).followPlan.findUnique({ where: { id: "p-a-li" } }) as never)))),
      看(手机有("li-m", "FollowPlan", "p-a-li")),
      看(手机有("boss-m", "FollowPlan", "p-a-li")),
    ];
    for (const x of 各台) expect(x).toMatchObject(期望);
    // 修改时间这一格两边都改了：各台取同一个值
    expect(new Set(各台.map((x) => x.updatedAt)).size).toBe(1);
    await 都干净("li", "li2", "boss");
  });

  it("同一格、同一毫秒打平（电脑和手机都把同一条计划标完成，完成时间填的不一样）：各台按同一规则取同一个值，不分叉", async () => {
    await db("li").followPlan.create({ data: { id: "p-d2", subject: "打平用的计划", plannedAt: new Date("2026-10-26T02:00:00Z"), customerId: "c-a-li", ownerId: A("li") } });
    await 都轮("li");
    await 手机都轮("li-m");
    断网.add("li"); 断网.add("li-m");
    当("li");
    await db("li").followPlan.update({ where: { id: "p-d2" }, data: { done: true, doneAt: new Date("2026-10-19T01:00:00Z") } });
    const 电脑钟 = Number((await db("li").$queryRawUnsafe<{ at: bigint }[]>("SELECT MAX(at) AS at FROM _sync_log WHERE tbl = 'FollowPlan' AND pk = 'p-d2'"))[0].at);
    // 手机时钟正好落在同一毫秒（手机本机钟比它慢一点）
    const 机 = 手机们["li-m"];
    机.态.钟 = 电脑钟 - 1;
    await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-a-li", type: "PHONE", content: "同一毫秒完成", 完成计划: "p-d2" }, 电脑钟);
    // 记跟进按顺序编钟：跟进、日志、完成计划、日志——让完成计划那一条正好落在电脑那一刻
    const 完成那条 = 机.态.待推.find((e) => e.t === "FollowPlan" && e.k === "p-d2")!;
    expect(完成那条).toBeTruthy();
    断网.delete("li"); 断网.delete("li-m");
    await 都轮("li");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    await 都轮("li", "li2", "boss");
    await 手机都轮("li-m", "boss-m");
    const 完成时间 = [
      ...(await Promise.all((["li", "li2", "boss"] as const).map(async (w) => (await db(w).followPlan.findUnique({ where: { id: "p-d2" } }))!.doneAt!.getTime()))),
      Number(手机有("li-m", "FollowPlan", "p-d2")?.doneAt),
      Number(手机有("boss-m", "FollowPlan", "p-d2")?.doneAt),
    ];
    expect(new Set(完成时间).size).toBe(1);
  });

  it("三台电脑（老板、李、李的第二台）断网时改同一位客户的同一格，再按随便的顺序联网：都落在最后改的那一笔，另外各自改的格都留着", async () => {
    for (const w of ["boss", "li", "li2"]) 断网.add(w);
    await db("li").customer.update({ where: { id: "c-a-li" }, data: { remark: "李先改的", school: "李填的学校" } });
    await 歇(5);
    await db("boss").customer.update({ where: { id: "c-a-li" }, data: { remark: "老板第二个改的", major: "老板填的专业" } });
    await 歇(5);
    await db("li2").customer.update({ where: { id: "c-a-li" }, data: { remark: "李二号机最后改的", grade: "二号机填的年级" } });
    for (const w of ["li2", "boss", "li"] as const) { 断网.delete(w); await 都轮(w); }
    await 都轮("li2", "boss", "li", "li2");
    await 手机都轮("li-m", "boss-m");
    const 期望 = { remark: "李二号机最后改的", school: "李填的学校", major: "老板填的专业", grade: "二号机填的年级" };
    for (const w of ["boss", "li", "li2"] as const) expect(await db(w).customer.findUnique({ where: { id: "c-a-li" } }), w).toMatchObject(期望);
    for (const n of ["li-m", "boss-m"]) expect(手机有(n, "Customer", "c-a-li"), n).toMatchObject(期望);
  });
});

describe("D5. 一边删、一边改同一条计划", () => {
  it("李的电脑断网删了一条计划，李的手机断网（稍后）把它标完成：每台结果一样（要么都还在、标着完成，要么都没了），不出现有的电脑有、有的没有", async () => {
    await db("li").followPlan.create({ data: { id: "p-d5", subject: "删改打架的计划", plannedAt: new Date("2026-10-27T02:00:00Z"), customerId: "c-a-li", ownerId: A("li") } });
    await 都轮("li", "boss", "li2");
    await 手机都轮("li-m", "boss-m");
    断网.add("li"); 断网.add("li-m");
    当("li");
    await db("li").followPlan.delete({ where: { id: "p-d5" } });
    await 歇(5);
    const 机 = 手机们["li-m"];
    await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-a-li", type: "PHONE", content: "完成那条被删的计划", 完成计划: "p-d5" });
    断网.delete("li");
    await 都轮("li", "boss");
    断网.delete("li-m");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    await 都轮("li", "li2", "boss", "li", "li2", "boss");
    await 手机都轮("li-m", "boss-m");
    const 有没有 = {
      li: !!(await db("li").followPlan.findUnique({ where: { id: "p-d5" } })),
      li2: !!(await db("li2").followPlan.findUnique({ where: { id: "p-d5" } })),
      boss: !!(await db("boss").followPlan.findUnique({ where: { id: "p-d5" } })),
      "li-m": !!手机有("li-m", "FollowPlan", "p-d5"),
      "boss-m": !!手机有("boss-m", "FollowPlan", "p-d5"),
    };
    expect(new Set(Object.values(有没有)).size, JSON.stringify(有没有)).toBe(1);
  });
});

describe("F. 手机断网新建客户，同事这期间录了同一个号码", () => {
  it("两位都留下、各归各的，没有谁的悄悄没了；录的两个人各自看不到对方那份；老板那台「疑似重复」里列出这一对", async () => {
    断网.add("li-m");
    const 机 = 手机们["li-m"];
    const { id } = await 手机.新建客户(机.团, 机.库, 机.态, { name: "撞号客户（李手机录）", phone: "13900005555" });
    const 号 = String(手机有("li-m", "Customer", id)?.phone);
    await db("zhao").customer.create({ data: { id: "c-f-zhao", name: "撞号客户（赵电脑录）", phone: 号, salesOwnerId: A("zhao") } });
    await 都轮("zhao");
    断网.delete("li-m");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    expect(机.态.被拒).toEqual([]);
    await 都轮("li", "boss", "zhao");
    await 手机都轮("li-m", "zhao-m", "boss-m");
    expect(await db("boss").customer.findUnique({ where: { id } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await db("boss").customer.findUnique({ where: { id: "c-f-zhao" } })).toMatchObject({ salesOwnerId: A("zhao") });
    expect(await db("zhao").customer.findUnique({ where: { id } })).toBeNull();
    expect(手机有("zhao-m", "Customer", id)).toBeUndefined();
    expect(await db("li").customer.findUnique({ where: { id: "c-f-zhao" } })).toBeNull();
    当("boss");
    const 组 = (await 疑似重复()).find((g) => g.记录.some((r) => r.id === id));
    expect(组?.记录.map((r) => r.id).sort()).toEqual([id, "c-f-zhao"].sort());
  });
});

describe("F2. 联网时在电脑上 / 手机上录同事已有的号码（2026-10-19 跨成员查重）", () => {
  /*
    原来是 BUG（it.fails 记着）：正式服开着范围同步，业务员电脑上只有本人 + 公海，同事的客户根本不在本机库里——
    checkDuplicate 查不出来，同一个号码照样存成两份，只有老板那台「疑似重复」里看得到。
    10-19 用户拍板做服务端查重（lib/sync/dedupe.ts）：各台报号码哈希，录入前问一下；只露同事名 + 客户名
  */
  it("李在电脑上（联网、刚同步完）录一个赵已有的号码：查重提醒「这号赵业务在跟、客户叫什么」，打不开、看不到别的", async () => {
    // 号码按界面存的样子（规整手机号之后）：大陆手机号不带 +86
    await db("zhao").customer.create({ data: { id: "c-f2-zhao", name: "赵的老客户（查重用）", phone: "13900009100", school: "不该露出来的学校", salesOwnerId: A("zhao") } });
    await 都轮("zhao", "boss", "li");
    当("li");
    忘掉限定();
    (globalThis as { __登录的?: unknown }).__登录的 = { id: A("li"), name: "李业务", email: "li@example.invalid", role: "SALES", title: "" };
    const hit = await checkDuplicate("139 0000 9100");
    expect(await db("li").customer.findUnique({ where: { id: "c-f2-zhao" } })).toBeNull();
    expect(hit, JSON.stringify(hit)).toEqual({ salesOwnerName: "赵业务", id: null, name: "赵的老客户（查重用）", school: null, createdAt: null });
  });

  it("李在电脑上照样点保存：挡下，说清是赵业务的哪位；本机、服务端都没多出一份", async () => {
    当("li");
    忘掉限定();
    (globalThis as { __登录的?: unknown }).__登录的 = { id: A("li"), name: "李业务", email: "li@example.invalid", role: "SALES", title: "" };
    const r = await saveCustomer({ name: "李又录了一遍", phone: "139 0000 9100", salesOwnerId: A("li") } as never);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("同事 赵业务");
    expect(!r.ok && r.error).toContain("赵的老客户（查重用）");
    expect(!r.ok && r.error).not.toContain("不该露出来的学校");
    expect(await db("li").customer.count({ where: { name: "李又录了一遍" } })).toBe(0);
  });

  it("李的手机联网新建同一个号码：同一句话挡下（断网时照样建、老板那台「疑似重复」兜底，见 F）", async () => {
    await 手机都轮("li-m");
    const 机 = 手机们["li-m"];
    await expect(手机.新建客户(机.团, 机.库, 机.态, { name: "李手机又录了一遍", phone: "13900009100" }, Date.now(), 机.云)).rejects.toThrow(/同事 赵业务.*赵的老客户（查重用）/);
    expect(手机表("li-m", "Customer").some((c) => c.name === "李手机又录了一遍")).toBe(false);
  });

  it("服务端那张索引里只有哈希和封好的名字，没有号码、客户名明文", async () => {
    const 行 = await control.syncDedupeKey.findMany({ where: { recordKey: "c-f2-zhao" } });
    expect(行.length).toBeGreaterThan(0);
    for (const x of 行) {
      expect(x.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(x)).not.toContain("13900009100");
      expect(JSON.stringify(x)).not.toContain("赵的老客户");
    }
  });

  it("对照：老板那台查同一个号码查得到（老板库里有全队）", async () => {
    当("boss");
    忘掉限定();
    (globalThis as { __登录的?: unknown }).__登录的 = { id: A("boss"), name: "王老板", email: "boss@example.invalid", role: "ADMIN", title: "" };
    expect(await checkDuplicate("139 0000 9100")).toMatchObject({ salesOwnerName: "赵业务" });
  });
});

describe("D4. 两个业务员断网时同时领了公海里同一位", () => {
  let D4输 = "";
  it("结果每台一样（老板、李、赵看到同一个负责人，公海里没了）；没抢到的那个人领完记的跟进不悄悄丢：要么同步上了，要么进他的「待核对」说清为什么", async () => {
    await db("boss").customer.create({ data: { id: "c-d4-pool", name: "两人都想领的", phone: "+8613900009001", salesOwnerId: A("boss") } });
    await db("boss").customerPool.create({ data: { customerId: "c-d4-pool", userId: A("boss"), reason: "手动" } });
    await 都轮("boss", "li", "zhao");
    断网.add("li"); 断网.add("zhao");
    await 领取("li", "li", "c-d4-pool");
    await db("li").followUp.create({ data: { id: "f-d4-li", customerId: "c-d4-pool", ownerId: A("li"), type: "PHONE", title: "", content: "李领到后打的电话" } });
    await 歇(5);
    await 领取("zhao", "zhao", "c-d4-pool");
    await db("zhao").followUp.create({ data: { id: "f-d4-zhao", customerId: "c-d4-pool", ownerId: A("zhao"), type: "PHONE", title: "", content: "赵领到后打的电话" } });
    断网.delete("li");
    await 都轮("li");
    断网.delete("zhao");
    for (const w of ["zhao", "boss", "li", "zhao", "boss"] as const) await 轮(w);
    const 老板看 = await db("boss").customer.findUnique({ where: { id: "c-d4-pool" } });
    expect(老板看?.salesOwnerId === A("li") || 老板看?.salesOwnerId === A("zhao")).toBe(true);
    expect(await db("boss").customerPool.findUnique({ where: { customerId: "c-d4-pool" } })).toBeNull();
    const 赢 = 老板看!.salesOwnerId === A("li") ? "li" : "zhao";
    const 输 = 赢 === "li" ? "zhao" : "li";
    expect(await db(赢).customer.findUnique({ where: { id: "c-d4-pool" } })).toMatchObject({ salesOwnerId: 老板看!.salesOwnerId });
    expect(await db(输).customer.findUnique({ where: { id: "c-d4-pool" } })).toBeNull();
    // 输的那个人领完记的跟进：老板那边有，或者在他的「待核对」里
    const 输的跟进 = `f-d4-${输}`;
    当(输);
    const 冲突 = await 列出范围冲突(db(输));
    const 在老板 = !!(await db("boss").followUp.findUnique({ where: { id: 输的跟进 } }));
    expect(在老板 || 冲突.some((c) => c.编号 === 输的跟进), JSON.stringify({ 赢, 冲突: 冲突.map((c) => [c.表, c.编号, c.原因]) })).toBe(true);
    // 赢的那个人的跟进照常到了老板那边
    expect(await db("boss").followUp.findUnique({ where: { id: `f-d4-${赢}` } })).toBeTruthy();
    D4输 = 输;
  });

  /*
    10-19 已修（labels.ts 补齐全部同步表）。原来的 BUG（好看）：没抢到的人「待核对」里这一下是 4 条（客户、跟进、CustomerPool、CustomerClaim），后两条表名直接露英文——
    lib/sync/labels.ts 表名 里没有 CustomerPool / CustomerClaim（还有 AuditLog、OpportunityMoney、CustomerExtra 以外的旁表），表的叫法 原样返回表名。
    应该：说成「公海」「领取记录」（或者干脆并进「客户」那一条，用户只做了一件事：领取）
  */
  it("没抢到的人「待核对」里每一条的表名都是中文，不露 CustomerPool / CustomerClaim", async () => {
    当(D4输 as 谁);
    const 冲突 = await 列出范围冲突(db(D4输 as 谁));
    try {
      expect(冲突.length).toBeGreaterThan(0);
      for (const c of 冲突) expect(c.表, JSON.stringify(冲突.map((x) => x.表))).toMatch(/^[^A-Za-z]+$/);
    } finally {
      // 把「待核对」清掉，免得影响后面的清单检查
      const { 确认范围冲突 } = await import("@/lib/sync/scoped-local");
      await 确认范围冲突(db(D4输 as 谁), 冲突.map((x) => x.id));
    }
  });
});

describe("G. 手机断网记跟进，这期间那位客户进了公海 / 被删了", () => {
  it("进了公海：联网后这笔不丢——同步上了（老板、领到公海的人都看得到），或者进「被拒」并说清是进了公海、内容可复制", async () => {
    await db("li").customer.create({ data: { id: "c-g-pool", name: "要被放进公海的", phone: "+8613900007001", salesOwnerId: A("li") } });
    await 都轮("li", "boss");
    await 手机都轮("li-m");
    断网.add("li-m");
    const 机 = 手机们["li-m"];
    const { id } = await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-g-pool", type: "PHONE", content: "断网时记的：客户说先放一放" });
    await 歇(5);
    当("li");
    await db("li").customerPool.create({ data: { customerId: "c-g-pool", userId: A("li"), reason: "手动" } });
    await 都轮("li", "boss");
    断网.delete("li-m");
    const r = await 手机轮("li-m");
    expect(r.ok).toBe(true);
    await 都轮("boss", "zhao");
    const 老板有 = await db("boss").followUp.findUnique({ where: { id } });
    const 拒的 = 机.态.被拒.find((x) => x.改动.k === id);
    // 二选一，但不能两样都不是（悄悄丢了）
    if (老板有) {
      expect(老板有).toMatchObject({ content: "断网时记的：客户说先放一放", customerId: "c-g-pool" });
      expect(拒的).toBeUndefined();
    } else {
      expect(拒的?.原因).toMatch(/公海/);
      expect(String(拒的?.改动.r?.content)).toBe("断网时记的：客户说先放一放");
    }
  });

  /*
    10-19 已修（scope-policy 挂在已删的上 → 拒，回包 gone → 手机说清「被删了」）。原来的 BUG（丢数据）：老板删了客户，手机断网时给这位记的跟进联网后服务端照收（拒 0、待推清空、手机上显示已同步），
    但这位客户在各台电脑上都已经删了：老板那台回放时这条跟进是孤儿，记进 _sync_skip 跳过；
    「没同步上」清单又特意不算孤儿（lib/sync/local.ts 没同步上：why NOT LIKE '孤儿：%'），所以谁都看不到、谁也不知道。
    手机上那位客户跟着删除被清掉，这条跟进在手机界面上也找不到入口——用户写的内容实际上丢了。
    服务端判权限时 scope-policy.ts 算范围 对 Customer 不看 deleted：已删的客户照样算「归李」，挂在它下面的新记录照收。
    应该：拒掉（denied），手机把它挪进「被拒」，原因说清「这位客户已经被删了」，内容可复制。
  */
  it("被删了：联网后这笔进「被拒」、说清客户已被删、内容还在；不能显示已同步、实际哪台电脑都看不到", async () => {
    await db("li").customer.create({ data: { id: "c-g-del", name: "要被删掉的", phone: "+8613900007002", salesOwnerId: A("li") } });
    await 都轮("li", "boss");
    await 手机都轮("li-m");
    断网.add("li-m");
    const 机 = 手机们["li-m"];
    const { id } = await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-g-del", type: "PHONE", content: "断网时记的：报价单已发" });
    await 歇(5);
    当("boss");
    await db("boss").customer.delete({ where: { id: "c-g-del" } });
    await 都轮("boss", "li");
    断网.delete("li-m");
    const r = await 手机轮("li-m");
    await 都轮("boss", "li");
    const 拒的 = 机.态.被拒.find((x) => x.改动.k === id);
    // 先把实际情况记下来，便于看报告：拒了几条、老板那台有没有、跳过清单里有没有
    const 实际 = { 拒: r.ok ? r.拒 : r.error, 老板有: !!(await db("boss").followUp.findUnique({ where: { id } })), 老板跳过: (await 跳过的("boss")).filter((x) => x.pk === id).map((x) => x.why), 老板没同步上: (await 清单("boss")).没同步上 };
    expect(实际, JSON.stringify(实际)).toMatchObject({ 拒: 1 });
    expect(拒的?.原因).toMatch(/删/);
    expect(String(拒的?.改动.r?.content)).toBe("断网时记的：报价单已发");
  });
});

describe("G3. 手机断网新建商机，这期间客户被老板转给了赵", () => {
  it("商机、币种、操作日志一起进「被拒」（界面列得出这个商机、内容可复制），老板和赵那边没有半截（没有孤零零的币种、日志）", async () => {
    await db("li").customer.create({ data: { id: "c-g3", name: "要被转走的", phone: "+8613900007003", salesOwnerId: A("li") } });
    await 都轮("li", "boss");
    await 手机都轮("li-m");
    断网.add("li-m");
    const 机 = 手机们["li-m"];
    const { id } = await 手机.新建商机(机.团, 机.库, 机.态, { customerId: "c-g3", name: "断网时建的商机", amount: 999, stage: "初步沟通" });
    await 歇(5);
    await 交接("boss", "c-g3", "zhao");
    await 都轮("boss", "li", "zhao");
    断网.delete("li-m");
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 2 });
    const 拒的 = 机.态.被拒.filter((x) => x.改动.k === id || x.改动.r?.entityId === id);
    expect(拒的.map((x) => x.改动.t).sort()).toEqual(["AuditLog", "Opportunity", "OpportunityMoney"]);
    expect(拒的.find((x) => x.改动.t === "Opportunity")?.改动.r).toMatchObject({ name: "断网时建的商机", amount: 999 });
    expect(拒的.every((x) => /不归你/.test(x.原因))).toBe(true);
    await 都轮("boss", "zhao");
    for (const w of ["boss", "zhao"] as const) {
      expect(await db(w).opportunity.findUnique({ where: { id } }), w).toBeNull();
      expect(await db(w).auditLog.count({ where: { entityId: id } }), w).toBe(0);
    }
    expect(手机有("li-m", "Opportunity", id)).toBeUndefined();
  });
});

describe("E. 设备上限（每人 3 台，电脑和手机合计）", () => {
  it("李已有 3 台（两台电脑 + 一部手机）：第 4 台是手机，申请当场就说满了、去哪儿腾", async () => {
    const r = await 手机申请("li-m-满", "li");
    expect(r).toEqual({ ok: false, error: "一个人在团队里最多 3 台设备（电脑和手机合计）：先在电脑上「设置 → 团队 → 我的设备」里移除一台不用的" });
  });

  it("移除 li2 腾出一台；两部新手机同时申请、先批一部：再批第二部时说清楚满了（不是没反应），申请还在；再移除一台就批得下来，连上能同步", async () => {
    当("li");
    const 设备们 = await 授权.我的设备();
    const li2 = 设备们.ok ? 设备们.设备.find((d) => d.label === "li2-机器") : undefined;
    expect(await 授权.移除设备(li2!.device)).toEqual({ ok: true });
    const a = await 手机申请("li-m2", "li");
    const b = await 手机申请("li-m3", "li");
    if (!a.ok || !b.ok) throw Error(`申请没发出去：${!a.ok ? a.error : ""}${!b.ok ? b.error : ""}`);
    expect(await 电脑批("li", "iPhone · li-m2")).toEqual({ ok: true });
    await 手机领身份(a.申);
    const 第二部 = await 电脑批("li", "iPhone · li-m3");
    expect(第二部).toEqual({ ok: false, error: "一个人在团队里最多 3 台设备（电脑和手机合计）：先在电脑上「设置 → 团队 → 我的设备」里移除一台不用的" });
    expect((await 连.查申请(b.申.云, { device: b.申.device, 私钥: b.申.私钥 })).status).toBe("pending");
    // 移除刚连上的 li-m2：它下一轮登录失效（手机据此清数据），li-m3 批得下来
    当("li");
    const 又 = await 授权.我的设备();
    const m2 = 又.ok ? 又.设备.find((d) => d.label === "iPhone · li-m2") : undefined;
    expect(await 授权.移除设备(m2!.device)).toEqual({ ok: true });
    const x = await 手机轮("li-m2");
    expect(!x.ok && 要清掉(x.error)).toBeTruthy();
    expect(await 电脑批("li", "iPhone · li-m3")).toEqual({ ok: true });
    当("boss");
    expect(await client.老板补换钥匙(true)).toMatchObject({ ok: true });
    await 都轮("boss", "li", "zhao");
    expect(await 手机领身份(b.申)).toMatchObject({ ok: true });
    expect(手机客户("li-m3")).toEqual(await 客户们("li"));
    await 手机都轮("li-m", "boss-m", "zhao-m");
  });
});

describe("C. 到期暂停 → 续费恢复：暂停期间各台照常记，续费后一条不丢", () => {
  let 期间客户 = "", 期间商机 = "";
  it("到期：电脑、手机都说清楚是到期；手机不清数据（不是被移出）；暂停期间手机新建客户 + 商机，李在电脑上把客户交给赵，老板改了这位的备注", async () => {
    expect((await 开通.改到期({ teamId, paidUntil: 开通.当天结束(new Date(Date.now() - 86_400_000)), by: "测试" })).ok).toBe(true);
    const x = await 手机轮("li-m");
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toMatch(/已到期/);
    expect(要清掉(!x.ok ? x.error : "")).toBeNull();
    expect(手机客户("li-m").length).toBeGreaterThan(0);
    const 机 = 手机们["li-m"];
    期间客户 = (await 手机.新建客户(机.团, 机.库, 机.态, { name: "到期期间手机录的", phone: "13900008001" })).id;
    期间商机 = (await 手机.新建商机(机.团, 机.库, 机.态, { customerId: 期间客户, name: "到期期间手机建的商机", amount: 500, stage: "初步沟通" })).id;
    await db("li").followPlan.create({ data: { id: "p-c-li", subject: "交接前排的计划", plannedAt: new Date("2026-10-30T02:00:00Z"), customerId: "c-a-li", ownerId: A("li") } });
    await 交接("li", "c-a-li", "zhao");
    const r = await 轮("li");
    expect(!r.ok && r.error).toMatch(/已到期/);
    await 歇(5);
    await db("boss").customer.update({ where: { id: "c-a-li" }, data: { remark: "老板暂停期间改的备注" } });
    expect((await 轮("boss")).ok).toBe(false);
  });

  it("续费：自动恢复；手机建的客户 + 商机老板看得到；交接的客户连同跟进、计划到了赵的电脑和手机，带着老板改的备注；李那边清掉；清单都是空的", async () => {
    expect((await 开通.开通续费({ teamId, 时长: { months: 1 }, seats: 5, amount: null, by: "测试" })).ok).toBe(true);
    expect(await 手机轮("li-m")).toMatchObject({ ok: true, 拒: 0 });
    await 都轮("li", "boss", "zhao", "li", "boss", "zhao");
    await 手机都轮("li-m", "zhao-m", "boss-m");
    expect(await db("boss").customer.findUnique({ where: { id: 期间客户 } })).toMatchObject({ name: "到期期间手机录的", salesOwnerId: A("li") });
    expect(await db("boss").opportunity.findUnique({ where: { id: 期间商机 } })).toMatchObject({ name: "到期期间手机建的商机" });
    for (const w of ["zhao", "boss"] as const) {
      expect(await db(w).customer.findUnique({ where: { id: "c-a-li" } }), w).toMatchObject({ salesOwnerId: A("zhao"), remark: "老板暂停期间改的备注" });
      expect(await db(w).followUp.findUnique({ where: { id: "f-a-li" } }), w).toBeTruthy();
      expect(await db(w).followPlan.findUnique({ where: { id: "p-c-li" } }), w).toMatchObject({ ownerId: A("zhao") });
    }
    expect(手机有("zhao-m", "Customer", "c-a-li")).toMatchObject({ salesOwnerId: A("zhao") });
    expect(手机有("zhao-m", "FollowUp", "f-a-li")).toBeTruthy();
    expect(await db("li").customer.findUnique({ where: { id: "c-a-li" } })).toBeNull();
    expect(手机有("li-m", "Customer", "c-a-li")).toBeUndefined();
    await 都干净("li", "boss", "zhao");
  });
});

describe("B. 移除成员 / 退出团队之后，数据归谁", () => {
  let 赵手机离线记的 = "";
  it("老板移除赵（赵的手机这时断着网、记了一笔）：赵名下的客户在老板那边一条不少、负责人还是赵；李看不到；老板把赵的一位客户交给李，李的电脑和手机收到这位连同以前的跟进", async () => {
    断网.add("zhao-m");
    const 机 = 手机们["zhao-m"];
    赵手机离线记的 = (await 手机.记跟进(机.团, 机.库, 机.态, { customerId: "c-a-zhao", type: "PHONE", content: "赵被移除前手机断网记的" })).id;
    const 赵的 = (await db("boss").customer.findMany({ where: { salesOwnerId: A("zhao") }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
    expect(赵的).toEqual(expect.arrayContaining(["c-a-li", "c-a-zhao", "c-f-zhao"]));
    当("boss");
    expect(await client.移除成员(账号.zhao)).toMatchObject({ ok: true });
    await 都轮("boss", "li");
    expect((await db("boss").customer.findMany({ where: { salesOwnerId: A("zhao") }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id)).toEqual(赵的);
    expect(await db("li").customer.findUnique({ where: { id: "c-a-zhao" } })).toBeNull();
    await 交接("boss", "c-a-zhao", "li");
    await 都轮("boss", "li", "boss", "li");
    await 手机都轮("li-m", "boss-m");
    expect(await db("li").customer.findUnique({ where: { id: "c-a-zhao" } })).toMatchObject({ salesOwnerId: A("li") });
    expect(await db("li").followUp.findUnique({ where: { id: "f-a-zhao" } })).toMatchObject({ content: "赵电脑记的跟进（以前的历史）" });
    expect(await db("li").opportunity.findUnique({ where: { id: "o-a-zhao" } })).toMatchObject({ name: "赵的商机" });
    expect(手机有("li-m", "Customer", "c-a-zhao")).toMatchObject({ salesOwnerId: A("li") });
    expect(手机有("li-m", "FollowUp", "f-a-zhao")).toBeTruthy();
    await 都干净("boss", "li");
  });

  it("赵的手机联网：说清楚不在团队里（手机据此清数据）；断网时记的那笔还在待推里，界面清数据时能单独留给他复制", async () => {
    断网.delete("zhao-m");
    const x = await 手机轮("zhao-m");
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toMatch(/不在这个团队/);
    expect(要清掉(!x.ok ? x.error : "")).toMatch(/不在这个团队/);
    expect(手机们["zhao-m"].态.待推.some((e) => e.k === 赵手机离线记的)).toBe(true);
  });

  it("赵的电脑自动退出、只留他名下的；之后老板换了邀请码让他重新加入：他电脑上那份旧的「赵电脑录的客户」不会把已经交给李的抢回去", async () => {
    const r = await 轮("zhao");
    expect(!r.ok && r.error).toMatch(/不在这个团队/);
    await 等自动退出("zhao");
    // 他本机那份还写着归他（他收不到老板后来的交接）
    expect(await db("zhao").customer.findUnique({ where: { id: "c-a-zhao" } })).toMatchObject({ salesOwnerId: A("zhao") });
    当("boss");
    const 新码 = await client.换邀请码();
    if (!新码.ok) throw Error(新码.error);
    当("zhao");
    expect(await client.加入团队(新码.邀请码)).toMatchObject({ ok: true });
    for (const w of ["zhao", "boss", "li", "zhao", "boss", "li"] as const) await 轮(w);
    for (const w of ["boss", "li"] as const) expect(await db(w).customer.findUnique({ where: { id: "c-a-zhao" } }), w).toMatchObject({ salesOwnerId: A("li") });
    // 赵那边：这位不该还挂在他名下（要么清掉，要么进「待核对」说清已不归他）
    const 赵那份 = await db("zhao").customer.findUnique({ where: { id: "c-a-zhao" } });
    当("zhao");
    const 冲突 = await 列出范围冲突(db("zhao"));
    expect(赵那份 === null || 冲突.some((c) => c.编号 === "c-a-zhao")).toBe(true);
    // 赵仍然负责的那几位照旧归他、老板那边都在
    expect(await db("boss").customer.findUnique({ where: { id: "c-a-li" } })).toMatchObject({ salesOwnerId: A("zhao") });
    expect(await db("zhao").customer.findUnique({ where: { id: "c-a-li" } })).toMatchObject({ salesOwnerId: A("zhao") });
  });

  it("李自己在电脑上退出团队：他的手机下一轮说清楚不在团队里（手机据此清数据）；老板那边李的客户一条不少、负责人还是李", async () => {
    const 李的 = (await db("boss").customer.findMany({ where: { salesOwnerId: A("li") }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
    expect(李的.length).toBeGreaterThan(0);
    当("li");
    expect(await client.退出团队()).toEqual({ ok: true });
    for (const n of ["li-m", "li-m3"]) {
      const x = await 手机轮(n);
      expect(x.ok, n).toBe(false);
      expect(要清掉(!x.ok ? x.error : ""), n).toMatch(/不在这个团队/);
    }
    await 都轮("boss");
    expect((await db("boss").customer.findMany({ where: { salesOwnerId: A("li") }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id)).toEqual(李的);
  });
});
