/**
 * 「备份数据库」菜单背后的逻辑（desktop/backup.js）。
 * 钉的是：备份出来的是一个能独立打开、通过完整性检查的库；正在写的库也能备；不会备到自己身上。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const 备份 = require_("../desktop/backup.js");

let 沙盒: string;
beforeEach(() => {
  沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
});
afterEach(() => fs.rmSync(沙盒, { recursive: true, force: true }));

function 造库(文件: string, 行数 = 3) {
  const db = new DatabaseSync(文件);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE Student (id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO Student (name) VALUES (?)");
  for (let i = 0; i < 行数; i++) ins.run(`学员${i}`);
  return db;
}

describe("建议文件名", () => {
  it("带日期时间，两位补零", () => {
    expect(备份.建议文件名(new Date(2026, 8, 6, 9, 5))).toBe("DaedalusCRM-备份-2026-09-06-0905.db");
  });
});

describe("备份数据库", () => {
  it("备份出来的库能独立打开，数据齐全，通过 integrity_check", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源, 5).close();
    const 目标 = path.join(沙盒, "out", "b.db");
    fs.mkdirSync(path.dirname(目标));
    const r = await 备份.备份数据库(源, 目标);
    expect(r.表数).toBe(1);
    const db = new DatabaseSync(目标);
    expect(db.prepare("SELECT count(*) AS n FROM Student").get()).toEqual({ n: 5 });
    db.close();
  });

  it("源库还开着、WAL 里有没落盘的写入，备份也拿得到——这就是不能直接 cp 的原因", async () => {
    const 源 = path.join(沙盒, "crm.db");
    const 开着 = 造库(源, 2);
    开着.prepare("INSERT INTO Student (name) VALUES (?)").run("刚写的");
    const 目标 = path.join(沙盒, "b.db");
    const r = await 备份.备份数据库(源, 目标);
    expect(r.表数).toBe(1);
    const db = new DatabaseSync(目标);
    expect(db.prepare("SELECT count(*) AS n FROM Student").get()).toEqual({ n: 3 });
    db.close();
    开着.close();
  });

  it("不能备到自己身上", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源).close();
    await expect(备份.备份数据库(源, 源)).rejects.toThrow(/原文件/);
  });
});

describe("校验数据库", () => {
  it("不是 SQLite 的文件直接抛", () => {
    const f = path.join(沙盒, "x.db");
    fs.writeFileSync(f, "这不是数据库");
    expect(() => 备份.校验数据库(f)).toThrow();
  });
});
