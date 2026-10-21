/**
 * 范围同步：一次推送按「请求开始时的权限」核（2026-10-14 领取 / 交接修复，scope-policy 推送可写）。
 * 真实控制库 + 真实 sync-scoped 服务端逻辑。正面：领取（任意顺序）、交接带子记录 + 起点、新建后马上交出去；
 * 反面（安全）：伪造归属 / 塞公海 / 借外键抢私客、转交之后的下一次请求、事后补起点、抢领竞态、重放旧事件、被拒的下标与整批回滚。
 */
import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封范围, 拆范围 } from "@/lib/sync/crypto";
import { 提取范围, type 范围索引 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-start-"));
let control: typeof import("@/lib/tenant/control").control;
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
const 号 = { boss: "", li: "", zhao: "", wang: "" };
const 设备 = { boss: "boss-device", li: "li-device", zhao: "zhao-device", wang: "wang-device" };
type 谁 = keyof typeof 号;
let team = "", seq = 0;
const key = 新钥匙();
const A = (w: 谁) => `acct_${号[w]}`;

beforeAll(async () => {
  process.env.MULTI_TENANT = "1"; process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(root, "sync"); process.env.CONTROL_DATABASE_URL = `file:${path.join(root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(root, "control.db"), path.join(root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control")); relay = await import("@/lib/tenant/sync-relay"); scoped = await import("@/lib/tenant/sync-scoped");
  for (const w of Object.keys(号) as 谁[]) 号[w] = (await control.account.create({ data: { name: w, email: `${w}@example.invalid`, password: "not-a-login" } })).id;
  const t = await relay.建团队(号.boss, "start-rights QA", { device: 设备.boss, pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  for (const w of ["li", "zhao", "wang"] as const) await relay.入队(号[w], team, t.joinSecret, { device: 设备[w], pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
  await scoped.开始范围迁移(号.boss, team, 设备.boss);
  // 迁移起点：老板私客（带跟进）、两位公海客户（各带跟进）、li 自己的客户（带计划）
  const 起点 = [
    ev("Customer", "boss-private", { salesOwnerId: A("boss"), name: "QA老板私客" }), ev("FollowUp", "boss-follow", { customerId: "boss-private" }),
    ev("Customer", "pool-a", { salesOwnerId: A("boss") }), ev("CustomerPool", "pool-a", { customerId: "pool-a" }), ev("FollowUp", "pool-a-follow", { customerId: "pool-a" }),
    ev("Customer", "pool-b", { salesOwnerId: A("boss") }), ev("CustomerPool", "pool-b", { customerId: "pool-b" }),
    ev("Customer", "pool-c", { salesOwnerId: A("boss") }), ev("CustomerPool", "pool-c", { customerId: "pool-c" }),
    ev("Customer", "li-own", { salesOwnerId: A("li") }), ev("FollowPlan", "li-plan", { customerId: "li-own", ownerId: A("li") }), ev("FollowUp", "li-follow", { customerId: "li-own" }),
    ev("Customer", "li-second", { salesOwnerId: A("li") }), ev("FollowUp", "li-second-follow", { customerId: "li-second" }),
  ];
  await scoped.收范围推送(号.boss, team, 设备.boss, 起点.map((e) => ({ ...pk(e, "boss"), baseline: true })));
  await scoped.完成范围迁移(号.boss, team, 设备.boss, await control.syncScopedBatch.count({ where: { teamId: team } }));
}, 120_000);
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ["MULTI_TENANT", "CRM_SCOPED_SYNC", "SYNC_DIR", "CONTROL_DATABASE_URL"]) delete process.env[n]; });

function ev(t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 {
  return { t, k, r: o === "D" ? null : { id: k, ...r }, o, c: o === "D" ? [] : c, h: `${1760000000000 + ++seq}-qa` };
}
const 改 = (t: string, k: string, r: Record<string, unknown>) => ev(t, k, r, "U");
const 删 = (t: string, k: string) => ev(t, k, {}, "D");
function pk(e: 改动, w: 谁, baseline = false) {
  const meta = 提取范围(e), eventId = createHmac("sha256", key).update(`${w}|${++seq}|${JSON.stringify(e)}`).digest("hex");
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device: 设备[w], eventId, meta }), ...(baseline ? { baseline: true } : {}) };
}
const 推 = (w: 谁, packets: ReturnType<typeof pk>[]) => scoped.收范围推送(号[w], team, 设备[w], packets);
const 推事件 = (w: 谁, es: 改动[], 起点: 改动[] = []) => 推(w, [...es.map((e) => pk(e, w)), ...起点.map((e) => pk(e, w, true))]);
async function 被拒(p: Promise<unknown>): Promise<number[]> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toMatchObject({ 状态: 403 });
  return (e as { denied?: number[] }).denied ?? [];
}
async function 索引(k: string) {
  const r = await control.syncScopedRecord.findUnique({ where: { teamId_key: { teamId: team, key: k } } });
  return r ? (JSON.parse(r.metadata) as 范围索引) : null;
}
const 看得到 = async (w: 谁, scopeId: string) => (await scoped.范围目录(号[w], team)).scopes.some((s) => s.id === scopeId);
const 拉 = (w: 谁, scopeId: string) => scoped.给范围拉取(号[w], team, scopeId, 0);
const 批数 = () => control.syncScopedBatch.count({ where: { teamId: team } });
/** 记录当前状态的起点快照（客户端 记录快照 的样子：整行插入，字段钟最低） */
const 快照 = (t: string, k: string, r: Record<string, unknown>): 改动 => ({ t, k, r: { id: k, ...r }, o: "I", c: Object.keys({ id: k, ...r }), h: "0000000000000-snapshot" });

it("服务端声明新的推送规则，客户端据此把转交和起点放进同一次请求", async () => {
  expect(await scoped.范围状态(号.li, team)).toMatchObject({ pushRule: "request-start", maxPackets: 1000 });
});

it("领取（旧客户端的顺序：先删公海、再改负责人）放在同一次请求里：整批收下，其他人那边出了公海、归 li", async () => {
  expect(await 看得到("wang", "Customer:pool-a")).toBe(true);
  const r = await 推事件("li", [删("CustomerPool", "pool-a"), 改("Customer", "pool-a", { salesOwnerId: A("li") }), ev("CustomerClaim", "pool-a", { customerId: "pool-a", userId: A("li") })], [快照("Customer", "pool-a", { salesOwnerId: A("li") }), 快照("FollowUp", "pool-a-follow", { customerId: "pool-a" })]);
  expect(r.stored).toBe(5);
  expect((await 索引("Customer:pool-a"))?.fields.salesOwnerId).toBe(A("li"));
  expect((await 索引("CustomerPool:pool-a"))?.deleted).toBe(true);
  expect(await 看得到("wang", "Customer:pool-a")).toBe(false);
  await expect(拉("wang", "Customer:pool-a")).rejects.toMatchObject({ 状态: 403 });
  // 领到的人自己从这份起点继续拉（改归属之后非老板只从起点拉）
  const got = await 拉("li", "Customer:pool-a");
  expect(got.batches.map((b) => b.meta.t)).toEqual(expect.arrayContaining(["Customer", "FollowUp"]));
  // 领到之后老板给这位新记的跟进：整段历史都在改归属之后，不用起点，li 直接拉得到；老板那台也不必为它补起点
  await 推事件("boss", [ev("FollowUp", "pool-a-after", { customerId: "pool-a" })]);
  expect((await 拉("li", "Customer:pool-a")).batches.some((b) => b.meta.k === "pool-a-after")).toBe(true);
  expect((await scoped.范围目录(号.boss, team) as { needBaseline?: string[] }).needBaseline).not.toContain("FollowUp:pool-a-after");
});

it("领取被切成前后两次请求：只删公海不改负责人那一次被拒（不能把公海客户扯成老板私客）；新顺序（先改负责人）两次都过；领完再改负责人以外的人照样被拒", async () => {
  const before = await 批数();
  expect(await 被拒(推事件("li", [删("CustomerPool", "pool-b")]))).toEqual([0]);
  expect(await 批数()).toBe(before);
  expect((await 索引("CustomerPool:pool-b"))?.deleted).toBe(false);
  // 新顺序（本版客户端的 领取）：改负责人那一刻还在公海、删公海那一刻已归自己——切成两次请求也都过
  await 推事件("li", [改("Customer", "pool-c", { salesOwnerId: A("li") })]);
  await 推事件("li", [ev("CustomerClaim", "pool-c", { customerId: "pool-c", userId: A("li") }), 删("CustomerPool", "pool-c")]);
  expect((await 索引("Customer:pool-c"))?.fields.salesOwnerId).toBe(A("li"));
  expect((await 索引("CustomerPool:pool-c"))?.deleted).toBe(true);
  // 被 li 领走之后 wang 再「领」：两种状态下都不可读，整批拒
  expect(await 被拒(推事件("wang", [改("Customer", "pool-c", { salesOwnerId: A("wang") }), 删("CustomerPool", "pool-c")]))).toEqual([0, 1]);
});

it("交接 li → zhao：转交、转交后改计划 / 记操作日志、起点快照同一次请求全收；zhao 拉得到，li 下一次请求再写被拒", async () => {
  const r = await 推事件("li", [
    改("Customer", "li-own", { salesOwnerId: A("zhao") }),
    改("FollowPlan", "li-plan", { ownerId: A("zhao") }),
    ev("AuditLog", "audit-handover", { userId: A("li"), entity: "Customer", entityId: "li-own" }),
  ], [快照("Customer", "li-own", { salesOwnerId: A("zhao") }), 快照("FollowPlan", "li-plan", { customerId: "li-own", ownerId: A("zhao") }), 快照("FollowUp", "li-follow", { customerId: "li-own" }), 快照("AuditLog", "audit-handover", { userId: A("li"), entity: "Customer", entityId: "li-own" })]);
  expect(r.stored).toBe(7);
  expect(await 看得到("li", "Customer:li-own")).toBe(false);
  const got = await 拉("zhao", "Customer:li-own");
  expect(new Set(got.batches.map((b) => `${b.meta.t}:${b.meta.k}`))).toEqual(new Set(["Customer:li-own", "FollowPlan:li-plan", "FollowUp:li-follow", "AuditLog:audit-handover"]));
  // 只给起点及之后：转交之前 li 名下的历史（迁移起点那几包）不给 zhao
  const 起点批 = Math.min(...got.batches.map((b) => b.seq));
  expect(got.batches.every((b) => b.seq >= 起点批)).toBe(true);
  // 下一次请求：转交出去之后再写子记录、再补起点，都按新状态核 → 被拒，整批不落
  const before = await 批数();
  expect(await 被拒(推事件("li", [改("FollowPlan", "li-plan", { ownerId: A("li") })]))).toEqual([0]);
  expect(await 被拒(推("li", [pk(快照("Customer", "li-own", { salesOwnerId: A("zhao") }), "li", true)]))).toEqual([0]);
  expect(await 被拒(推事件("li", [改("Customer", "li-own", { salesOwnerId: A("li") })]))).toEqual([0]);
  expect(await 批数()).toBe(before);
});

it("新建客户和计划、马上交给同事、再改计划：同一次请求收下（起点视图里新建的那一版归他自己）", async () => {
  const r = await 推事件("li", [
    ev("Customer", "li-new", { salesOwnerId: A("li") }), ev("FollowPlan", "li-new-plan", { customerId: "li-new", ownerId: A("li") }),
    改("Customer", "li-new", { salesOwnerId: A("wang") }), 改("FollowPlan", "li-new-plan", { ownerId: A("wang") }),
  ], [快照("Customer", "li-new", { salesOwnerId: A("wang") }), 快照("FollowPlan", "li-new-plan", { customerId: "li-new", ownerId: A("wang") })]);
  expect(r.stored).toBe(6);
  expect(await 看得到("wang", "Customer:li-new")).toBe(true);
  expect((await 拉("wang", "Customer:li-new")).batches.length).toBeGreaterThan(0);
  // 但不能直接给同事新建（从没归过自己）：两种状态下都不可读
  expect(await 被拒(推事件("li", [ev("Customer", "li-direct", { salesOwnerId: A("wang") })]))).toEqual([0]);
});

it("伪造：抢老板私客、塞公海行、借外键挂子记录、把自己的跟进挪进私客——同一次请求里怎么排都被拒，被拒的下标准确、整批回滚", async () => {
  const before = await 批数();
  expect(await 被拒(推事件("li", [改("Customer", "boss-private", { salesOwnerId: A("li") })]))).toEqual([0]);
  expect(await 被拒(推事件("li", [ev("CustomerPool", "boss-private", { customerId: "boss-private" }), 改("Customer", "boss-private", { salesOwnerId: A("li") })]))).toEqual([0, 1]);
  expect(await 被拒(推事件("li", [ev("Contact", "fake-contact", { customerId: "boss-private" }), 改("FollowUp", "boss-follow", { customerId: "li-second" })]))).toEqual([0, 1]);
  expect(await 被拒(推事件("li", [改("FollowUp", "li-second-follow", { customerId: "boss-private" })]))).toEqual([0]);
  // 先把自己的客户交给老板、再借「起点视图」改老板私客：私客在请求开始时就不可读，照样拒
  expect(await 被拒(推事件("li", [改("Customer", "li-second", { salesOwnerId: A("boss") }), 改("Customer", "boss-private", { remark: "x" } as Record<string, unknown>), 删("FollowUp", "boss-follow")]))).toEqual([1, 2]);
  // 起点包也一样核：给私客推「起点」被拒
  expect(await 被拒(推("li", [pk(快照("Customer", "boss-private", { salesOwnerId: A("li") }), "li", true)]))).toEqual([0]);
  // 合法和伪造混在一起：只报伪造那一包；依赖合法新建的子记录不被误伤；整批不落
  expect(await 被拒(推事件("li", [改("Customer", "boss-private", { salesOwnerId: A("li") }), ev("Customer", "li-z", { salesOwnerId: A("li") }), ev("FollowUp", "li-z-follow", { customerId: "li-z" })]))).toEqual([0]);
  expect(await 批数()).toBe(before);
  expect(await 索引("Customer:li-z")).toBeNull();
  expect((await 索引("Customer:boss-private"))?.fields.salesOwnerId).toBe(A("boss"));
  expect(await 看得到("li", "Customer:boss-private")).toBe(false);
});

it("抢领竞态：li 和 wang 同时领同一位，先到的收下；后到的整批 403、领取相关包全被拒，归属不变", async () => {
  await 推事件("boss", [ev("Customer", "race", { salesOwnerId: A("boss") }), ev("CustomerPool", "race", { customerId: "race" })]);
  const 领 = (w: 谁) => [改("Customer", "race", { salesOwnerId: A(w) }), ev("CustomerClaim", "race", { customerId: "race", userId: A(w) }), 删("CustomerPool", "race")];
  const li = 领("li"), wang = 领("wang");
  const [a, b] = await Promise.allSettled([推事件("li", li, [快照("Customer", "race", { salesOwnerId: A("li") })]), 推事件("wang", wang, [快照("Customer", "race", { salesOwnerId: A("wang") })])]);
  const 赢 = a.status === "fulfilled" ? "li" : "wang";
  expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  const 输 = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
  expect(输.reason).toMatchObject({ 状态: 403, denied: [0, 1, 2, 3] });
  expect((await 索引("Customer:race"))?.fields.salesOwnerId).toBe(A(赢));
  expect((await 索引("CustomerPool:race"))?.deleted).toBe(true);
  expect(await 看得到(赢 === "li" ? "wang" : "li", "Customer:race")).toBe(false);
});

it("重放：失权后原样重发转交前的旧事件只当重复（不落、不改归属）；同 eventId 换内容也只当重复、不落盘（2026-10-21 原来 409）", async () => {
  const e = 改("Customer", "li-second", { salesOwnerId: A("li") });
  const p = pk(e, "li");
  await 推("li", [p]);
  await 推事件("boss", [改("Customer", "li-second", { salesOwnerId: A("boss") })]);
  const before = await 批数();
  // stored 算「这次的包在中转上落着的条数」，重发的也算（2026-10-21：迁移靠它对数）；没多落一批看下一行
  expect(await 推("li", [p])).toMatchObject({ stored: 1 });
  expect(await 批数()).toBe(before);
  expect((await 索引("Customer:li-second"))?.fields.salesOwnerId).toBe(A("boss"));
  const swapped = 封范围({ meta: p.meta, change: { ...e, r: { ...e.r, remark: "swap" } } }, key, 0, { teamId: team, device: 设备.li, eventId: p.eventId, meta: p.meta });
  expect(await 推("li", [{ ...p, data: swapped }])).toMatchObject({ stored: 1 });
  expect(await 批数()).toBe(before);
  expect((await 索引("Customer:li-second"))?.fields.salesOwnerId).toBe(A("boss"));
});

it("交出去的人没附起点（旧客户端 / 起点太大）：老板目录列出 needBaseline，老板补推后接手的人拉得到；只给老板", async () => {
  await 推事件("li", [ev("Customer", "li-old-client", { salesOwnerId: A("li") }), ev("FollowUp", "li-old-follow", { customerId: "li-old-client" })]);
  await 推事件("li", [改("Customer", "li-old-client", { salesOwnerId: A("zhao") })]);
  expect((await 拉("zhao", "Customer:li-old-client")).batches).toHaveLength(0);
  const d = await scoped.范围目录(号.boss, team) as { needBaseline?: string[] };
  expect(d.needBaseline).toEqual(expect.arrayContaining(["Customer:li-old-client", "FollowUp:li-old-follow"]));
  expect((await scoped.范围目录(号.zhao, team) as { needBaseline?: string[] }).needBaseline).toBeUndefined();
  await 推("boss", [pk(快照("Customer", "li-old-client", { salesOwnerId: A("zhao") }), "boss", true), pk(快照("FollowUp", "li-old-follow", { customerId: "li-old-client" }), "boss", true)]);
  expect((await scoped.范围目录(号.boss, team) as { needBaseline?: string[] }).needBaseline).not.toEqual(expect.arrayContaining(["Customer:li-old-client"]));
  expect((await 拉("zhao", "Customer:li-old-client")).batches).toHaveLength(2);
});

it("业务员把自己的客户放进公海并附起点：同事马上拉得到；老板批量改负责人不受限", async () => {
  await 推事件("zhao", [ev("Customer", "zhao-pool", { salesOwnerId: A("zhao") })]);
  await 推事件("zhao", [ev("CustomerPool", "zhao-pool", { customerId: "zhao-pool" })], [快照("Customer", "zhao-pool", { salesOwnerId: A("zhao") })]);
  expect((await 拉("wang", "Customer:zhao-pool")).batches.length).toBeGreaterThan(0);
  await 推事件("boss", [改("Customer", "li-own", { salesOwnerId: A("wang") }), 改("Customer", "zhao-pool", { salesOwnerId: A("li") })]);
  expect((await 索引("Customer:li-own"))?.fields.salesOwnerId).toBe(A("wang"));
});

it("一次最多 1000 包，超了 413", async () => {
  const many = Array.from({ length: 1001 }, (_, i) => pk(ev("Customer", `bulk-${i}`, { salesOwnerId: A("li") }), "li"));
  await expect(推("li", many)).rejects.toMatchObject({ 状态: 413 });
});

it("已删除、没有改归属之后起点的记录（例如领取时删掉的公海那一行）：同一账号的另一台 / 接手的人只拿到那一包删除，删除包不带内容（候选 6 实机）", async () => {
  const 解 = (b: { device: string; eventId: string; meta: unknown; data: string }) => 拆范围(b.data, { "0": key }, { teamId: team, device: b.device, eventId: b.eventId, meta: b.meta as never }) as { change: 改动 };
  // li 在第一台领走了 pool-a（同一次请求里删了公海那一行）：li 的第二台从头拉这个范围，要收到删公海那一包
  const a = await 拉("li", "Customer:pool-a");
  const del = a.batches.filter((b) => b.meta.t === "CustomerPool" && b.meta.k === "pool-a");
  expect(del).toHaveLength(1);
  expect(del[0].meta.o).toBe("D");
  expect(解(del[0]).change).toMatchObject({ o: "D", r: null, c: [] });
  // 交接：转交之前已删掉的跟进，接手的人只拿到删除（没有它被删之前的内容）
  await 推事件("li", [ev("Customer", "hd", { salesOwnerId: A("li") }), ev("FollowUp", "hd-f", { customerId: "hd", content: "QA删掉前的跟进" } as Record<string, unknown>)]);
  await 推事件("li", [删("FollowUp", "hd-f")]);
  await 推事件("li", [改("Customer", "hd", { salesOwnerId: A("zhao") })], [快照("Customer", "hd", { salesOwnerId: A("zhao") })]);
  const z = await 拉("zhao", "Customer:hd");
  const f = z.batches.filter((b) => b.meta.k === "hd-f");
  expect(f.map((b) => b.meta.o)).toEqual(["D"]);
  expect(JSON.stringify(z.batches.map(解))).not.toContain("QA删掉前的跟进");
  // 别的业务员（看不到的范围）照样 403
  await expect(拉("wang", "Customer:hd")).rejects.toMatchObject({ 状态: 403 });
});

it("删除之后又来 60 条字段钟更早的改动：删除包照样下发（索引里记 delSeq）；没有 delSeq 的旧索引按记录分页找到（2026-10-14 安全复查 low #2）", async () => {
  await 推事件("li", [ev("Customer", "d3", { salesOwnerId: A("li") }), ev("FollowUp", "d3-a", { customerId: "d3" }), ev("FollowUp", "d3-b", { customerId: "d3" })]);
  await 推事件("li", [删("FollowUp", "d3-a"), 删("FollowUp", "d3-b")]);
  expect((await 索引("FollowUp:d3-a"))?.delSeq).toBeGreaterThan(0);
  // 60 条比删除更早字段钟的改动（离线设备迟到的旧改动）：不会把记录改回来，原来的固定回看 50 条就找不到删除包了
  const 旧改 = (k: string, i: number): 改动 => ({ t: "FollowUp", k, r: { id: k, content: `旧改动${i}` }, o: "U", c: ["content"], h: `${1700000000000 + i}-qa` });
  for (const k of ["d3-a", "d3-b"]) await 推("li", Array.from({ length: 60 }, (_, i) => pk(旧改(k, i), "li")));
  expect((await 索引("FollowUp:d3-a"))?.deleted).toBe(true);
  // d3-b 模拟「这次改动之前建的索引」：去掉 delSeq
  const rb = await control.syncScopedRecord.findUniqueOrThrow({ where: { teamId_key: { teamId: team, key: "FollowUp:d3-b" } } });
  const mb = JSON.parse(rb.metadata) as 范围索引; delete mb.delSeq;
  await control.syncScopedRecord.update({ where: { teamId_key: { teamId: team, key: "FollowUp:d3-b" } }, data: { metadata: JSON.stringify(mb) } });
  // 交给 zhao：两条跟进都只给删除包，旧改动一条不给
  await 推事件("li", [改("Customer", "d3", { salesOwnerId: A("zhao") })], [快照("Customer", "d3", { salesOwnerId: A("zhao") })]);
  const got = await 拉("zhao", "Customer:d3");
  for (const k of ["d3-a", "d3-b"]) expect(got.batches.filter((b) => b.meta.k === k).map((b) => b.meta.o)).toEqual(["D"]);
  // 删掉之后又被更新的改动改回来（字段钟更晚）：不再是 deleted，delSeq 用不上，照旧要起点
  await 推事件("zhao", [{ t: "FollowUp", k: "d3-a", r: { id: "d3-a", customerId: "d3" }, o: "I", c: ["id", "customerId"], h: `${1790000000000 + ++seq}-qa` }]);
  expect((await 索引("FollowUp:d3-a"))?.deleted).toBe(false);
});
