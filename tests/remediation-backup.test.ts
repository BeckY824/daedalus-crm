import { afterEach, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const backup = createRequire(import.meta.url)("../desktop/backup.js");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-remediation-backup-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const open = () => {
  const file = path.join(root, "crm.db"); const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE Customer(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO Customer(name) VALUES('QA原始'),('QA-WAL');");
  return { db, file };
};
it("D-080 备份是独立单文件，不残留临时WAL/SHM，源库仍可写", async () => {
  const { db, file } = open(); const out = path.join(root, "exports"); fs.mkdirSync(out); const target = path.join(out, "QA.db");
  try {
    await backup.备份数据库(file, target);
    expect(fs.readdirSync(out)).toEqual(["QA.db"]);
    const read = new DatabaseSync(target);
    try { expect(read.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({ n: 2 }); expect(read.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" }); } finally { read.close(); }
    db.exec("INSERT INTO Customer(name) VALUES('QA备份后继续写')");
    expect(db.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({ n: 3 });
  } finally { db.close(); }
});
it("备份目标是源库硬链接时提前拒绝，不覆盖运行中的库", async () => {
  const { db, file } = open(); const target = path.join(root, "alias.db"); fs.linkSync(file, target);
  try { await expect(backup.备份数据库(file, target)).rejects.toThrow(/原文件/); expect(db.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({ n: 2 }); } finally { db.close(); }
});
it("备份目标旁仍有WAL时拒绝覆盖，保留目标和sidecar", async () => {
  const { db, file } = open(); const target = path.join(root, "old-backup.db");
  fs.writeFileSync(target, "QA已有备份"); fs.writeFileSync(`${target}-wal`, "QA旧WAL");
  try { await expect(backup.备份数据库(file, target)).rejects.toThrow(/临时文件|WAL/); expect(fs.readFileSync(target, "utf8")).toBe("QA已有备份"); expect(fs.readFileSync(`${target}-wal`, "utf8")).toBe("QA旧WAL"); } finally { db.close(); }
});
it("坏源备份失败时不覆盖既有备份且不留临时文件", async () => {
  const file = path.join(root, "bad.db"); const target = path.join(root, "old.db"); fs.writeFileSync(file, "QA坏数据库"); fs.writeFileSync(target, "QA已有备份");
  await expect(backup.备份数据库(file, target)).rejects.toThrow(); expect(fs.readFileSync(target, "utf8")).toBe("QA已有备份"); expect(fs.readdirSync(root).sort()).toEqual(["bad.db", "old.db"]);
});

it("D-077 自动恢复换库失败时保留原库全部已提交WAL数据", async () => {
  const auto = createRequire(import.meta.url)("../desktop/auto-backup.js");
  const { vi } = await import("vitest");
  const { spawnSync } = await import("node:child_process");
  const { db, file } = open(); db.close();
  const dir = path.join(root, "backups"); fs.mkdirSync(dir); const name = "daily-2026-10-01.db";
  await backup.备份数据库(file, path.join(dir, name));
  const child = spawnSync(process.execPath, ["-e", "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA wal_autocheckpoint=0;PRAGMA journal_mode=WAL;INSERT INTO Customer(name) VALUES('QA备份之后');\");process.kill(process.pid,'SIGKILL');", file]);
  expect(child.signal).toBe("SIGKILL"); expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(32);
  const rename = fs.renameSync.bind(fs);
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === file) throw new Error("QA拒绝换库"); return rename(from, to); });
  try { expect(() => auto.恢复({ 库: file, 数据目录: root, 文件名: name, 校验: backup.校验数据库 })).toThrow("QA拒绝换库"); } finally { spy.mockRestore(); }
  const original = new DatabaseSync(file);
  try { expect(original.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); expect(original.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({ n: 3 }); } finally { original.close(); }
  expect(fs.readdirSync(root).some((n) => n.endsWith(".restore.tmp"))).toBe(false);
});
