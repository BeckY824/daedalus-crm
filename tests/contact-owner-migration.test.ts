import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

it("真实桌面入口连续迁移旧库：确认来源归属、保留未知与已有归属", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-owner-migrate-"));
  try {
    const file = path.join(dir, "crm.db");
    fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), file);
    const db = new DatabaseSync(file);
    db.exec('DROP INDEX IF EXISTS "UnassignedContact_ownerId_idx"; ALTER TABLE "UnassignedContact" DROP COLUMN "ownerId"');
    for (const id of ["legacy-sales", "legacy-channel"]) db.prepare('INSERT INTO "User" (id, email, name, password, updatedAt) VALUES (?, ?, ?, ?, ?)').run(id, `${id}@example.invalid`, id, "unused", Date.now());
    db.prepare('INSERT INTO "Customer" (id, name, phone, salesOwnerId, channelOwnerId, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("legacy-source", "旧来源", "", "legacy-sales", "legacy-channel", Date.now());
    db.prepare('INSERT INTO "UnassignedContact" (id, name, fromCustomerId, updatedAt) VALUES (?, ?, ?, ?)').run("known", "有来源", "legacy-source", Date.now());
    db.prepare('INSERT INTO "UnassignedContact" (id, name, fromCustomerId, updatedAt) VALUES (?, ?, ?, ?)').run("unknown", "来源已删除", "deleted-source", Date.now());
    db.close();
    fs.copyFileSync(path.resolve(__dirname, "../desktop/server-entry.js"), path.join(dir, "entry.js"));
    fs.cpSync(path.resolve(__dirname, "../migrations"), path.join(dir, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server.js"), "// 入口迁移后结束，不启动网络服务\n");
    const run = () => execFileSync(process.execPath, [path.join(dir, "entry.js")], { env: { ...process.env, CRM_DATA_DIR: dir }, encoding: "utf8" });
    expect(run()).toContain("数据库就绪");
    const first = new DatabaseSync(file);
    expect(first.prepare('SELECT ownerId FROM "UnassignedContact" WHERE id = ?').get("known")).toEqual({ ownerId: "legacy-sales" });
    expect(first.prepare('SELECT ownerId FROM "UnassignedContact" WHERE id = ?').get("unknown")).toEqual({ ownerId: null });
    first.prepare('UPDATE "UnassignedContact" SET ownerId = ? WHERE id = ?').run("explicit-owner", "known");
    first.close();
    expect(run()).toContain("数据库就绪");
    const second = new DatabaseSync(file);
    expect(second.prepare('SELECT ownerId FROM "UnassignedContact" WHERE id = ?').get("known")).toEqual({ ownerId: "explicit-owner" });
    expect(second.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    second.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
