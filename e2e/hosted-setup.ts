/**
 * 托管版 e2e 跑之前：建一个干净的控制面库和空的工作区目录。
 *
 * 和单租户的 global-setup 分开：那边建的是一个装好账号的业务库，
 * 这边要的恰恰是「什么都没有」——工作区由用例自己注册出来，
 * 这样注册流程本身才在测试范围内。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
export const HOSTED_DIR = path.resolve(ROOT, "prisma/e2e-hosted");
export const CONTROL_DB = path.join(HOSTED_DIR, "control.db");
export const WS_DIR = path.join(HOSTED_DIR, "ws");

export default function hostedSetup() {
  rmSync(HOSTED_DIR, { recursive: true, force: true });
  mkdirSync(WS_DIR, { recursive: true });

  // 控制面库：和容器入口同样的办法，从 schema 生成 SQL 再执行
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(HOSTED_DIR, "control.sql");
  writeFileSync(ddl, sql);
  execFileSync(
    "node",
    ["--experimental-sqlite", "-e", `
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync(process.argv[1]);
      db.exec(fs.readFileSync(process.argv[2], 'utf8'));
      db.close();
    `, CONTROL_DB, ddl],
    { cwd: ROOT, stdio: "pipe" },
  );

  // 工作区模板：注册时复制它
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", path.join(WS_DIR, "_template.db")], {
    cwd: ROOT,
    stdio: "pipe",
  });
}
