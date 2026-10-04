/**
 * R-067 / R-069（2026-10-04 修复路）：升级上来的老库里，号码存着空格、横杠、全角横杠等写法
 * （A8 之前线索转来只 trim 过的「138 0000 1111」、老实现原样存的「138－0000－1111」）。
 * 原来查重是整串相等，认不出 → 新录、编辑、导入、线索转客户都会建出重复客户。
 *
 * 修法：库里的值和新值都去掉分隔符再比（号键）——只按「去掉分隔符后的整串」相等判，**不做后缀 / 去区号之类的模糊匹配**；
 * 不回填、不改老数据。库那一侧走表达式索引（migrations/021），1 万客户的库也不全表拉进内存。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const mocks = vi.hoisted(() => ({
  user: { id: "u-key", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { saveCustomer, checkDuplicate } from "@/app/(app)/customers/actions";
import { saveLead, convertLead } from "@/app/(app)/leads/actions";
import { 预览导入, 执行导入, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 号键, 规整手机号 } from "@/lib/phone";
import { 号键SQL, 号键索引名, 按号键找SQL, 认人表 } from "@/lib/phone-dedupe";
import { 疑似重复 } from "@/lib/sync/dupes";

const 一天前 = new Date(Date.now() - 86400_000);

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: "u-key", email: "me@local", name: "我", role: "ADMIN", password: "x" } });
  await setSetting("phone.extKeptSince", Date.now() - 3600_000);
});
afterAll(async () => { await prisma.$disconnect(); });

/** 老版本存下来的样子：不经过规整，直接写库 */
const 老客户 = (name: string, phone: string) => prisma.customer.create({ data: { name, phone, salesOwnerId: "u-key", createdAt: 一天前 } });

/** 编辑：把库里这位按表单交回来的样子再存一次 */
const 编辑 = (c: { id: string; name: string; phone: string; remark: string | null; updatedAt: Date }, patch: { phone?: string; remark?: string }) =>
  saveCustomer({
    id: c.id, updatedAt: c.updatedAt.toISOString(), name: c.name, phone: c.phone, school: null, grade: null, major: null, followStatus: "待跟进",
    decisionStatus: "了解中", expectedSignAt: null, remark: c.remark, salesOwnerId: "u-key", channelId: null, referrerCustomerId: null,
    ...patch,
  });

const 新客户 = (phone: string, name = "新来的") =>
  saveCustomer({
    name, phone, school: null, grade: null, major: null, followStatus: "待跟进",
    decisionStatus: "了解中", expectedSignAt: null, remark: null, salesOwnerId: "u-key", channelId: null, referrerCustomerId: null,
  });

function 方案(csv: string, 重复行: 导入方案["重复行"] = "跳过"): 导入方案 {
  const { 表头, 数据 } = 成表(解析CSV(csv));
  return { 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行 };
}

describe("号键：JS 和 SQL 两份算出来一样", () => {
  const 写法们 = [
    "13800001111", "138 0000 1111", "138-0000-1111", "138－0000－1111", "138—0000—1111", "138–0000–1111",
    "(010) 1234 5678", "（010）12345678", "010.1234.5678", "+1 415 555 0132", "＋86 138 0000 1111",
    "１３８００００１１１１", "'13800001111", "138\t0000\t1111", "138　0000　1111", "01012345678转801",
    "13800001111（微信同号）", "",
  ];
  it.each(写法们)("%j", async (s) => {
    const [r] = await prisma.$queryRawUnsafe<{ k: string }[]>(`SELECT ${号键SQL("?")} AS k`, s);
    expect(r.k).toBe(号键(s));
  });
  it("只去分隔符、全角数字换半角，别的字一个不动（不猜）", () => {
    expect(号键("138 0000 1111")).toBe("13800001111");
    expect(号键("138－0000－1111")).toBe("13800001111");
    expect(号键("01012345678转801")).toBe("01012345678转801");
    expect(号键("13800001111（微信同号）")).toBe("13800001111微信同号");
  });
});

describe("索引：1 万客户的库不全表扫", () => {
  it("迁移里建的表达式索引和查询用的是同一个式子", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../migrations/021-customer-phone-key.sql"), "utf8");
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "${号键索引名}" ON "Customer"(${号键SQL('"phone"')});`);
  });
  /*
    10-04 第一版的替换表有 31 项 → 索引是 31 层 replace()。应用自己（Prisma 3.46、Electron/Node 3.50）开得了，
    但 SQLite 3.46 以前的解析栈只吃 29 层：系统自带的 sqlite3（Mac 是 3.45）、常见的库查看工具、降级回去的老版本
    打开整个库都报「malformed database schema … parser stack overflow」。
  */
  it("索引式子最多 20 层 replace()：老 SQLite（3.46 以前只吃 29 层）也打得开这个库", () => {
    expect(号键SQL('"phone"').split("replace(").length - 1).toBeLessThanOrEqual(20);
  });
  it("机器上有 3.46 以前的 sqlite3 命令时：真用它建这个索引、再开库查一次", () => {
    const 版本 = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
    const m = /^(\d+)\.(\d+)/.exec(版本.stdout ?? "");
    if (版本.status !== 0 || !m || Number(m[1]) * 1000 + Number(m[2]) >= 3046) return; // 没有老 sqlite3 就只靠上面那条层数守卫
    const 库 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phonekey-")), "x.db");
    const 建 = spawnSync("sqlite3", [库, `CREATE TABLE "Customer"("phone" TEXT); ${fs.readFileSync(path.resolve(__dirname, "../migrations/021-customer-phone-key.sql"), "utf8")}`], { encoding: "utf8" });
    expect(建.stderr).toBe("");
    const 读 = spawnSync("sqlite3", [库, "SELECT count(*) FROM sqlite_master WHERE type = 'index'"], { encoding: "utf8" });
    expect(读.stderr).toBe("");
    expect(读.stdout.trim()).toBe("1");
  });
  it("查重那句的查询计划走这个索引", async () => {
    const 计划 = await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${按号键找SQL(2)}`, "13800001111", "13900002222");
    expect(计划.map((x) => x.detail).join(" | ")).toContain(号键索引名);
  });
});

describe("R-069 老库里只 trim 过的「138 0000 1111」", () => {
  beforeEach(async () => { await 老客户("老王", "138 0000 1111"); });

  it("表单查重认得出", async () => {
    expect((await checkDuplicate("13800001111"))?.name).toBe("老王");
    expect((await checkDuplicate("138-0000-1111"))?.name).toBe("老王");
  });
  it("新录保存挡下，不建第二份", async () => {
    const r = await 新客户("13800001111");
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("已存在（老王）") });
    expect(await prisma.customer.count()).toBe(1);
  });
  it("编辑另一位客户、把号码改成老王的号：挡下", async () => {
    const 别人 = await 新客户("13900009999", "老李");
    if (!别人.ok) throw new Error(别人.error);
    const 李 = await prisma.customer.findUniqueOrThrow({ where: { id: 别人.id } });
    const r = await 编辑(李, { phone: "13800001111" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("已存在（老王）") });
  });
  it("线索转客户挡下", async () => {
    await saveLead({ name: "海川", contact: "王总", phone: "138 0000 1111", source: "微信", status: "待跟进" });
    const l = await prisma.lead.findFirstOrThrow();
    expect(await convertLead(l.id)).toMatchObject({ ok: false, error: expect.stringContaining("老王") });
    expect(await prisma.customer.count()).toBe(1);
  });
  it("导入：预览算「已在库里」，执行不新建", async () => {
    const csv = "姓名,手机号\n老王,13800001111\n新人,13900002222";
    const p = await 预览导入(方案(csv));
    if (!p.ok) throw new Error(p.error);
    expect([p.预览.新建, p.预览.已在库里]).toEqual([1, 1]);
    const w = await 执行导入(方案(csv), "x.csv");
    if (!w.ok) throw new Error(w.error);
    expect([w.新建, w.跳过]).toEqual([1, 1]);
    expect(await prisma.customer.count()).toBe(2);
  });
  it("导入补空：补进老王那张档案，老号码原样不动（不回填）", async () => {
    const w = await 执行导入(方案("姓名,手机号,备注\n老王,138-0000-1111,补一句", "补空"), "x.csv");
    if (!w.ok) throw new Error(w.error);
    expect(w.补空).toBe(1);
    const 王 = await prisma.customer.findFirstOrThrow();
    expect([王.phone, 王.remark]).toEqual(["138 0000 1111", "补一句"]);
  });
  it("编辑老王只改备注：号码原样没动，不因为库里另有同号的老档案被挡（老库里已经重了的两份照样能改）", async () => {
    await 老客户("老王（重的）", "13800001111");
    const 王 = await prisma.customer.findFirstOrThrow({ where: { name: "老王" } });
    const r = await 编辑(王, { remark: "改一下" });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });
  it("团队同步后的疑似重复：「138 0000 1111」和「13800001111」算一组", async () => {
    await 老客户("同步来的王", "13800001111");
    const 组 = (await 疑似重复()).filter((g) => g.种类 === "客户");
    expect(组.map((g) => g.记录.map((r) => r.name).sort())).toEqual([["同步来的王", "老王"]]);
  });
});

describe("R-067 老实现原样存的全角横杠「138－0000－1111」", () => {
  it("新版本再导同一格：认得出，不再建一份", async () => {
    await 老客户("老张", "138－0000－1111");
    const w = await 执行导入(方案("姓名,手机号\n老张,138－0000－1111"), "x.csv");
    if (!w.ok) throw new Error(w.error);
    expect([w.新建, w.跳过]).toEqual([0, 1]);
    expect((await checkDuplicate("13800001111"))?.name).toBe("老张");
  });
});

describe("不模糊：别把不同的号认成一个人", () => {
  it("老实现丢了区号存的「12345678」不认作「010-12345678」（同号不同城的座机）", async () => {
    await 老客户("某地座机", "12345678");
    expect(await checkDuplicate("010-12345678")).toBeNull();
  });
  it("多一位、少一位、后缀相同都不算", async () => {
    await 老客户("老王", "138 0000 1111");
    for (const p of ["1380000111", "13800001112", "0013800001111"]) expect(await checkDuplicate(p), p).toBeNull();
  });
  it("老库里号码后面带字的（「13800001111（微信同号）」）不猜，照旧认不出", async () => {
    await 老客户("带字", "13800001111（微信同号）");
    expect(await checkDuplicate("13800001111")).toBeNull();
  });
  it("带分机的认老主号那条规矩照旧：只认分机开始留着之前建的，老主号写法带空格也认", async () => {
    await 老客户("老总机", "010 1234 5678");
    expect((await checkDuplicate("010-12345678 转 801"))?.name).toBe("老总机");
    expect(规整手机号("010-12345678 转 801")).toBe("01012345678转801");
  });
  it("导入认人表按号键认：老库里「010 1234 5678」，表里带分机的那一行认到他", () => {
    const 起 = new Date();
    const 表 = 认人表([{ phone: "010 1234 5678", createdAt: 一天前 }], ["01012345678转801"], 起);
    expect(表.认("01012345678转801").n).toBe(1);
  });
});
