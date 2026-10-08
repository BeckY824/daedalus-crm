import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const backup = createRequire(import.meta.url)("../desktop/backup.js");
const auto = createRequire(import.meta.url)("../desktop/auto-backup.js");
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

async function corruptRestore() {
  const { db, file } = open(); db.close();
  const dir = path.join(root, "backups"); fs.mkdirSync(dir); const name = "daily-2026-10-01.db";
  await backup.备份数据库(file, path.join(dir, name));
  for (const tail of ["", "-wal", "-shm"]) fs.writeFileSync(`${file}${tail}`, `QA corrupt original ${tail}`);
  const bytes = ["", "-wal", "-shm"].map(tail => fs.readFileSync(`${file}${tail}`));
  return { file, dir, name, bytes, run: () => auto.恢复({ 库: file, 数据目录: root, 文件名: name, 校验: backup.校验数据库 }) };
}
it("坏当前库也能恢复好备份，原库/WAL/SHM按字节保存并附SHA清单", async () => {
  const x = await corruptRestore(); const result = x.run();
  expect(result.另存).toBeNull(); expect(result.隔离).toMatch(/^corrupt-before-restore-/);
  const raw = path.join(x.dir, result.隔离);
  const manifest = JSON.parse(fs.readFileSync(path.join(raw, "manifest.json"), "utf8"));
  for (const [i, tail] of ["", "-wal", "-shm"].entries()) {
    const file = `crm.db${tail}`; expect(fs.readFileSync(path.join(raw, file)).equals(x.bytes[i])).toBe(true);
    expect(manifest.files.find((f: { file: string }) => f.file === file).sha256).toBe(crypto.createHash("sha256").update(x.bytes[i]).digest("hex"));
    if (process.platform !== "win32") expect(fs.statSync(path.join(raw, file)).mode & 0o777).toBe(0o600);
  }
  expect(auto.列出(root).some((f: { 文件名: string }) => f.文件名 === result.隔离)).toBe(false);
  expect(backup.校验数据库(x.file).表数).toBe(1);
  const db = new DatabaseSync(x.file); try { expect(db.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({ n: 2 }); } finally { db.close(); }
});
it("坏库恢复换库失败，原数据库及两个sidecar全部回到原位", async () => {
  const x = await corruptRestore(); const rename = fs.renameSync.bind(fs);
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === x.file) throw new Error("QA replacement denied"); return rename(from, to); });
  try { expect(x.run).toThrow("QA replacement denied"); } finally { spy.mockRestore(); }
  for (const [i, tail] of ["", "-wal", "-shm"].entries()) expect(fs.readFileSync(`${x.file}${tail}`).equals(x.bytes[i])).toBe(true);
  expect(fs.readdirSync(root).some(n => n.includes("restore.tmp"))).toBe(false);
});
it("原件保护复制失败中止恢复，不触碰当前坏库或sidecar", async () => {
  const x = await corruptRestore(); const copy = fs.copyFileSync.bind(fs);
  const spy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, flags) => { if (String(from).endsWith("-wal")) throw Object.assign(new Error("QA disk full"), { code: "ENOSPC" }); return copy(from, to, flags); });
  try { expect(x.run).toThrow("QA disk full"); } finally { spy.mockRestore(); }
  for (const [i, tail] of ["", "-wal", "-shm"].entries()) expect(fs.readFileSync(`${x.file}${tail}`).equals(x.bytes[i])).toBe(true);
});
it("有效当前库另存发生IO错误不走腐坏绕过，仍保留当前记录", async () => {
  const { db, file } = open(); db.close();
  const dir = path.join(root, "backups"); fs.mkdirSync(dir); const name = "daily-2026-10-01.db";
  await backup.备份数据库(file, path.join(dir, name));
  const rename = fs.renameSync.bind(fs);
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from,to) => {
    if (path.basename(String(to)).startsWith("before-restore-")) throw Object.assign(new Error("QA IO failed"), {errcode:10});
    return rename(from,to);
  });
  try { expect(() => auto.恢复({库:file,数据目录:root,文件名:name,校验:backup.校验数据库})).toThrow("QA IO failed"); } finally { spy.mockRestore(); }
  expect(fs.readdirSync(dir).some(f => f.startsWith("corrupt-before-restore"))).toBe(false);
  const read = new DatabaseSync(file);try {expect(read.prepare("SELECT count(*) AS n FROM Customer").get()).toEqual({n:2})}finally{read.close()}
});
it("自动备份生成失败不留下伪成品，重试可生成0600可校验单文件", () => {
  const { db, file } = open(); db.close();
  const args = { 库: file, 数据目录: root, 版本: "QA", 日志: () => {} };
  const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("QA no rename"); });
  try { expect(auto.自动备份(args)).toEqual([]); } finally { spy.mockRestore(); }
  expect(fs.readdirSync(path.join(root, "backups")).filter(n => n.endsWith(".db") || n.endsWith(".tmp"))).toEqual([]);
  const saved = auto.自动备份(args); expect(saved).toHaveLength(1);
  const target = path.join(root, "backups", saved[0]); expect(backup.校验数据库(target).表数).toBe(1);
  if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o600);
});
