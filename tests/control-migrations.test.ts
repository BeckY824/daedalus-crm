/**
 * 托管版控制面迁移（control-migrations/）的全局护栏。2026-10-04 上线前测试第 0 期补的。
 *
 * 规矩和业务库那套（tests/migrations.test.ts）一样：docker-entrypoint.sh 每次启动把整个目录重跑一遍、
 * 不记执行到哪，所以每条语句都必须幂等；而且控制面**只加表不改表**（credits.ts 顶上写着为什么）。
 * 之前只有 ai-cost、device-info 等几处按表抽查，没有一道管住整个目录的。
 *
 * 另外钉一件抽查管不到的：老部署上，这些表是迁移建出来的，不是 control-schema.sql 建的。
 * 迁移里写的列要是比 prisma/control.prisma 少，新装的机器一切正常，老机器上一查就报 no such column。
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "control-migrations");
const 文件 = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const 去注释 = (f: string) => readFileSync(path.join(DIR, f), "utf8").replace(/--.*$/gm, "");
const 临时 = mkdtempSync(path.join(os.tmpdir(), "control-mig-"));
afterAll(() => rmSync(临时, { recursive: true, force: true }));

/** 和 docker-entrypoint.sh「控制面补迁移」那段一模一样的跑法 */
function 跑迁移(db: DatabaseSync) {
  for (const f of 文件) {
    try {
      db.exec(readFileSync(path.join(DIR, f), "utf8"));
    } catch (e) {
      if (!/duplicate column name|already exists/i.test(String((e as Error).message))) throw new Error(`${f}: ${(e as Error).message}`);
    }
  }
}

const 列 = (db: DatabaseSync, t: string) =>
  (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name).sort();
const 表 = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);

describe("控制面迁移文件", () => {
  it("按序号命名", () => {
    expect(文件.length).toBeGreaterThan(0);
    for (const f of 文件) expect(f, `${f} 不符合 NNN-说明.sql`).toMatch(/^\d{3}-[a-z0-9-]+\.sql$/);
    const 号 = 文件.map((f) => f.slice(0, 3));
    expect(new Set(号).size, "序号重复").toBe(号.length);
  });

  it("只加表：不许 DROP / DELETE / UPDATE / INSERT / ALTER", () => {
    for (const f of 文件) {
      const sql = 去注释(f).toUpperCase();
      for (const 禁 of ["DROP ", "DELETE FROM", "UPDATE ", "INSERT INTO", "ALTER TABLE"]) {
        expect(sql.includes(禁), `${f} 含有不允许的语句：${禁}`).toBe(false);
      }
    }
  });

  it("每条 CREATE 都带 IF NOT EXISTS", () => {
    for (const f of 文件) {
      const 不带 = 去注释(f).match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF\s+NOT\s+EXISTS)/gi) ?? [];
      expect(不带, `${f}`).toEqual([]);
    }
  });

  it("新装的库（control-schema.sql）上跑两遍不炸", () => {
    const sql = execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const db = new DatabaseSync(path.join(临时, "fresh.db"));
    db.exec(sql);
    const 之前 = 表(db).sort();
    跑迁移(db);
    跑迁移(db);
    // 只多不少：多出来的是 schema 里已经删掉、迁移仍会建的老码表（ActivationCode 等，线上留着不删）
    expect(之前.filter((t) => !表(db).includes(t))).toEqual([]);
    db.close();
  });

  it("老部署上迁移建出来的表，列和 control.prisma 一列不少", () => {
    const sql = execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const 新 = new DatabaseSync(path.join(临时, "schema.db"));
    新.exec(sql);
    const 老 = new DatabaseSync(path.join(临时, "old.db"));
    跑迁移(老);
    跑迁移(老);
    const 缺 = 表(老).flatMap((t) => {
      const 要 = 列(新, t);
      if (要.length === 0) return []; // schema 里已经没有这张表（老的码表留着不删），不比
      const 有 = 列(老, t);
      return 要.filter((c) => !有.includes(c)).map((c) => `${t}.${c}`);
    });
    expect(缺).toEqual([]);
    新.close();
    老.close();
  });
});
