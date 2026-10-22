/**
 * 团队版产品图片（2026-10-22 D-24）：行走范围同步，文件走密文通道（lib/sync/attach-client.ts ↔ lib/tenant/sync-attach.ts）。
 * 两台都走真实 lib/sync/client.ts，云端是真实的 sync-relay + sync-scoped + sync-attach（临时控制库、临时目录）。
 * 钉的是：传上去、对方打开时取回来字节一样、云端只有密文；看不到的商机的图拿不到；没传齐说「还在上传」、断了接着传；
 * 删了云端一起删并记清单；团队空间满了不收、桌面端记一句；云端丢了隔几个小时核一次重传；限速一个桶；磁盘线。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type 谁 = "boss" | "li";
const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sync-attach-"));
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
import type { 传输 } from "@/lib/sync/client";
import type { 附件传输 } from "@/lib/sync/attach-client";
import { 封附件 } from "@/lib/sync/crypto";

let client: typeof import("@/lib/sync/client");
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let attach: typeof import("@/lib/tenant/sync-attach");
let 附件: typeof import("@/lib/attachments");
let 图通道: typeof import("@/lib/sync/attach-client");
let control: typeof import("@/lib/tenant/control").control;
const 账号: Record<谁, string> = { boss: "", li: "" };
const db = (w: 谁) => (globalThis as unknown as { __dbs: Record<string, PrismaClient> }).__dbs[w];
function 当(w: 谁) { 临时.谁 = w; process.env.CRM_DATA_DIR = path.join(临时.root, w); }
const A = (w: 谁) => `acct_${账号[w]}`;

/** 和云端说话：桌面端按「当前是谁」 */
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
      else if (act === "pull-many") r = await scoped.给多个范围拉取(a, t, b.scopes);
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

async function 清空(d: PrismaClient) {
  for (const t of ["AiMessage", "AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerClaim", "CustomerPool"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await d.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await d.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}
// 产品图片在同步一轮之后后台传（质量审 #93 D）：测试里等它传完再往下看
const 轮 = async (w: 谁) => { 当(w); const r = await client.同步一轮(); await client.等图片(); return r; };
const 都轮 = async (...ws: 谁[]) => { for (const w of ws) expect(await 轮(w)).toMatchObject({ ok: true }); };
const 读配置 = (w: 谁) => { 当(w); return client.读团队()!; };


/** 附件通道：桌面端按「当前是谁」直接调云端那几个函数（和真接口一样的回话） */
let 附件断: ((offset: number) => boolean) | null = null;
const 次数 = { put: 0, putFrom: [] as number[] };
const 附件传: 附件传输 = async (方法, 路径, body) => {
  const a = 账号[临时.谁];
  const u = new URL(`http://x${路径}`);
  const q = (k: string) => u.searchParams.get(k) ?? "";
  try {
    if (方法 === "PUT") {
      次数.put++;
      次数.putFrom.push(Number(q("offset")));
      if (附件断?.(Number(q("offset")))) return { 状态: 0, json: { error: "连不上云端" } };
      const r = await attach.收附件块(a, q("teamId"), { id: q("id"), offset: Number(q("offset")), total: Number(q("total")), head: q("head") }, body as Uint8Array);
      return { 状态: 200, json: r as unknown as Record<string, unknown> };
    }
    if (方法 === "GET") {
      const { 流 } = await attach.给附件(a, q("teamId"), q("id"));
      return { 状态: 200, json: {}, 字节: Buffer.from(await new Response(流).arrayBuffer()) };
    }
    const b = body as Record<string, unknown>;
    return { 状态: 200, json: (await attach.有哪些附件(a, String(b.teamId), b.ids)) as unknown as Record<string, unknown> };
  } catch (e) {
    if (e instanceof scoped.范围错误) return { 状态: e.状态, json: { error: e.message, ...(e instanceof attach.附件错误 ? e.补充 : {}) } };
    throw e;
  }
};

const 图 = (n: number, 种 = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 种 * 7) & 0xff; b.write("PLAINTEXT-MARK", 100); return new Uint8Array(b); };
const 云端文件 = (id: string) => path.join(临时.root, "sync", "attach", 读配置("boss").teamId, id);
const 存 = async (w: 谁, opp: string, 字节: Uint8Array) => { 当(w); return 附件.存附件(db(w), { 挂在: { opportunityId: opp }, name: "产品.png", mime: "image/png", 字节, userId: A(w) }); };
const 打开 = async (w: 谁, id: string) => { 当(w); return 附件.确保文件(id); };
const 本机字节 = (w: 谁, id: string) => { 当(w); return fs.readFileSync(附件.附件文件(id)); };

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
  attach = await import("@/lib/tenant/sync-attach");
  附件 = await import("@/lib/attachments");
  图通道 = await import("@/lib/sync/attach-client");
  client = await import("@/lib/sync/client");
  for (const w of ["boss", "li"] as const) {
    账号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
    fs.writeFileSync(path.join(临时.root, w, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号[w], name: w, contact: `${w}@example.invalid`, models: [], loggedAt: new Date().toISOString() }));
    await 清空(db(w));
  }
  client.设传输(桌面传);
  图通道.设附件传输(附件传);
  图通道.设重试基数(1);
  当("boss");
  const 码 = await client.建团队("图片QA");
  if (!码.ok) throw Error(码.error);
  await relay.设开通(读配置("boss").teamId, true);
  await db("boss").customer.create({ data: { id: "c-boss", name: "老板的客户", phone: "13900004444", salesOwnerId: A("boss") } });
  await db("boss").opportunity.create({ data: { id: "o-boss", name: "老板的商机", customerId: "c-boss", ownerId: A("boss") } });
  await 都轮("boss");
  当("li");
  expect(await client.加入团队(码.邀请码)).toMatchObject({ ok: true });
  await db("li").customer.create({ data: { id: "c-li", name: "业务员的客户", phone: "13900003333", salesOwnerId: A("li") } });
  await db("li").opportunity.create({ data: { id: "o-li", name: "业务员的商机", customerId: "c-li", ownerId: A("li") } });
  await 都轮("li", "boss", "li");
}, 180_000);
afterAll(async () => {
  client?.设传输(null);
  图通道?.设附件传输(null);
  for (const w of ["boss", "li"] as const) await db(w).$disconnect();
  await control?.$disconnect();
  for (const n of ["MULTI_TENANT", "DESKTOP_LOCAL", "SYNC_DIR", "CONTROL_DATABASE_URL", "CRM_DATA_DIR", "CRM_SCOPED_SYNC", "ATTACH_SEAT_GB", "ATTACH_MBPS"]) delete process.env[n];
  fs.rmSync(临时.root, { recursive: true, force: true });
});

describe("团队版产品图片", () => {
  let 第一张 = "";
  it("业务员传图：同步一轮就加密传上去；老板打开时取回来，字节一样；云端只有密文", async () => {
    const 字节 = 图(300_000);
    const a = await 存("li", "o-li", 字节);
    第一张 = a.id;
    await 都轮("li");
    const 密 = fs.readFileSync(云端文件(a.id));
    expect(密[0]).toBe(5);
    expect(密.includes(Buffer.from("PLAINTEXT-MARK"))).toBe(false);
    await 都轮("boss");
    当("boss");
    expect(附件.有文件(a.id)).toBe(false);
    expect(await 打开("boss", a.id)).toBe("有");
    expect(本机字节("boss", a.id).equals(Buffer.from(字节))).toBe(true);
    // 老板这台是取来的，不会再传一遍
    const 前 = 次数.put;
    await 都轮("boss");
    expect(次数.put).toBe(前);
  });

  it("看不到的商机上的图：业务员连行都拉不到，直接找云端要也不给", async () => {
    const a = await 存("boss", "o-boss", 图(5000, 2));
    await 都轮("boss", "li");
    expect(await db("li").attachment.findUnique({ where: { id: a.id } })).toBeNull();
    await expect(attach.给附件(账号.li, 读配置("li").teamId, a.id)).rejects.toMatchObject({ 状态: 403 });
    await expect(attach.收附件块(账号.li, 读配置("li").teamId, { id: a.id, offset: 0, total: 100, head: Buffer.alloc(33).toString("base64url") }, new Uint8Array(100))).rejects.toMatchObject({ 状态: 403 });
  });

  it("互看开着：业务员看得到老板商机上的图、能取，但不能替老板传（抢先传一份坏的）", async () => {
    const teamId = 读配置("boss").teamId;
    const a = await 存("boss", "o-boss", 图(7000, 7));
    await 都轮("boss");
    expect(await relay.设互看(账号.boss, teamId, true)).toMatchObject({ ok: true });
    try {
      await 都轮("li");
      expect(await db("li").attachment.findUnique({ where: { id: a.id } })).not.toBeNull();
      expect(await 打开("li", a.id)).toBe("有");
      await expect(attach.收附件块(账号.li, teamId, { id: a.id, offset: 0, total: 100, head: Buffer.alloc(33).toString("base64url") }, new Uint8Array(100))).rejects.toMatchObject({ 状态: 403 });
    } finally {
      await relay.设互看(账号.boss, teamId, false);
      await 都轮("li");
    }
  });

  it("没传齐：对方打开说「还在上传」；断了下一轮从云端已收的位置接着传，不从头", async () => {
    const 字节 = 图(2_500_000, 3);
    const a = await 存("li", "o-li", 字节);
    附件断 = (offset) => offset > 0;
    await 都轮("li");
    expect(fs.existsSync(`${云端文件(a.id)}.part`)).toBe(true);
    await 都轮("boss");
    expect(await 打开("boss", a.id)).toBe("还在上传");
    附件断 = null;
    次数.putFrom = [];
    await 都轮("li");
    expect(次数.putFrom[0]).toBe(图通道.块大小);
    expect(await 打开("boss", a.id)).toBe("有");
    expect(本机字节("boss", a.id).equals(Buffer.from(字节))).toBe(true);
  });

  it("云端续传规矩：offset 接不上回 409 和已收多少；头不一样（中途换了钥匙）扔掉已收的从 0 来；传齐了不再收", async () => {
    const a = await 存("li", "o-li", 图(1_500_000, 6));
    附件断 = (offset) => offset > 0;
    await 都轮("li");
    附件断 = null;
    const teamId = 读配置("li").teamId, 半 = `${云端文件(a.id)}.part`;
    const 头 = fs.readFileSync(半).subarray(0, 33);
    const total = 1_500_000 + 33;
    const 收 = (offset: number, head: Buffer, n: number) => attach.收附件块(账号.li, teamId, { id: a.id, offset, total, head: head.toString("base64url") }, new Uint8Array(Buffer.concat([head, Buffer.alloc(n - 33)])));
    await expect(收(0, 头, 1000)).rejects.toMatchObject({ 状态: 409, 补充: { have: 图通道.块大小 } });
    const 新头 = Buffer.from(头); 新头[1] ^= 1;
    await expect(收(0, 新头, 1000)).resolves.toMatchObject({ have: 1000, done: false });
    // 桌面端下一轮从它记的位置传、云端回 409，再从 1000 接上，传齐
    await 都轮("li");
    expect(fs.existsSync(云端文件(a.id))).toBe(true);
    await expect(收(0, 头, 1000)).resolves.toMatchObject({ done: true });
    await 都轮("boss");
    expect(await 打开("boss", a.id)).toBe("有");
  });

  /** 质量审 #93：自己封一份密文，直接对云端一块一块地收 */
  const 自己封 = async (seed: number) => {
    const a = await 存("li", "o-li", 图(1_500_000, seed));
    附件断 = () => true; // 行先推上去，文件一块都不传
    await 都轮("li");
    附件断 = null;
    const c = 读配置("li");
    const { sha256 } = await db("li").attachment.findUniqueOrThrow({ where: { id: a.id } });
    const 密 = 封附件(本机字节("li", a.id), c.key, c.epoch ?? 0, { teamId: c.teamId, id: a.id, sha256 });
    const head = 密.subarray(0, 33).toString("base64url"), 块 = 图通道.块大小;
    const 收 = (o: number) => attach.收附件块(账号.li, c.teamId, { id: a.id, offset: o, total: 密.length, head }, new Uint8Array(密.subarray(o, Math.min(密.length, o + 块))));
    return { a, 密, 收, 块, teamId: c.teamId };
  };

  it("同一块同时到两次（断线重传、旧请求还在限速里排着）：只收一份，传齐的文件不坏（质量审 #93 A）", async () => {
    const { a, 密, 收, 块 } = await 自己封(11);
    const 第一块 = await Promise.allSettled([收(0), 收(0)]);
    expect(第一块.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(第一块.find((x) => x.status === "rejected")).toMatchObject({ reason: { 状态: 409, 补充: { have: 块 } } });
    // 第二块：先到的那个传齐了；后到的那个看见已经传齐（只写一次），回 done，不再写
    await expect(Promise.all([收(块), 收(块)])).resolves.toMatchObject([{ done: true }, { done: true }]);
    expect(fs.readFileSync(云端文件(a.id)).equals(密)).toBe(true);
    expect(fs.existsSync(`${云端文件(a.id)}.part`)).toBe(false);
    await 都轮("boss");
    expect(await 打开("boss", a.id)).toBe("有");
  });

  it("已收的比整张还长（坏了）：删掉从 0 来，不在坏的后面接着写（质量审 #93 B）", async () => {
    const { a, 密, 收, 块 } = await 自己封(12);
    fs.mkdirSync(path.dirname(云端文件(a.id)), { recursive: true });
    fs.writeFileSync(`${云端文件(a.id)}.part`, Buffer.concat([密, Buffer.alloc(10)]));
    await expect(收(0)).resolves.toMatchObject({ have: 块, done: false });
    await expect(收(块)).resolves.toMatchObject({ done: true });
    expect(fs.readFileSync(云端文件(a.id)).equals(密)).toBe(true);
  });

  it("在限速里排着的时候这张图被删了：排完不再写，不留 .part", async () => {
    const { a, 收, teamId } = await 自己封(13);
    process.env.ATTACH_MBPS = "1";
    attach.重置限速();
    attach.排队(2 * 1024 * 1024); // 前面排着 2 MB：这一块要等一两秒
    try {
      const 在收 = 收(0);
      await new Promise((r) => setTimeout(r, 200));
      attach.删云端附件(teamId, [a.id]);
      await expect(在收).rejects.toMatchObject({ 状态: 404 });
      expect(fs.existsSync(`${云端文件(a.id)}.part`)).toBe(false);
    } finally {
      delete process.env.ATTACH_MBPS;
      attach.重置限速();
    }
  });

  it("删图：云端那份一起删，编号记进当天的删除清单", async () => {
    当("li");
    await 附件.删附件(db("li"), 第一张);
    await 都轮("li");
    expect(fs.existsSync(云端文件(第一张))).toBe(false);
    const 清单 = path.join(path.dirname(云端文件(第一张)), ".deleted");
    const 今天 = fs.readdirSync(清单);
    expect(今天).toHaveLength(1);
    expect(fs.readFileSync(path.join(清单, 今天[0]), "utf8")).toContain(第一张);
    await 都轮("boss");
    expect(await db("boss").attachment.findUnique({ where: { id: 第一张 } })).toBeNull();
  });

  it("团队空间满了：云端不收，桌面端记一句；空间够了下一轮补传", async () => {
    process.env.ATTACH_SEAT_GB = "0.000001";
    const a = await 存("li", "o-li", 图(4000, 4));
    await 都轮("li");
    expect(fs.existsSync(云端文件(a.id))).toBe(false);
    expect(读配置("li").lastError).toContain("团队的图片空间满了");
    delete process.env.ATTACH_SEAT_GB;
    await 都轮("li");
    expect(fs.existsSync(云端文件(a.id))).toBe(true);
    expect(读配置("li").lastError ?? null).toBeNull();
  });

  it("云端丢了（换盘、从备份恢复）：隔几个小时核一次，没了的下一轮重传", async () => {
    const a = await 存("li", "o-li", 图(6000, 5));
    await 都轮("li");
    fs.rmSync(云端文件(a.id));
    (globalThis as { 附件核对?: Record<string, number> }).附件核对 = {};
    await 都轮("li", "li");
    expect(fs.existsSync(云端文件(a.id))).toBe(true);
  });

  it("限速：上传、下载排同一条队，默认 15 MB/s，允许 1 秒突发；ATTACH_MBPS 可调", () => {
    const MB = 1024 * 1024;
    expect(attach.每秒字节({})).toBe(15 * MB);
    expect(attach.每秒字节({ ATTACH_MBPS: "30" })).toBe(30 * MB);
    attach.重置限速();
    expect(attach.排队(15 * MB, 1_000_000, 15 * MB)).toBe(0);
    expect(attach.排队(15 * MB, 1_000_000, 15 * MB)).toBe(1000);
    expect(attach.排队(7.5 * MB, 1_000_000, 15 * MB)).toBe(1500);
    attach.重置限速();
  });

  it("同事的、本机没下载的图攒过 500 张：也记上号，本机自己的新图照样传得上去（质量审 #93 C）", async () => {
    当("li");
    const 很早 = new Date("2026-01-01T00:00:00Z");
    await db("li").attachment.createMany({ data: Array.from({ length: 520 }, (_, i) => ({ id: `nofile${String(i).padStart(4, "0")}`, opportunityId: "o-li", name: "同事的.png", mime: "image/png", size: 10, sha256: "0".repeat(64), createdAt: 很早 })) });
    const a = await 存("li", "o-li", 图(3000, 9));
    await 都轮("li");
    expect(fs.existsSync(云端文件(a.id))).toBe(true);
    const 记着 = await db("li").$queryRawUnsafe<{ n: number }[]>('SELECT COUNT(*) AS n FROM "_sync_attach_up" WHERE "id" LIKE \'nofile%\'');
    expect(Number(记着[0].n)).toBe(520);
    // 收拾掉：后面的用例不用背着这 520 行
    await db("li").attachment.deleteMany({ where: { id: { startsWith: "nofile" } } });
    await 都轮("li", "boss");
  }, 60_000);

  it("图片在同步一轮之外传：传得慢不拖着同步一轮（质量审 #93 D）", async () => {
    let 放行!: () => void;
    const 闸 = new Promise<void>((r) => { 放行 = r; });
    图通道.设附件传输(async (方法, 路径, body) => { if (方法 === "PUT") await 闸; return 附件传(方法, 路径, body); });
    try {
      const a = await 存("li", "o-li", 图(4000, 10));
      const 云端 = 云端文件(a.id); // 云端文件() 会切到老板那台：先算好，再切回业务员
      当("li");
      const r = await Promise.race([client.同步一轮(), new Promise((ok) => setTimeout(() => ok("超时"), 10_000))]);
      expect(r).toMatchObject({ ok: true });
      expect(fs.existsSync(云端)).toBe(false);
      放行();
      await client.等图片();
      expect(fs.existsSync(云端)).toBe(true);
    } finally {
      放行();
      图通道.设附件传输(附件传);
    }
  });

  it("云端还没有这一行（404 等行）：算进一轮 20 张，下一轮先不碰，过一阵再试（质量审 #93 E）", async () => {
    let 传 = 0;
    图通道.设附件传输(async (方法, 路径, body) => { if (方法 === "PUT") { 传++; return { 状态: 404, json: { error: "这张图还没同步上来" } }; } return 附件传(方法, 路径, body); });
    try {
      for (let i = 0; i < 25; i++) await 存("li", "o-li", 图(200, 20 + i));
      当("li");
      const 现在 = Date.now();
      await 图通道.附件通道一轮(读配置("li"), 现在);
      expect(传).toBe(20);
      await 图通道.附件通道一轮(读配置("li"), 现在 + 1000);
      expect(传).toBe(25); // 前 20 张在等，只碰剩下的 5 张
      await 图通道.附件通道一轮(读配置("li"), 现在 + 2000);
      expect(传).toBe(25);
      await 图通道.附件通道一轮(读配置("li"), 现在 + 61_000);
      expect(传).toBe(45);
    } finally {
      图通道.设附件传输(附件传);
    }
  });

  it("运营台磁盘线：剩不到 12 GB 或图片超过 10 GB 才报，一天一条", async () => {
    const { 磁盘通知 } = await import("@/lib/ops-notices");
    const GB = 1024 ** 3, 现在 = new Date("2026-10-22T10:00:00Z");
    expect(磁盘通知({ 剩: 50 * GB, 用: 2 * GB }, 现在, {})).toBeNull();
    expect(磁盘通知(null, 现在, {})).toBeNull();
    expect(磁盘通知({ 剩: 11 * GB, 用: 2 * GB }, 现在, {})).toMatchObject({ kind: "磁盘", key: "磁盘:2026-10-22", 标题: "服务器磁盘只剩 11.0 GB" });
    expect(磁盘通知({ 剩: 50 * GB, 用: 11 * GB }, 现在, {})).toMatchObject({ kind: "磁盘", 标题: "团队图片已占 11.0 GB" });
    expect(磁盘通知({ 剩: 50 * GB, 用: 11 * GB }, 现在, { OPS_ALERT_ATTACH_GB: "20" })).toBeNull();
  });
});
