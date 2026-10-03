/**
 * 团队同步 · 桌面端这一头（lib/sync/client.ts，2026-10-03）。
 * 甲：走真实的客户端代码（建团队、同步一轮、退出）；乙：另一份库，直接用本机那一半的函数模拟另一台电脑；
 * 云端：一个内存里的假中转（规矩和 lib/tenant/sync-relay.ts 一样：未开通不收、按序号推拉）。
 * 甲用的库是拷出来的一份（vi.mock 换掉 @/lib/prisma），触发器碰不到共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  // vi.hoisted 比 import 先跑，拿不到上面导入的模块：用 Node 自带的取法
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sync-client-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}` }) };
});

import { PrismaClient } from "@/generated/prisma";
import { prisma as 甲 } from "@/lib/prisma";
import { 建团队, 同步一轮, 退出团队, 读团队, 设传输, 解邀请码, 团队状态, type 传输 } from "@/lib/sync/client";
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放, 装了吗 } from "@/lib/sync/local";
import { 封, 拆 } from "@/lib/sync/crypto";
import { 疑似重复 } from "@/lib/sync/dupes";

/* ---------------- 假中转 ---------------- */
const 云 = { 团队: new Map<string, { name: string; secret: string; active: boolean; 人: Set<string> }>(), 批: [] as { seq: number; team: string; device: string; data: string }[] };
const 当前账号 = "jia";
const 假传输: 传输 = async (方法, 路径, body) => {
  const b = (body ?? {}) as Record<string, string>;
  if (方法 === "POST" && 路径 === "/api/sync/team") {
    const id = `team${云.团队.size + 1}xxxxxxx`;
    云.团队.set(id, { name: b.name, secret: "s3cret", active: false, 人: new Set([当前账号]) });
    return { 状态: 200, json: { ok: true, teamId: id, joinSecret: "s3cret" } };
  }
  if (方法 === "GET" && 路径 === "/api/sync/team") {
    return { 状态: 200, json: { ok: true, teams: [...云.团队].filter(([, t]) => t.人.has(当前账号)).map(([id, t]) => ({ id, name: t.name, active: t.active, 我是建的人: true, 成员: [...t.人].map((a) => ({ accountId: a, name: a, contact: `${a}@x.com`, role: "member" })) })) } };
  }
  if (方法 === "POST" && 路径 === "/api/sync/leave") return { 状态: 200, json: { ok: true } };
  const t = 云.团队.get(b.teamId ?? new URL(`http://x${路径}`).searchParams.get("teamId") ?? "");
  if (!t) return { 状态: 403, json: { error: "你不在这个团队里" } };
  if (!t.active) return { 状态: 402, json: { error: "团队同步还没开通" } };
  if (方法 === "POST" && 路径 === "/api/sync/push") {
    const seq = 云.批.length + 1;
    云.批.push({ seq, team: b.teamId, device: b.device, data: b.data });
    return { 状态: 200, json: { ok: true, seq } };
  }
  const after = Number(new URL(`http://x${路径}`).searchParams.get("after"));
  return { 状态: 200, json: { ok: true, batches: 云.批.filter((x) => x.seq > after), more: false } };
};

/* ---------------- 乙：另一台电脑 ---------------- */
let 乙: PrismaClient;
const 乙设备 = "dYYYYYY";
let 乙拉到 = 0;
async function 乙同步(钥匙: string, teamId: string) {
  const { 改动, 到 } = await 待推(乙, 乙设备);
  if (改动.length) {
    const seq = 云.批.length + 1;
    云.批.push({ seq, team: teamId, device: 乙设备, data: 封(改动, 钥匙) });
    await 记已推(乙, 到);
  }
  for (const b of 云.批.filter((x) => x.seq > 乙拉到)) {
    if (b.device !== 乙设备) await 回放(乙, 拆(b.data, 钥匙), 乙设备);
    乙拉到 = b.seq;
  }
}

const 模板 = [
  { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN" },
  { id: "cmusc55680001dulki71dcsts", email: "zhangsan", name: "张三", role: "SALES" },
];
async function 清空种模板(db: PrismaClient) {
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const u of 模板) await db.user.create({ data: { ...u, password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
}

beforeAll(async () => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: "jia", name: "甲", contact: "jia@x.com", models: [], loggedAt: new Date().toISOString() }));
  设传输(假传输);
  await 清空种模板(甲);
  fs.copyFileSync(path.join(临时.dir, "A.db"), path.join(临时.dir, "B.db"));
  乙 = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "B.db")}` });
});

afterAll(async () => {
  设传输(null);
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  await 甲.$disconnect();
  await 乙.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

describe("桌面端同步客户端", () => {
  it("邀请码：整段才认", () => {
    expect(解邀请码("DT1.team1abc.s3cret.0123456789012345678901234567890123456789abc")).toEqual({ teamId: "team1abc", joinSecret: "s3cret", key: "0123456789012345678901234567890123456789abc" });
    expect(解邀请码("DT1.team1abc.s3cret")).toBeNull();
    expect(解邀请码("随便写的")).toBeNull();
  });

  it("建团队 → 没开通不同步 → 开通后推全量 → 乙加入、双向同步 → 退出后数据还在", async () => {
    // 建团队之前甲已经有客户：进团队时整份带进去
    await 甲.customer.create({ data: { id: "c1", name: "王总", phone: "13800000001", salesOwnerId: 模板[0].id } });
    const r = await 建团队("明亮贸易");
    if (!r.ok) throw new Error(r.error);
    const 码 = 解邀请码(r.邀请码)!;
    expect(码.teamId).toBe("team1xxxxxxx");
    expect(读团队()).toMatchObject({ teamId: 码.teamId, teamName: "明亮贸易", key: 码.key });
    expect((await 甲.user.findMany()).map((u) => u.id)).toEqual(["acct_jia"]); // 改了身份；没用过的张三删了
    expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c1" } })).salesOwnerId).toBe("acct_jia");
    expect(await 装了吗(甲)).toBe(true);
    expect(fs.statSync(path.join(临时.dir, ".team.json")).mode & 0o777).toBe(0o600);
    // 再建一个：拦
    expect((await 建团队("另一个")).ok).toBe(false);

    expect(await 同步一轮()).toEqual({ ok: false, error: "团队同步还没开通" });
    expect(读团队()?.lastError).toBe("团队同步还没开通");
    const 状态 = await 团队状态();
    expect(状态).toMatchObject({ 在团队: true, teamName: "明亮贸易", active: false });

    云.团队.get(码.teamId)!.active = true;
    const 一 = await 同步一轮();
    expect(一.ok && 一.推).toBeGreaterThan(0);

    // 乙进团队（另一台电脑）：改身份、开日志、拉甲的全量，推自己的
    await 改身份(乙, "acct_yi", { email: "yi@x.com", name: "乙" });
    await 建同步表(乙);
    await 装触发器(乙);
    await 记全量(乙);
    await 乙.customer.create({ data: { id: "c2", name: "李总", phone: "13800000002", salesOwnerId: "acct_yi" } });
    await 乙同步(码.key, 码.teamId);
    expect((await 乙.customer.findMany({ orderBy: { id: "asc" } })).map((c) => c.name)).toEqual(["王总", "李总"]);

    const 二 = await 同步一轮();
    expect(二.ok && 二.拉).toBeGreaterThan(0);
    expect((await 甲.customer.findMany({ orderBy: { id: "asc" } })).map((c) => c.name)).toEqual(["王总", "李总"]);
    expect((await 甲.user.findMany({ orderBy: { id: "asc" } })).map((u) => u.id)).toEqual(["acct_jia", "acct_yi"]);

    // 甲改、乙收
    await 甲.customer.update({ where: { id: "c2" }, data: { remark: "甲补了一句" } });
    await 同步一轮();
    await 乙同步(码.key, 码.teamId);
    expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c2" } })).remark).toBe("甲补了一句");
    expect(读团队()).toMatchObject({ lastError: null, last: { 推: 1 } });

    // 有人推了一包钥匙不对的：说清楚是钥匙的事
    云.批.push({ seq: 云.批.length + 1, team: 码.teamId, device: "dZZZZZZ", data: 封([], "A".repeat(43)) });
    const 坏 = await 同步一轮();
    expect(坏.ok).toBe(false);
    expect(!坏.ok && 坏.error).toContain("钥匙不对");
    云.批.pop();

    // 两个人各录了同一位客户：同步后列进疑似重复，不替人合并
    await 乙.customer.create({ data: { id: "c3", name: "王总（乙录的）", phone: "13800000001", salesOwnerId: "acct_yi" } });
    await 乙同步(码.key, 码.teamId);
    await 同步一轮();
    const 重 = await 疑似重复();
    expect(重).toEqual([{ 种类: "客户", 依据: "号码 13800000001", 记录: [expect.objectContaining({ id: "c1", 谁的: "甲" }), expect.objectContaining({ id: "c3", 谁的: "乙" })] }]);

    // 退出：触发器卸了、配置删了、数据还在
    expect((await 退出团队()).ok).toBe(true);
    expect(读团队()).toBeNull();
    expect(await 装了吗(甲)).toBe(false);
    expect(await 甲.customer.count()).toBe(3);
  });
});
