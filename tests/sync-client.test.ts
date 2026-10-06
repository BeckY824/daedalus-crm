/**
 * 团队同步 · 桌面端这一头（lib/sync/client.ts，2026-10-03）。
 * 甲：走真实的客户端代码（建团队、同步一轮、退出）；乙：另一份库，直接用本机那一半的函数模拟另一台电脑；
 * 云端：一个内存里的假中转（规矩和 lib/tenant/sync-relay.ts 一样：未开通不收、按序号推拉）。
 * 甲用的库是拷出来的一份（vi.mock 换掉 @/lib/prisma），触发器碰不到共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  // vi.hoisted 比 import 先跑，拿不到上面导入的模块：用 Node 自带的取法
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-sync-client-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  // test.db 的 -wal 里可能还有没落盘的：一起拷，库才是一份自洽的
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}` }) };
});

import { PrismaClient } from "@/generated/prisma";
import { prisma as 甲 } from "@/lib/prisma";
import { 建团队, 同步一轮, 推一下, 退出团队, 读团队, 设传输, 解邀请码, 团队状态, type 传输 } from "@/lib/sync/client";
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放, 装了吗, type 改动 } from "@/lib/sync/local";
import { 封, 拆 } from "@/lib/sync/crypto";
import { 疑似重复 } from "@/lib/sync/dupes";
import { getBusiness } from "@/lib/business";

/* ---------------- 假中转 ---------------- */
const 云 = { 团队: new Map<string, { name: string; secret: string; active: boolean; 人: Set<string> }>(), 批: [] as { seq: number; team: string; device: string; data: string }[] };
const 当前账号 = "jia";
/** 在某个请求上卡一下（慢网络 / 云端回话慢）：用来造「同步一轮」和「退出团队」撞在一起（2026-10-04 T-009） */
/** 假中转名单里的老板账号；null = 就是当前账号 */
let 名单老板: string | null = null;
/** 假中转一页给几批（E.3 造「重拉到一半断了」用）；默认一次全给 */
let 每页 = Infinity;
afterEach(() => {
  名单老板 = null;
  每页 = Infinity;
});
let 钩子: ((方法: string, 路径: string) => Promise<void>) | null = null;
const 假传输: 传输 = async (方法, 路径, body) => {
  if (钩子) await 钩子(方法, 路径);
  const b = (body ?? {}) as Record<string, string>;
  if (方法 === "POST" && 路径 === "/api/sync/team") {
    const id = `team${云.团队.size + 1}xxxxxxx`;
    云.团队.set(id, { name: b.name, secret: "s3cret", active: false, 人: new Set([当前账号]) });
    return { 状态: 200, json: { ok: true, teamId: id, joinSecret: "s3cret" } };
  }
  if (方法 === "GET" && 路径 === "/api/sync/team") {
    // 名单里的老板：默认就是我（建团队的人）；当业务员() 把它换成乙（T-041 之后退出时按名单判谁是老板）
    const 老板 = 名单老板 ?? 当前账号;
    return { 状态: 200, json: { ok: true, teams: [...云.团队].filter(([, t]) => t.人.has(当前账号)).map(([id, t]) => ({ id, name: t.name, active: t.active, 我是建的人: 老板 === 当前账号, 成员: [...new Set([...t.人, 老板])].map((a) => ({ accountId: a, name: a, contact: `${a}@x.com`, role: a === 老板 ? "owner" : "member" })) })) } };
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
  const 剩下 = 云.批.filter((x) => x.seq > after);
  return { 状态: 200, json: { ok: true, batches: 剩下.slice(0, 每页), more: 剩下.length > 每页 } };
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
    if (b.device !== 乙设备) await 回放(乙, 拆(b.data, 钥匙, { teamId, device: b.device }), 乙设备);
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
  // 乙另拷一份再自己清：从甲的库文件拷会拷到还没落盘（还在 -wal 里）的旧数据，全量跑时偶发多出别的用例留下的行
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(临时.dir, "B.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(临时.dir, "B.db-wal"));
  乙 = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "B.db")}` });
  await 清空种模板(乙);
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
    // Windows 没有 Unix 权限位（读出来恒为 0o666），那边靠用户目录的 ACL
    if (process.platform !== "win32") expect(fs.statSync(path.join(临时.dir, ".team.json")).mode & 0o777).toBe(0o600);
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
    const 人 = await 甲.user.findMany({ orderBy: { id: "asc" } });
    expect(人.map((u) => u.id), JSON.stringify(人.map((u) => [u.id, u.email, u.name, u.role]))).toEqual(["acct_jia", "acct_yi"]);

    // 甲改、乙收
    await 甲.customer.update({ where: { id: "c2" }, data: { remark: "甲补了一句" } });
    await 同步一轮();
    await 乙同步(码.key, 码.teamId);
    expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c2" } })).remark).toBe("甲补了一句");
    expect(读团队()).toMatchObject({ lastError: null, last: { 推: 1 } });

    // T-056：.team.json 里有团队钥匙。被谁改成 0644（备份软件还原、手动拷来拷去）之后，下一次写回要收紧回 0600；
    // 先写临时文件再改名，目录里不许留下 .tmp
    fs.chmodSync(path.join(临时.dir, ".team.json"), 0o644);
    await 同步一轮();
    if (process.platform !== "win32") expect(fs.statSync(path.join(临时.dir, ".team.json")).mode & 0o777, ".team.json 写回后要回到 0600").toBe(0o600);
    expect(fs.readdirSync(临时.dir).filter((f) => f.startsWith(".team.json") && f !== ".team.json"), "不许留下写到一半的临时文件").toEqual([]);

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

    // T-003 合不了的撞车（两人各把一条线索挂到同一位客户上）：不静默，设置 → 团队里数得出「没同步上」
    expect(await 团队状态()).toMatchObject({ 没同步上: { 条数: 0 } });
    await 甲.lead.create({ data: { id: "lj", name: "甲的线索", customerId: "c1", ownerId: "acct_jia" } });
    await 乙.lead.create({ data: { id: "ly", name: "乙的线索", customerId: "c1", ownerId: "acct_yi" } });
    await 同步一轮();
    await 乙同步(码.key, 码.teamId);
    await 同步一轮();
    expect(await 团队状态()).toMatchObject({ 没同步上: { 条数: 1, 例子: [expect.objectContaining({ 表: "线索" })] } });

    // 退出：触发器卸了、配置删了、数据还在
    expect((await 退出团队()).ok).toBe(true);
    expect(读团队()).toBeNull();
    expect(await 装了吗(甲)).toBe(false);
    expect(await 甲.customer.count()).toBe(3);
  });

  /* ---------- 下面三条各自建一个新团队（上面那条最后退出了），用完退出 ---------- */
  const 睡 = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const 钟 = (毫秒: number) => `${String(毫秒).padStart(15, "0")}-${乙设备}`;
  /** 乙那台推一批（直接塞进假中转），钟拨到一分钟后：比甲记全量时的字段钟都新 */
  const 乙推 = (teamId: string, 钥匙: string, 批: 改动[]) => 云.批.push({ seq: 云.批.length + 1, team: teamId, device: 乙设备, data: 封(批, 钥匙, 0, { teamId, device: 乙设备 }) });
  const 乙的新客户 = (id: string): 改动 => {
    const 时 = new Date().toISOString();
    return { t: "Customer", k: id, o: "I", r: { id, name: `乙的客户${id}`, phone: `139${String(Date.now()).slice(-8)}`, salesOwnerId: "acct_yi", followStatus: "待跟进", decisionStatus: "了解中", createdAt: 时, updatedAt: 时 }, c: ["id", "name", "phone", "salesOwnerId", "followStatus", "decisionStatus", "createdAt", "updatedAt"], h: 钟(Date.now() + 60_000) };
  };
  async function 新团队(名: string) {
    if (读团队()) await 退出团队(); // 上一条中途红了没退：先退，别连累后面几条
    云.批.length = 0; // 假中转的拉取不分团队：清掉上一个团队的批次
    const t = await 建团队(名);
    if (!t.ok) throw new Error(t.error);
    const 码 = 解邀请码(t.邀请码)!;
    云.团队.get(码.teamId)!.active = true;
    expect(await 同步一轮()).toMatchObject({ ok: true });
    return 码;
  }
  /** 甲当业务员：退出时走「只留自己的」，别人的客户留在这台上就看得出来 */
  /*
    把这台当成业务员（T-041 之后要三件事都对上才算：本机角色 SALES、手上没有建团队的签名私钥、云端名单里老板是别人）。
    只改本机 role 已经不够——那正是 T-041 要堵的「判错就删老板的数据」
  */
  const 当业务员 = async () => {
    await 甲.$executeRawUnsafe(`UPDATE "User" SET role = 'SALES' WHERE id = 'acct_jia'`);
    const f = path.join(process.env.CRM_DATA_DIR!, ".team.json");
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    delete c.signPriv;
    fs.writeFileSync(f, JSON.stringify(c));
    名单老板 = "yi";
  };

  it("T-042 乙推了业务配置改动：甲同步一轮之后 getBusiness() 就是新的（收到改动清了设置缓存）", async () => {
    const 码 = await 新团队("四队");
    const 前 = await getBusiness(); // 进程里缓存上一份
    expect(前.customer).not.toBe("学员");
    const 时 = new Date().toISOString();
    乙推(码.teamId, 码.key, [{ t: "Setting", k: "business", o: "U", r: { key: "business", value: JSON.stringify({ ...前, customer: "学员" }), updatedAt: 时 }, c: ["key", "value", "updatedAt"], h: 钟(Date.now() + 60_000) }]);
    const r = await 同步一轮();
    expect(r.ok && r.拉).toBeGreaterThan(0);
    expect((await getBusiness()).customer).toBe("学员");
    expect((await 退出团队()).ok).toBe(true);
  });

  /*
    2026-10-04 多台实测脚本抓到：「改完 1.5 秒就推」到点时上一轮还没跑完，原来直接复用那一轮——它的推送早过去了，
    这次的改动要等壳下一次戳（8 秒）甚至更久。现在 推一下() 记「欠一轮」，那一轮一结束就补一轮
  */
  it("一轮正跑着时到点推一下：那一轮结束马上补一轮，新写的这条推得出去", async () => {
    const 码 = await 新团队("五队");
    let 放行!: () => void;
    const 闸 = new Promise<void>((r) => (放行 = r));
    let 拉了几次 = 0;
    钩子 = async (_方法, 路径) => {
      if (路径.startsWith("/api/sync/pull")) {
        拉了几次 += 1;
        if (拉了几次 === 1) await 闸;
      }
    };
    try {
      const 轮 = 同步一轮();
      while (拉了几次 === 0) await 睡(10); // 第一轮推完、卡在拉上
      await 甲.customer.create({ data: { id: "c补推", name: "补推的客户", phone: "13800009998", salesOwnerId: "acct_jia" } });
      void 推一下();
      放行();
      await 轮;
      for (let i = 0; i < 100 && 拉了几次 < 2; i++) await 睡(20);
      expect(拉了几次, "那一轮结束后没有补一轮").toBe(2);
      const 推上去的 = 云.批.filter((b) => b.team === 码.teamId).map((b) => b.data).join("");
      expect(推上去的.length).toBeGreaterThan(0);
    } finally {
      钩子 = null;
      放行();
    }
    while (await 同步一轮().then((r) => r.ok && r.推 > 0)) { /* 补完的那一轮也跑干净 */ }
    expect((await 退出团队()).ok).toBe(true);
  });

  /*
    2026-10-04 多台实测脚本：User.role 不同步，远端插进来的同事那一行带着对方库里的角色（或默认值），
    原来要等每 5 分钟那次对名单——业务员那台上老板一直显示成业务员。现在这一轮拉进新同事的账号行就马上对
  */
  it("这一轮拉进来一位新同事：这一轮结束他的角色就按名单对上，不等 5 分钟", async () => {
    const 码 = await 新团队("六队");
    乙推(码.teamId, 码.key, [乙的新客户("cR1")]);
    expect(await 同步一轮()).toMatchObject({ ok: true }); // 这一轮对过一次角色，5 分钟内不会再按时间对
    const 时 = new Date().toISOString();
    云.团队.get(码.teamId)!.人.add("bing");
    名单老板 = "bing"; // 名单里丙是老板：他那一行进来时是默认的 SALES（角色不同步），要马上对成 ADMIN
    乙推(码.teamId, 码.key, [{ t: "User", k: "acct_bing", o: "I", r: { id: "acct_bing", email: "bing@x.com", name: "丙", title: "", role: "SALES", active: true, password: "x", createdAt: 时, updatedAt: 时 }, c: ["id", "email", "name", "title", "role", "active", "password", "createdAt", "updatedAt"], h: 钟(Date.now() + 60_000) }]);
    expect(await 同步一轮()).toMatchObject({ ok: true });
    const 丙 = await 甲.user.findUnique({ where: { id: "acct_bing" }, select: { role: true } });
    expect(丙?.role, "名单里丙是老板，这一轮结束就该是 ADMIN，不等 5 分钟").toBe("ADMIN");
    expect((await 退出团队()).ok).toBe(true);
  });

  it("E.3 升级后从头重拉，拉到一半断网：下一轮从断点接着拉，不从 0 重来，也不多出重复的客户", async () => {
    const 码 = await 新团队("断点队");
    for (const id of ["cP1", "cP2", "cP3"]) 乙推(码.teamId, 码.key, [乙的新客户(id)]);
    expect((await 同步一轮()).ok).toBe(true);
    const 客户数 = await 甲.customer.count();
    // 假装刚升级过：签名对不上 → 这一轮从头重拉。一页 2 批，拉第 2 页时断网
    fs.writeFileSync(path.join(临时.dir, ".team.json"), JSON.stringify({ ...读团队(), 结构: "旧版本的签名" }), { mode: 0o600 });
    每页 = 2;
    const 从哪拉: number[] = [];
    钩子 = async (_方法, 路径) => {
      if (!路径.startsWith("/api/sync/pull")) return;
      从哪拉.push(Number(new URL(`http://x${路径}`).searchParams.get("after")));
      if (从哪拉.length === 2) throw new Error("fetch failed");
    };
    try {
      expect((await 同步一轮()).ok).toBe(false);
    } finally {
      钩子 = null;
    }
    expect(从哪拉[0], "签名变了就从头拉").toBe(0);
    const 断点 = 读团队()!.pulled;
    expect(断点, "第一页拉完要记下进度").toBe(从哪拉[1]);
    expect(断点).toBeGreaterThan(0);
    // 下一轮：签名已经记成新的，从断点接着拉
    从哪拉.length = 0;
    钩子 = async (_方法, 路径) => {
      if (路径.startsWith("/api/sync/pull")) 从哪拉.push(Number(new URL(`http://x${路径}`).searchParams.get("after")));
    };
    try {
      expect((await 同步一轮()).ok).toBe(true);
    } finally {
      钩子 = null;
    }
    expect(从哪拉[0], "接着断点拉，不是从 0").toBe(断点);
    expect(await 甲.customer.count()).toBe(客户数);
    expect(读团队()!.pulled).toBe(云.批.at(-1)!.seq);
    expect(await 甲.customer.count({ where: { id: { in: ["cP1", "cP2", "cP3"] } } })).toBe(3);
    expect((await 退出团队()).ok).toBe(true);
  });

  it("T-009 同步一轮跑到一半点退出：等这一轮跑完再退；退完没有 .team.json、触发器已卸、业务员只留自己的", async () => {
    const 码 = await 新团队("二队");
    await 当业务员();
    乙推(码.teamId, 码.key, [乙的新客户("cY1")]);
    let 放行!: () => void;
    const 闸 = new Promise<void>((r) => (放行 = r));
    let 到了!: () => void;
    const 拉到了 = new Promise<void>((r) => (到了 = r));
    钩子 = async (_方法, 路径) => {
      if (路径.startsWith("/api/sync/pull")) {
        到了();
        await 闸;
      }
    };
    try {
      const 轮 = 同步一轮();
      await 拉到了;
      const 退 = 退出团队();
      // 这一轮还卡在拉取上：退出要等它，不能先把触发器卸了、配置删了
      expect(await Promise.race([退.then(() => "退完了"), 睡(300).then(() => "还在等")])).toBe("还在等");
      放行();
      expect(await 轮).toMatchObject({ ok: true });
      expect((await 退).ok).toBe(true);
    } finally {
      钩子 = null;
      放行();
    }
    expect(读团队()).toBeNull();
    expect(await 装了吗(甲)).toBe(false);
    // 那一轮回放进来的乙的客户，退出时「只留自己的」删掉了（先退后回放的话会留下）
    expect(await 甲.customer.count({ where: { id: "cY1" } })).toBe(0);
  });

  it("T-009 退出团队正等云端回话，壳又戳了一轮：不开新的一轮，退完之后不会再回放别人的客户、写回 .team.json", async () => {
    const 码 = await 新团队("三队");
    await 当业务员();
    乙推(码.teamId, 码.key, [乙的新客户("cY2")]);
    let 放行!: () => void;
    const 闸 = new Promise<void>((r) => (放行 = r));
    let 退: Promise<unknown> = Promise.resolve();
    钩子 = async (_方法, 路径) => {
      if (路径 === "/api/sync/leave") await 闸;
      // 真开了新的一轮的话：让它拉到的这一批等退完再回放（最坏的那种先后）；最多等 2 秒，免得修法不同时卡死
      if (路径.startsWith("/api/sync/pull")) await Promise.race([退, 睡(2000)]);
    };
    try {
      退 = 退出团队();
      await 睡(10);
      const 轮 = 同步一轮();
      放行();
      const 这轮 = await 轮;
      await 退;
      expect(这轮.ok).toBe(false);
    } finally {
      钩子 = null;
      放行();
    }
    expect(读团队()).toBeNull();
    expect(await 装了吗(甲)).toBe(false);
    expect(await 甲.customer.count({ where: { id: "cY2" } })).toBe(0);
  });

  it("T-009 一轮跑着的时候本机换了团队（.team.json 的 teamId 变了）：这一轮跑完不把旧团队的位置、出错写回去", async () => {
    const 码 = await 新团队("五队");
    乙推(码.teamId, 码.key, [乙的新客户("cY3")]);
    let 放行!: () => void;
    const 闸 = new Promise<void>((r) => (放行 = r));
    let 到了!: () => void;
    const 拉到了 = new Promise<void>((r) => (到了 = r));
    钩子 = async (_方法, 路径) => {
      if (路径.startsWith("/api/sync/pull")) {
        到了();
        await 闸;
      }
    };
    const 文件 = path.join(临时.dir, ".team.json");
    const 原 = 读团队()!;
    try {
      const 轮 = 同步一轮();
      await 拉到了;
      // 模拟这期间退出又进了另一个团队：配置换成别的团队的
      fs.writeFileSync(文件, JSON.stringify({ ...原, teamId: "teamOTHERxxxx", pulled: 0, lastSyncAt: undefined, last: undefined }), { mode: 0o600 });
      放行();
      await 轮;
    } finally {
      钩子 = null;
      放行();
    }
    const 现 = 读团队()!;
    expect(现.teamId).toBe("teamOTHERxxxx");
    expect(现.pulled).toBe(0);
    expect(现.last).toBeUndefined();
    // 收拾：换回本队再退出
    fs.writeFileSync(文件, JSON.stringify(原), { mode: 0o600 });
    expect((await 退出团队()).ok).toBe(true);
  });
});
