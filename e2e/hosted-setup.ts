/**
 * 托管版 e2e 跑之前：建一个干净的控制面库和空的工作区目录。
 *
 * 和单租户的 global-setup 分开：那边建的是一个装好账号的业务库，这边从零开始。
 *
 * 唯一预置的东西是**那个共享工作区**（2026-09-16 起）：网页版只有它一个，
 * 一套固定账号密码发给要试用的团队。注册那条路只开云端账号、不再开工作区，
 * 所以工作区不可能由用例注册出来，得在这里按生产上同一个脚本建好。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
export const HOSTED_DIR = path.resolve(ROOT, "prisma/e2e-hosted");
export const CONTROL_DB = path.join(HOSTED_DIR, "control.db");
export const WS_DIR = path.join(HOSTED_DIR, "ws");

/** 网页版那唯一一套登录凭据。和生产上的是同一个形状，只是值不同 */
export const 共享工作区 = { slug: "shared", 名称: "试用工作区", 邮箱: "trial@e2e.local", 密码: "trial2026" };

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

  // 工作区模板：建工作区时复制它
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", path.join(WS_DIR, "_template.db")], {
    cwd: ROOT,
    stdio: "pipe",
  });

  // 那个共享工作区。用的就是生产上建它的同一个脚本——两边走同一条路，才测得到同一件事
  execFileSync(
    "npx",
    ["tsx", "scripts/shared-workspace.ts", 共享工作区.邮箱, 共享工作区.密码, 共享工作区.名称, 共享工作区.slug],
    {
      cwd: ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        MULTI_TENANT: "1",
        CONTROL_DATABASE_URL: `file:${CONTROL_DB}`,
        WORKSPACE_DIR: WS_DIR,
        DATABASE_URL: `file:${path.join(HOSTED_DIR, "never-used.db")}`,
      },
    },
  );
}
