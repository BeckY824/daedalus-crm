/**
 * 团队同步 · 移除成员 + 换邀请码 + 换钥匙（2026-10-04）。
 * 甲：真实的桌面端客户端（lib/sync/client.ts，库是拷出来的一份）；云端：真实的中转函数（lib/tenant/sync-relay.ts，临时控制库）；
 * 乙、丙、丁：别的电脑，直接调中转 + 加密函数模拟。
 *   - 加密：批次带编号、钥匙环解老批次、封给 / 拆自、钥匙不对解不开
 *   - 移除丙：钥匙换成 1 号；乙取到封给自己的新钥匙；丙推拉取钥匙都 403；用旧钥匙推的不收
 *   - 旧邀请码作废；新邀请码进来的人解得开钥匙环、读得到移除之前的批次
 *   - 换邀请码：钥匙再换一把，乙照样拿到
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sync-rotate-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}` }) };
});

import { prisma as 甲 } from "@/lib/prisma";
import { 建团队, 同步一轮, 读团队, 设传输, 解邀请码, 邀请码, 移除成员, 换邀请码, 团队状态, type 传输 } from "@/lib/sync/client";
import { 封, 拆, 包的编号, 设备钥匙对, 封给, 拆自, 新钥匙, 验, type 钥匙环 } from "@/lib/sync/crypto";
import type { 改动 } from "@/lib/sync/local";
import { closeTestDatabases } from "./close-databases";

type 中转 = typeof import("@/lib/tenant/sync-relay");
let r: 中转;
const 账号们: Record<string, string> = {};

/** 甲那台的云端：路径 → 真实的中转函数，身份固定是甲 */
const 甲的传输: 传输 = async (方法, 路径, body) => {
  const u = new URL(`http://x${路径}`);
  const b = (body ?? {}) as Record<string, unknown>;
  const q = (k: string) => u.searchParams.get(k) ?? "";
  const 甲号 = 账号们.甲;
  const 包 = (x: { ok: boolean; 状态?: number; error?: string }) => (x.ok ? { 状态: 200, json: x as Record<string, unknown> } : { 状态: x.状态 ?? 500, json: { error: x.error } });
  if (方法 === "POST" && u.pathname === "/api/sync/team") return 包(await r.建团队(甲号, String(b.name), { device: String(b.device), pubKey: String(b.pubKey) }));
  if (方法 === "GET" && u.pathname === "/api/sync/team") return { 状态: 200, json: { ok: true, teams: await r.我的团队(甲号) } };
  if (方法 === "POST" && u.pathname === "/api/sync/push") return 包(await r.收推送(甲号, String(b.teamId), String(b.device), String(b.data)));
  if (方法 === "GET" && u.pathname === "/api/sync/pull") return 包(await r.给拉取(甲号, q("teamId"), Number(q("after"))));
  if (方法 === "GET" && u.pathname === "/api/sync/key") return 包(await r.取钥匙(甲号, q("teamId"), q("device")));
  if (方法 === "GET" && u.pathname === "/api/sync/devices") return 包(await r.团队设备(甲号, q("teamId")));
  if (方法 === "POST" && u.pathname === "/api/sync/rotate") return 包(await r.换钥匙(甲号, String(b.teamId), Number(b.epoch), String(b.ring), b.envelopes as { device: string; data: string }[]));
  if (方法 === "POST" && u.pathname === "/api/sync/remove") return 包(await r.移除成员(甲号, String(b.teamId), String(b.accountId)));
  if (方法 === "POST" && u.pathname === "/api/sync/secret") return 包(await r.换口令(甲号, String(b.teamId)));
  return { 状态: 404, json: { error: `假传输没有 ${方法} ${路径}` } };
};

const 根 = 临时.dir;
beforeAll(async () => {
  process.env.MULTI_TENANT = "1";
  process.env.SYNC_DIR = path.join(根, "sync");
  process.env.CONTROL_DATABASE_URL = `file:${path.join(根, "control.db")}`;
  const sql = execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(根, "control.sql"), sql);
  execFileSync("node", ["--experimental-sqlite", "-e", "const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs'); const db = new DatabaseSync(process.argv[1]); db.exec(fs.readFileSync(process.argv[2], 'utf8')); db.close();", path.join(根, "control.db"), path.join(根, "control.sql")], { stdio: "pipe" });
  r = await import("@/lib/tenant/sync-relay");
  const { control } = await import("@/lib/tenant/control");
  for (const 名 of ["甲", "乙", "丙", "丁"]) 账号们[名] = (await control.account.create({ data: { email: `${名}@x.com`, password: "x", name: 名 } })).id;

  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 根;
  fs.writeFileSync(path.join(根, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号们.甲, name: "甲", contact: "jia@x.com", models: [], loggedAt: new Date().toISOString() }));
  设传输(甲的传输);
  // 甲的库：清掉别的用例留下的，种模板账号
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead"]) await 甲.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await 甲.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await 甲.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await 甲.user.create({ data: { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN", password: "x", title: "管理员" } });
});

afterAll(async () => {
  设传输(null);
  for (const k of ["MULTI_TENANT", "SYNC_DIR", "DESKTOP_LOCAL", "CRM_DATA_DIR"]) delete process.env[k];
  await 甲.$disconnect();
  await closeTestDatabases(根);
  fs.rmSync(根, { recursive: true, force: true });
});

describe("加密", () => {
  it("批次带钥匙编号；钥匙环按编号取钥匙；钥匙不对解不开", () => {
    const k0 = 新钥匙(), k1 = 新钥匙();
    const 包 = 封([{ t: "Customer" }], k1, 1);
    expect(包的编号(包)).toBe(1);
    expect(拆(包, { "0": k0, "1": k1 })).toEqual([{ t: "Customer" }]);
    expect(() => 拆(包, { "0": k0 })).toThrow(/没有 1 号钥匙/);
    expect(() => 拆(包, k0)).toThrow();
  });

  it("封给一台设备：只有它的私钥解得开", () => {
    const 乙 = 设备钥匙对(), 丙 = 设备钥匙对();
    const 信 = 封给(乙.公钥, "新钥匙");
    expect(拆自(乙.私钥, 信)).toBe("新钥匙");
    expect(() => 拆自(丙.私钥, 信)).toThrow();
  });
});

describe("移除成员 + 换钥匙", () => {
  const 乙对 = 设备钥匙对(), 丙对 = 设备钥匙对();
  let teamId = "", 码0 = "", 甲第一批 = 0;
  /* 模拟别的成员怎么拆（和 lib/sync/client.ts 一样）：批次绑团队 + 设备，钥匙环和信封先验老板的签名 */
  const 老板公钥 = () => 解邀请码(码0)!.signPub!;
  const 拆批 = (b: { data: string; device: string }, k: string | 钥匙环) => 拆<改动[]>(b.data, k, { teamId, device: b.device });
  const 拆环 = (环: string, k: string, epoch: number) => 拆<{ keys: 钥匙环 }>(验(环, `ring|${teamId}|${epoch}`, 老板公钥())!, k, { teamId, device: "ring" }).keys;
  const 拆信 = (信: string, 私: string, epoch: number, device: string) => 拆自(私, 验(信, `env|${teamId}|${epoch}|${device}`, 老板公钥())!);

  it("甲建团队、乙丙入队、甲推全量，乙用码里的钥匙解得开", async () => {
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: "cmusc55660000dulko96ek8kr" } });
    const t = await 建团队("明亮贸易");
    if (!t.ok) throw new Error(t.error);
    码0 = t.邀请码;
    const 解 = 解邀请码(码0)!;
    teamId = 解.teamId;
    await r.设开通(teamId, true);
    expect((await r.入队(账号们.乙, teamId, 解.joinSecret, { device: "dYi0001", pubKey: 乙对.公钥 })).ok).toBe(true);
    expect((await r.入队(账号们.丙, teamId, 解.joinSecret, { device: "dBing01", pubKey: 丙对.公钥 })).ok).toBe(true);
    expect(await 同步一轮()).toMatchObject({ ok: true });
    const 拉 = await r.给拉取(账号们.乙, teamId, 0);
    if (!拉.ok) throw new Error(拉.error);
    expect(拉.epoch).toBe(0);
    甲第一批 = 拉.batches[0].seq;
    expect(解.signPub).toMatch(/^[\w-]{43}$/); // DT2：带老板的签名公钥
    expect(拆批(拉.batches[0], 解.key).some((e) => e.t === "Customer" && e.k === "c1")).toBe(true);
    // 批次绑了团队和设备：中转改了设备编号就解不开
    expect(() => 拆<改动[]>(拉.batches[0].data, 解.key, { teamId, device: "dFake01" })).toThrow();
  });

  it("移除丙：钥匙换成 1 号，乙拿到封给自己的；丙推拉、取钥匙都不行；旧邀请码作废", async () => {
    expect(await 移除成员(账号们.丙)).toMatchObject({ ok: true });
    const c = 读团队()!;
    expect(c.epoch).toBe(1);
    expect(c.joinSecret).not.toBe(解邀请码(码0)!.joinSecret);

    const 乙钥 = await r.取钥匙(账号们.乙, teamId, "dYi0001");
    if (!乙钥.ok) throw new Error(乙钥.error);
    expect(乙钥.epoch).toBe(1);
    const k1 = 拆信(乙钥.envelope!, 乙对.私钥, 1, "dYi0001");
    expect(k1).toBe(c.key);
    expect(拆环(乙钥.ring!, k1, 1)).toEqual({ "0": 解邀请码(码0)!.key });
    // 信封挪给别的设备 / 别的编号：签名对不上
    expect(验(乙钥.envelope!, `env|${teamId}|1|dBing01`, 老板公钥())).toBeNull();
    expect(验(乙钥.envelope!, `env|${teamId}|2|dYi0001`, 老板公钥())).toBeNull();

    expect((await r.取钥匙(账号们.丙, teamId, "dBing01")).ok).toBe(false);
    expect((await r.给拉取(账号们.丙, teamId, 0)).ok).toBe(false);
    expect((await r.收推送(账号们.丙, teamId, "dBing01", 封([], 解邀请码(码0)!.key, 0))).ok).toBe(false);
    // 丙拿着旧邀请码回不来
    expect((await r.入队(账号们.丙, teamId, 解邀请码(码0)!.joinSecret, { device: "dBing02", pubKey: 丙对.公钥 })).ok).toBe(false);
  });

  it("乙用旧钥匙推的不收；用新钥匙推的甲收得到", async () => {
    const k0 = 解邀请码(码0)!.key, k1 = 读团队()!.key;
    // 建团队时甲的管理员 id 已经改成按云端账号算的（改身份）
    const 甲id = (await 甲.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id;
    const 一条: 改动[] = [{ t: "Customer", k: "c2", o: "I", r: { id: "c2", name: "李总", phone: "13800000002", salesOwnerId: 甲id, followStatus: "待跟进", decisionStatus: "了解中", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, c: ["id", "name", "phone", "salesOwnerId", "followStatus", "decisionStatus", "createdAt", "updatedAt"], h: `${String(Date.now()).padStart(15, "0")}-dYi0001` }];
    expect(await r.收推送(账号们.乙, teamId, "dYi0001", 封(一条, k0, 0, { teamId, device: "dYi0001" }))).toMatchObject({ ok: false, 状态: 409 });
    // 比现在还新的编号也不收（复查低 4：没人有那把钥匙，收下全队都卡住）
    expect(await r.收推送(账号们.乙, teamId, "dYi0001", 封(一条, 新钥匙(), 5, { teamId, device: "dYi0001" }))).toMatchObject({ ok: false, 状态: 409 });
    expect((await r.收推送(账号们.乙, teamId, "dYi0001", 封(一条, k1, 1, { teamId, device: "dYi0001" }))).ok).toBe(true);
    expect(await 同步一轮()).toMatchObject({ ok: true });
    expect(await 甲.$queryRawUnsafe("SELECT tbl, pk, why FROM _sync_skip")).toEqual([]);
    expect(await 甲.customer.count({ where: { id: "c2" } })).toBe(1);
  });

  it("新邀请码进来的丁：解得开钥匙环，读得到移除之前（0 号钥匙）的批次", async () => {
    const 新码 = 解邀请码(邀请码(读团队()!))!;
    const 丁对 = 设备钥匙对();
    expect((await r.入队(账号们.丁, teamId, 新码.joinSecret, { device: "dDing01", pubKey: 丁对.公钥 })).ok).toBe(true);
    const k = await r.取钥匙(账号们.丁, teamId, "dDing01");
    if (!k.ok) throw new Error(k.error);
    const 环 = { ...拆环(k.ring!, 新码.key, k.epoch), [String(k.epoch)]: 新码.key };
    const 拉 = await r.给拉取(账号们.丁, teamId, 0);
    if (!拉.ok) throw new Error(拉.error);
    const 第一批 = 拉.batches.find((b) => b.seq === 甲第一批)!;
    expect(包的编号(第一批.data)).toBe(0);
    expect(拆批(第一批, 环).some((e) => e.k === "c1")).toBe(true);
  });

  it("换邀请码：钥匙换成 2 号，乙、丁照样拿到；只有建团队的人能换、能移除", async () => {
    const 旧 = 读团队()!;
    const x = await 换邀请码();
    if (!x.ok) throw new Error(x.error);
    expect(读团队()!.epoch).toBe(2);
    expect(解邀请码(x.邀请码)!.joinSecret).not.toBe(旧.joinSecret);
    const 乙钥 = await r.取钥匙(账号们.乙, teamId, "dYi0001");
    expect(乙钥.ok && 拆信(乙钥.envelope!, 乙对.私钥, 2, "dYi0001")).toBe(读团队()!.key);
    expect((await r.换口令(账号们.乙, teamId)).ok).toBe(false);
    expect((await r.移除成员(账号们.乙, teamId, 账号们.丁)).ok).toBe(false);
    expect((await r.换钥匙(账号们.乙, teamId, 3, "x", [])).ok).toBe(false);
    // 编号只能 +1：重放一次 2 号不收
    expect((await r.换钥匙(账号们.甲, teamId, 2, "x", [])).ok).toBe(false);
  });

  it("中转被攻破、塞进一把自己的钥匙：没有老板的签名，甲不收，还用原来那把（复查中 1）", async () => {
    const { control } = await import("@/lib/tenant/control");
    const 前 = 读团队()!;
    const 坏钥匙 = 新钥匙();
    await control.syncKey.create({ data: { teamId, epoch: 3, ring: 封({ keys: {} }, 坏钥匙, 3, { teamId, device: "ring" }) } });
    await control.syncKeyEnvelope.create({ data: { teamId, epoch: 3, device: 前.device, data: 封给(前.devPub!, 坏钥匙) } });
    const x = await 同步一轮();
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error).toMatch(/签名/);
    expect(读团队()!.key).toBe(前.key);
    expect(读团队()!.epoch).toBe(2);
    // 收拾：中转恢复正常
    await control.syncKeyEnvelope.deleteMany({ where: { teamId, epoch: 3 } });
    await control.syncKey.deleteMany({ where: { teamId, epoch: 3 } });
    expect(await 同步一轮()).toMatchObject({ ok: true });
  });

  it("一批解不开的坏包：连着 3 次就跳过、记下，后面的照常收（复查低 4）", async () => {
    const k2 = 读团队()!.key;
    const 坏 = 封([{ t: "Customer" }], 新钥匙(), 2, { teamId, device: "dYi0001" }); // 编号对、钥匙不对
    expect((await r.收推送(账号们.乙, teamId, "dYi0001", 坏)).ok).toBe(true);
    const 好: 改动[] = [{ t: "Customer", k: "c9", o: "I", r: { id: "c9", name: "赵总", phone: "13800000009", salesOwnerId: (await 甲.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id, followStatus: "待跟进", decisionStatus: "了解中", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, c: ["id", "name", "phone", "salesOwnerId", "followStatus", "decisionStatus", "createdAt", "updatedAt"], h: `${String(Date.now()).padStart(15, "0")}-dYi0001` }];
    expect((await r.收推送(账号们.乙, teamId, "dYi0001", 封(好, k2, 2, { teamId, device: "dYi0001" }))).ok).toBe(true);
    expect((await 同步一轮()).ok).toBe(false);
    expect((await 同步一轮()).ok).toBe(false);
    expect(await 同步一轮()).toMatchObject({ ok: true });
    expect(读团队()!.skipped?.length).toBe(1);
    expect(await 甲.customer.count({ where: { id: "c9" } })).toBe(1);
  });

  it("乱写的设备公钥、一个人登记太多台：中转不收（复查低-中 3）", async () => {
    const 新码 = 解邀请码(邀请码(读团队()!))!;
    expect((await r.入队(账号们.丁, teamId, 新码.joinSecret, { device: "dDingXX", pubKey: "a".repeat(60) })).ok).toBe(false);
    for (let i = 2; i <= 5; i++) expect((await r.入队(账号们.丁, teamId, 新码.joinSecret, { device: `dDing0${i}`, pubKey: 设备钥匙对().公钥 })).ok).toBe(true);
    const 第六台 = await r.入队(账号们.丁, teamId, 新码.joinSecret, { device: "dDing06", pubKey: 设备钥匙对().公钥 });
    expect(第六台.ok).toBe(false);
    expect(!第六台.ok && 第六台.error).toMatch(/最多 5 台/);
  });

  it("设备编号认账号：丁拿乙的编号登记、推送都不收", async () => {
    const 新码 = 解邀请码(邀请码(读团队()!))!;
    expect((await r.入队(账号们.丁, teamId, 新码.joinSecret, { device: "dYi0001", pubKey: 设备钥匙对().公钥 })).ok).toBe(false);
    expect((await r.收推送(账号们.丁, teamId, "dYi0001", 封([], 读团队()!.key, 2))).ok).toBe(false);
  });

  it("T-054 换钥匙云端成了、回包丢了：本机还是旧编号；再点换邀请码先追上，丢了回包的那把进了钥匙环", async () => {
    const 前 = 读团队()!;
    const 前号 = 前.epoch!;
    设传输(async (方法, 路径, body) => {
      const x = await 甲的传输(方法, 路径, body);
      return 路径 === "/api/sync/rotate" && x.状态 === 200 ? { 状态: 500, json: { error: "网关超时" } } : x;
    });
    try {
      expect((await 换邀请码()).ok).toBe(false);
    } finally {
      设传输(甲的传输);
    }
    expect(读团队()!.epoch).toBe(前号);
    expect(await r.当前编号(teamId)).toBe(前号 + 1);
    // 乙那台已经按云端拿到了丢了回包的那一把，可能用它推过东西
    const 乙丢的 = await r.取钥匙(账号们.乙, teamId, "dYi0001");
    if (!乙丢的.ok) throw new Error(乙丢的.error);
    const 丢的钥匙 = 拆信(乙丢的.envelope!, 乙对.私钥, 前号 + 1, "dYi0001");

    const 再 = await 换邀请码();
    if (!再.ok) throw new Error(再.error);
    const 后 = 读团队()!;
    expect(后.epoch).toBe(前号 + 2);
    expect(后.keys?.[String(前号 + 1)]).toBe(丢的钥匙);
    const 乙新 = await r.取钥匙(账号们.乙, teamId, "dYi0001");
    if (!乙新.ok) throw new Error(乙新.error);
    expect(拆信(乙新.envelope!, 乙对.私钥, 前号 + 2, "dYi0001")).toBe(后.key);
    expect(拆环(乙新.ring!, 后.key, 前号 + 2)[String(前号 + 1)]).toBe(丢的钥匙);
  });

  it("T-054 换钥匙时追上那一步（更新钥匙）出错：取钥匙失败、传输直接抛，换邀请码都回 {ok:false}，不抛", async () => {
    const 前 = 读团队()!;
    const 坏法: 传输[] = [async () => ({ 状态: 500, json: { error: "取不到团队钥匙" } }), async () => { throw new Error("socket hang up"); }];
    for (const 坏 of 坏法) {
      设传输(async (方法, 路径, body) => {
        // 云端说编号比本机新：换钥匙之前先走 更新钥匙 追上
        if (路径.startsWith("/api/sync/devices")) {
          const x = await 甲的传输(方法, 路径, body);
          return { ...x, json: { ...x.json, epoch: Number(x.json.epoch) + 1 } };
        }
        if (路径.startsWith("/api/sync/key")) return 坏(方法, 路径, body);
        return 甲的传输(方法, 路径, body);
      });
      try {
        const x = await 换邀请码();
        expect(x.ok).toBe(false);
      } finally {
        设传输(甲的传输);
      }
    }
    expect(读团队()!.epoch).toBe(前.epoch);
    expect(读团队()!.key).toBe(前.key);
  });

  it("T-052 有人的设备公钥是坏的（直接塞进库，绕过中转的校验）：换邀请码照样成、跳过那一台，好的几台都拿到新钥匙", async () => {
    const { control } = await import("@/lib/tenant/control");
    await control.syncDevice.create({ data: { teamId, device: "dYiBad1", accountId: 账号们.乙, pubKey: "a".repeat(60) } });
    try {
      const x = await 换邀请码();
      if (!x.ok) throw new Error(x.error);
      expect(x.跳过).toBe(1);
      const c = 读团队()!;
      const 有信的 = (await control.syncKeyEnvelope.findMany({ where: { teamId, epoch: c.epoch } })).map((e) => e.device);
      expect(有信的).toContain("dYi0001");
      expect(有信的).toContain(c.device);
      expect(有信的).not.toContain("dYiBad1");
      const 乙钥 = await r.取钥匙(账号们.乙, teamId, "dYi0001");
      expect(乙钥.ok && 拆信(乙钥.envelope!, 乙对.私钥, c.epoch!, "dYi0001")).toBe(c.key);
    } finally {
      await control.syncDevice.delete({ where: { teamId_device: { teamId, device: "dYiBad1" } } });
    }
  });

  it("云端答得上来、但我已经不在这个团队里：团队状态说「被移出」，不说「连不上云端」", async () => {
    expect(await 团队状态()).toMatchObject({ 在团队: true, 被移出: false });
    // 老板（建团队的人）还有同事在队里：不让走（换钥匙复查低 7）
    const 不让 = await r.退队(账号们.甲, teamId);
    expect(不让.ok).toBe(false);
    expect(!不让.ok && 不让.error).toMatch(/先.*移除/);
    for (const m of (await r.我的团队(账号们.甲)).find((t) => t.id === teamId)!.成员) {
      if (m.accountId !== 账号们.甲) expect((await r.移除成员(账号们.甲, teamId, m.accountId)).ok).toBe(true);
    }
    expect((await r.退队(账号们.甲, teamId)).ok).toBe(true);
    expect(await 团队状态()).toMatchObject({ 在团队: true, 被移出: true });
  });
});
