/**
 * R2 · 升级路径：老版本装出来的本机库，被当前 desktop/server-entry.js 原样跑一遍。
 *
 * 做法（不碰 Electron、不起 Next）：
 *   1. 老库 = 那个 tag 的 prisma/schema.prisma 经 `prisma migrate diff --from-empty` 建表
 *      + 那个 tag 的 migrations/（和当年 build-template 的做法一致），再塞样例同事张三李四和他们名下的客户 / 跟进 / 计划 / 待办
 *   2. 拼一个假的 server-bundle：entry.js = desktop/server-entry.js 原文件，migrations/ = 当前的，
 *      server.js = 一个只打印一行就退出的桩（真的 Next 不起）
 *   3. 用 node 跑 entry.js（Electron 38 里 node:sqlite 不要 flag，Node 22+ 同理），跑两遍
 *   4. 查：退出码、老数据一行不少一格不变、张三李四还在、管理员对上云端账号、
 *      和当前 schema 比没有缺表缺列（prisma migrate diff）、当前 Prisma 客户端每个模型都查得动
 *   5. 故障注入：库被别的连接锁着、迁移中途「磁盘满」（预加载一个模块把 exec 换成会抛的）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
/** node:sqlite 运行时认 { readOnly }，这版 @types/node 的构造函数只写了一个参数 */
const 只读库 = (f: string) =>
  new (DatabaseSync as unknown as new (f: string, o: { readOnly: boolean }) => InstanceType<typeof DatabaseSync>)(f, { readOnly: true });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const PRISMA = path.join(ROOT, "node_modules/prisma/build/index.js");
const 工作区 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-upgrade-"));
afterAll(() => fs.rmSync(工作区, { recursive: true, force: true }));

const 要测的老版本 = ["v0.14.0", "v0.30.0", "v0.37.0", "v0.39.2", "v0.40.0", "v0.46.0", "v0.46.14"];
const 老版本们 = 要测的老版本.filter((t) => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${t}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

// 2026-10-04：上面那道过滤原来会把缺的 tag 悄悄扔掉——CI 的 actions/checkout 默认浅检出、不拉 tag，
// 这一整组在 CI 上很可能一个老版本都没测，却一直是绿的。缺了就报红，让人去补 fetch-depth: 0 / git fetch --tags
it("要测的老版本 tag 一个都不能少（缺了说明检出没拉 tag，升级测试会悄悄变空）", () => {
  expect(要测的老版本.filter((t) => !老版本们.includes(t))).toEqual([]);
});

function 建表SQL(schema文件: string) {
  return execFileSync(process.execPath, [PRISMA, "migrate", "diff", "--from-empty", "--to-schema-datamodel", schema文件, "--script"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const 可忽略 = (e: unknown) => /duplicate column name|already exists/i.test(String((e as Error)?.message));

/* ---------- 假 server-bundle ---------- */
const 包 = path.join(工作区, "bundle");
const 注入 = path.join(工作区, "inject.cjs");
beforeAll(() => {
  fs.mkdirSync(path.join(包, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "desktop/server-entry.js"), path.join(包, "entry.js"));
  for (const f of fs.readdirSync(path.join(ROOT, "migrations"))) fs.copyFileSync(path.join(ROOT, "migrations", f), path.join(包, "migrations", f));
  fs.writeFileSync(path.join(包, "server.js"), 'console.log("[stub] Next 起来了");\n');
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(包, "node_modules"));
  // 模板库：当前 schema + 迁移 + 三个账号（desktop/scripts/build-server.mjs 第 4 步的做法）
  const 模板 = new DatabaseSync(path.join(包, "template.db"));
  模板.exec(建表SQL(path.join(ROOT, "prisma/schema.prisma")));
  for (const f of fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      模板.exec(fs.readFileSync(path.join(ROOT, "migrations", f), "utf8"));
    } catch (e) {
      if (!可忽略(e)) throw e;
    }
  }
  塞人(模板);
  模板.close();
  /*
    故障注入：把 DatabaseSync.prototype.exec 换掉。
      R2_FAIL_MATCH  SQL 里含这一段就出事
      R2_FAIL_MODE   whole = 一句都不执行就抛；partial = 执行第一句再抛（多语句文件写了一半）
      R2_FAIL_MSG    抛什么（默认 SQLITE_FULL 的原文）
  */
  fs.writeFileSync(
    注入,
    `const s = require("node:sqlite");
const 原 = s.DatabaseSync.prototype.exec;
s.DatabaseSync.prototype.exec = function (sql) {
  const m = process.env.R2_FAIL_MATCH;
  if (m && String(sql).includes(m)) {
    if (process.env.R2_FAIL_MODE === "partial") {
      const 第一句 = String(sql).split(/;\\s*\\n/)[0] + ";";
      原.call(this, 第一句);
    }
    const e = new Error(process.env.R2_FAIL_MSG || "database or disk is full");
    e.code = "ERR_SQLITE_ERROR";
    throw e;
  }
  return 原.call(this, sql);
};
`,
  );
}, 60_000);

/* ---------- 造人造数据：按那个版本的列来填，不认识的必填列给个合理的值 ---------- */
type 行 = Record<string, unknown>;
function 列(db: DatabaseSync, 表: string) {
  return db.prepare(`PRAGMA table_info("${表}")`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
}
function 插(db: DatabaseSync, 表: string, 给的: 行) {
  const cols = 列(db, 表);
  if (!cols.length) return false;
  const v: 行 = {};
  for (const c of cols) {
    if (c.name in 给的) v[c.name] = 给的[c.name];
    else if (c.notnull && c.dflt_value == null) {
      const t = c.type.toUpperCase();
      v[c.name] = t.includes("DATE") ? Date.now() : t.includes("INT") || t.includes("REAL") || t.includes("BOOL") || t.includes("DECIMAL") ? 0 : "x";
    }
  }
  const ks = Object.keys(v).filter((k) => cols.some((c) => c.name === k));
  db.prepare(`INSERT INTO "${表}" (${ks.map((k) => `"${k}"`).join(",")}) VALUES (${ks.map(() => "?").join(",")})`).run(...(ks.map((k) => v[k]) as never[]));
  return true;
}
function 塞人(db: DatabaseSync) {
  const t0 = Date.now() - 86_400_000;
  插(db, "User", { id: "u_admin", email: "admin", name: "管理员", title: "系统管理员", role: "ADMIN", password: "x", active: 1, createdAt: t0 });
  插(db, "User", { id: "u_zs", email: "zhangsan", name: "张三", title: "销售", role: "SALES", password: "x", active: 1, createdAt: t0 + 1 });
  插(db, "User", { id: "u_ls", email: "lisi", name: "李四", title: "销售", role: "SALES", password: "x", active: 1, createdAt: t0 + 2 });
}
function 塞业务数据(db: DatabaseSync) {
  const 现在 = Date.now();
  插(db, "Customer", { id: "c_zs", name: "王总（张三的）", phone: "13800000001", salesOwnerId: "u_zs", createdAt: 现在, updatedAt: 现在 });
  插(db, "Customer", { id: "c_ls", name: "赵姐（李四的）", phone: "13800000002", salesOwnerId: "u_ls", createdAt: 现在, updatedAt: 现在 });
  插(db, "Customer", { id: "c_me", name: "刘总（我的）", phone: "13800000003", salesOwnerId: "u_admin", createdAt: 现在, updatedAt: 现在 });
  插(db, "FollowUp", { id: "f1", type: "PHONE", content: "张三打过电话", status: "已完成", occurredAt: 现在, customerId: "c_zs", ownerId: "u_zs", createdAt: 现在, updatedAt: 现在 });
  插(db, "FollowPlan", { id: "p1", subject: "回访", plannedAt: 现在 + 3_600_000, method: "电话", customerId: "c_zs", ownerId: "u_zs", done: 0, createdAt: 现在, updatedAt: 现在 });
  插(db, "Task", { id: "t1", title: "寄资料", dueAt: 现在, customerId: "c_ls", ownerId: "u_ls", done: 0, createdAt: 现在, updatedAt: 现在 });
  插(db, "Setting", { key: "business", value: JSON.stringify({ 预设: "教培" }), updatedAt: 现在 });
}

/** 老库：那个 tag 的 schema + 那个 tag 的 migrations + 人 + 数据，WAL（Prisma 一连上就切 WAL） */
function 造老库(tag: string, 名 = tag) {
  const d = path.join(工作区, 名);
  fs.mkdirSync(d, { recursive: true });
  const schema = path.join(d, "schema.prisma");
  fs.writeFileSync(schema, execFileSync("git", ["show", `${tag}:prisma/schema.prisma`], { cwd: ROOT }));
  const db = new DatabaseSync(path.join(d, "crm.db"));
  db.exec(建表SQL(schema));
  const 老迁移 = execFileSync("git", ["ls-tree", "--name-only", tag, "migrations/"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of 老迁移) {
    try {
      db.exec(execFileSync("git", ["show", `${tag}:${f}`], { cwd: ROOT, encoding: "utf8" }));
    } catch (e) {
      if (!可忽略(e)) throw e;
    }
  }
  塞人(db);
  塞业务数据(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ baseUrl: "http://cloud.test", token: "t", accountId: "acc_me", name: "我自己", contact: "Me@X.com", models: [] }));
  return d;
}

/** 整库快照：每张表按 rowid 排好的全部行 */
function 快照(file: string) {
  const db = 只读库(file);
  const 表 = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const out: Record<string, 行[]> = {};
  for (const t of 表) out[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as 行[];
  db.close();
  return out;
}

function 跑入口(数据目录: string, 额外: Record<string, string> = {}, 预加载 = false): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const args = [...(预加载 ? ["-r", 注入] : []), "--no-warnings", path.join(包, "entry.js")];
    const p = spawn(process.execPath, args, { cwd: 包, env: { ...process.env, CRM_DATA_DIR: 数据目录, ...额外 } });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function 缺的(数据库: string) {
  const diff = execFileSync(process.execPath, [PRISMA, "migrate", "diff", "--from-url", `file:${数据库}`, "--to-schema-datamodel", path.join(ROOT, "prisma/schema.prisma"), "--script"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // RedefineTables（只差外键的 ON UPDATE / 默认值写法）不算缺；缺表、缺列、缺索引才算
  const ls = diff.split("\n");
  return ls.flatMap((l, i) => (/^-- (CreateTable|AlterTable|CreateIndex|DropIndex|DropTable)/.test(l) ? [`${l} ${ls[i + 1] ?? ""}`] : []));
}

/* ------------------------------------------------------------------ */

describe.each(老版本们)("从 %s 升级上来", (tag) => {
  let 目录: string;
  let 升级前: Record<string, 行[]>;
  beforeAll(() => {
    目录 = 造老库(tag);
    升级前 = 快照(path.join(目录, "crm.db"));
  }, 60_000);

  it("server-entry 跑得通、跑两遍也通（幂等）", async () => {
    const 一 = await 跑入口(目录);
    expect(一.out).toContain("[stub] Next 起来了");
    expect(一.code).toBe(0);
    const 二 = await 跑入口(目录);
    expect(二.code).toBe(0);
    expect(二.out).not.toMatch(/迁移 .* 失败/);
  }, 30_000);

  it("老数据一行不少、老列一格不变（管理员那一行除外：对上了云端账号）", () => {
    const 之后 = 快照(path.join(目录, "crm.db"));
    // entry 会新记一条 desktop.syncedName（人改过名字没有的账），那一行不算老数据
    之后.Setting = (之后.Setting ?? []).filter((r) => r.key !== "desktop.syncedName");
    for (const [表, 老行] of Object.entries(升级前)) {
      expect(之后[表], `${表} 不见了`).toBeDefined();
      expect(之后[表].length, `${表} 行数`).toBe(老行.length);
      老行.forEach((r, i) => {
        if (表 === "User" && r.id === "u_admin") return;
        if (表 === "Setting" && r.key === "desktop.syncedName") return;
        for (const [k, v] of Object.entries(r)) expect(之后[表][i][k], `${表}#${i}.${k}`).toEqual(v);
      });
    }
  });

  it("样例同事张三李四和他们名下的客户都还在（老库不删，删了就是删别人的数据）", () => {
    const db = 只读库(path.join(目录, "crm.db"));
    const 人 = db.prepare("SELECT email, name FROM User ORDER BY createdAt").all();
    expect(人.map((r) => (r as 行).email)).toEqual(["me@x.com", "zhangsan", "lisi"]);
    expect(db.prepare("SELECT salesOwnerId FROM Customer WHERE id='c_zs'").get()).toEqual({ salesOwnerId: "u_zs" });
    expect(db.prepare("SELECT count(*) n FROM FollowPlan WHERE ownerId='u_zs'").get()).toEqual({ n: 1 });
    db.close();
  });

  it("管理员对上了云端账号（邮箱小写、名字取云端的）", () => {
    const db = 只读库(path.join(目录, "crm.db"));
    expect(db.prepare("SELECT email, name FROM User WHERE id='u_admin'").get()).toEqual({ email: "me@x.com", name: "我自己" });
    db.close();
  });

  it("和当前 schema 比：没有缺表、缺列", () => {
    expect(缺的(path.join(目录, "crm.db"))).toEqual([]);
  }, 30_000);

  it("当前 Prisma 客户端每个模型都查得动（缺列会在这里炸）", async () => {
    const { PrismaClient, Prisma } = await import("@/generated/prisma");
    const c = new PrismaClient({ datasourceUrl: `file:${path.join(目录, "crm.db")}` });
    const 坏的: string[] = [];
    try {
      for (const m of Object.values(Prisma.ModelName)) {
        const k = m[0].toLowerCase() + m.slice(1);
        try {
          await (c as unknown as Record<string, { findFirst: () => Promise<unknown> }>)[k].findFirst();
        } catch (e) {
          坏的.push(`${m}: ${String((e as Error).message).split("\n").pop()}`);
        }
      }
      // 业务上最常用的那条查询：客户连负责人
      const 客户 = await c.customer.findMany({ include: { salesOwner: true } });
      expect(客户.length).toBe(3);
    } finally {
      await c.$disconnect();
    }
    expect(坏的).toEqual([]);
  }, 30_000);
});

describe("全新安装（没有 crm.db）", () => {
  it("复制模板、去掉张三李四、生成本机密码、管理员对上云端账号", async () => {
    const d = path.join(工作区, "fresh");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, ".cloud.json"), JSON.stringify({ token: "t", accountId: "acc_me", name: "", contact: "new@x.com", models: [] }));
    const r = await 跑入口(d);
    expect(r.code).toBe(0);
    const db = 只读库(path.join(d, "crm.db"));
    expect(db.prepare("SELECT email, name FROM User").all()).toEqual([{ email: "new@x.com", name: "new" }]);
    db.close();
    expect(fs.statSync(path.join(d, ".init-password")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, "crm.db")).mode & 0o222).not.toBe(0); // 模板只读不能带过来
  }, 30_000);
});

describe("迁移中途出事", () => {
  const 老 = 老版本们.find((t) => t === "v0.39.2") ?? 老版本们[0];

  /*
    【B · 缺口】迁移用的 DatabaseSync 没设 busy timeout（默认 0）：库被别的连接拿着写锁时（上一个本地服务还没退干净、
    Windows 换包后旧进程晚走一步、人拿 DB Browser 开着库），第一条要写的迁移立刻 "database is locked"，
    entry 直接 exit(1) → 「本地服务没能启动」。锁一秒后就放了，等一等本来就能过。
    Prisma 那边设了 busy_timeout=5000（lib/prisma.ts:36），这里漏了。
  */
  // 2026-10-04 修（D-039）：入口开库一律 busy_timeout=10000（server-entry.js 的 开库）
  it("【B-4】库被别的连接锁住 1 秒：迁移等一等就过，不是直接起不来", async () => {
    const d = 造老库(老, `${老}-lock`);
    // 把 v0.39.2 的那张表删掉，逼迁移真的要写（不然 IF NOT EXISTS 全是空转，碰不到锁）
    const 先 = new DatabaseSync(path.join(d, "crm.db"));
    先.exec('DROP TABLE IF EXISTS "OpportunityClose"');
    先.close();
    const 锁 = new DatabaseSync(path.join(d, "crm.db"));
    锁.exec("BEGIN IMMEDIATE");
    锁.exec(`INSERT INTO "Setting" ("key","value","updatedAt") VALUES ('r2.lock','1',${Date.now()})`);
    setTimeout(() => {
      锁.exec("COMMIT");
      锁.close();
    }, 1000);
    const r = await 跑入口(d);
    expect(r.out).not.toMatch(/database is locked/);
    expect(r.code).toBe(0);
  }, 30_000);

  it("锁着时失败了也不坏库：放开锁再开一次就过，数据一行不少", async () => {
    const d = 造老库(老, `${老}-lock2`);
    const 先 = new DatabaseSync(path.join(d, "crm.db"));
    先.exec('DROP TABLE IF EXISTS "OpportunityClose"');
    先.close();
    const 前 = 快照(path.join(d, "crm.db"));
    const 锁 = new DatabaseSync(path.join(d, "crm.db"));
    锁.exec("BEGIN IMMEDIATE");
    锁.exec(`INSERT INTO "Setting" ("key","value","updatedAt") VALUES ('r2.lock','1',${Date.now()})`);
    const r = await 跑入口(d);
    锁.exec("ROLLBACK");
    锁.close();
    // 锁一直不放：等满 10 秒（B-4 修了之后）还是失败，exit 1——但不坏库
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/database is locked/);
    const 再 = await 跑入口(d);
    expect(再.code).toBe(0);
    const 后 = 快照(path.join(d, "crm.db"));
    for (const t of ["Customer", "FollowUp", "FollowPlan", "Task"]) expect(后[t]).toEqual(前[t]);
  }, 30_000);

  it("磁盘满（整条迁移没执行）：exit 1 不坏库；有空间了再开一次补齐", async () => {
    const d = 造老库(老, `${老}-full`);
    const 先 = new DatabaseSync(path.join(d, "crm.db"));
    先.exec('DROP TABLE IF EXISTS "ContractOwner"');
    先.close();
    const r = await 跑入口(d, { R2_FAIL_MATCH: '"ContractOwner"', R2_FAIL_MODE: "whole" }, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/迁移 011-contract-owner\.sql 失败.*disk is full/);
    const chk = 只读库(path.join(d, "crm.db"));
    expect(chk.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    chk.close();
    const 再 = await 跑入口(d);
    expect(再.code).toBe(0);
    expect(缺的(path.join(d, "crm.db"))).toEqual([]);
  }, 60_000);

  it("磁盘满（多语句的迁移只写了一半）：再开一次接着补齐，不会卡在「已存在」上", async () => {
    const d = 造老库(老, `${老}-half`);
    const 先 = new DatabaseSync(path.join(d, "crm.db"));
    // 007 有三句：建 ImportBatch、建索引、建 ImportRow……删掉让它重来
    先.exec('DROP TABLE IF EXISTS "ImportRow"; DROP TABLE IF EXISTS "ImportBatch";');
    先.close();
    const r = await 跑入口(d, { R2_FAIL_MATCH: 'CREATE TABLE IF NOT EXISTS "ImportBatch"', R2_FAIL_MODE: "partial" }, true);
    expect(r.code).toBe(1);
    const 中间 = 只读库(path.join(d, "crm.db"));
    const 有 = (n: string) => !!中间.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(n);
    expect([有("ImportBatch"), 有("ImportRow")]).toEqual([true, false]); // 确实只写了一半
    中间.close();
    const 再 = await 跑入口(d);
    expect(再.code).toBe(0);
    expect(缺的(path.join(d, "crm.db"))).toEqual([]);
  }, 60_000);

  /*
    【B · 缺口】迁移报了「已存在 / 重复列」以外的错，entry 就 exit(1)，壳弹「本地服务没能启动」，
    只给「重试 / 查看日志 / 退出」，而且说「刚更新完的话等一两分钟再点重试」——迁移错了等多久都一样。
    迁移前不留备份（全面排查 8-D6）。这里钉的是：失败时日志里有哪个文件、什么错，人能拿去反馈。
  */
  it("失败时日志里说得出是哪个迁移文件、什么错", async () => {
    const d = 造老库(老, `${老}-msg`);
    const r = await 跑入口(d, { R2_FAIL_MATCH: "AuditLog", R2_FAIL_MODE: "whole", R2_FAIL_MSG: "boom" }, true);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[entry\] 迁移 001-audit-log\.sql 失败： boom/);
  }, 30_000);
});

describe("迁移文件守卫（README 的规矩，跑之前就拦住）", () => {
  const 迁移 = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const 语句 = (f: string) =>
    fs
      .readFileSync(path.join(ROOT, "migrations", f), "utf8")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

  it("每一句都是 CREATE … IF NOT EXISTS 或 ALTER TABLE … ADD COLUMN（只增不改）", () => {
    const 违规 = 迁移.flatMap((f) => 语句(f).filter((s) => !/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/i.test(s) && !/^ALTER TABLE \S+ ADD COLUMN/i.test(s)).map((s) => `${f}: ${s.slice(0, 60)}`));
    expect(违规).toEqual([]);
  });

  it("带 ADD COLUMN 的文件里不夹建表（第二遍那句一抛，同文件后面的全被跳过）", () => {
    const 违规 = 迁移.filter((f) => {
      const ss = 语句(f);
      return ss.some((s) => /ADD COLUMN/i.test(s)) && ss.some((s) => /^CREATE TABLE/i.test(s));
    });
    expect(违规).toEqual([]);
  });

  it("编号不重复（server-entry 按文件名排序跑，同号谁先谁后靠运气）", () => {
    const 号 = 迁移.map((f) => f.slice(0, 3));
    expect(new Set(号).size).toBe(号.length);
  });
});
