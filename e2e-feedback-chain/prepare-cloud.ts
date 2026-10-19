/**
 * 应用内反馈回复整条链（playwright.feedback-chain.config.ts）的「云端」：在云端那个 next dev **之前**跑。
 *
 *   1. 从 prisma/control.prisma 建一个空的控制面库（同 e2e/team-qa-ops-setup.ts）
 *   2. 放进桌面端那台已经登录的账号（e2e-desktop/env.ts 的 云端账号：id、邮箱、设备令牌都对得上 .cloud.json）
 *   3. 写一份 extends 主配置的 tsconfig 给云端 next dev 用（见 next.config.ts 的 distDir 那段）
 *
 * 只是本机造的测试账号，不碰正式服。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "../src/generated/control";
import { 云端账号 } from "../e2e-desktop/env";

const ROOT = path.resolve(__dirname, "..");
export const CHAIN_DIR = path.resolve(ROOT, "prisma/e2e-feedback-chain");
export const CONTROL_DB = path.join(CHAIN_DIR, "control.db");

async function main() {
  rmSync(CHAIN_DIR, { recursive: true, force: true });
  mkdirSync(path.join(CHAIN_DIR, "ws"), { recursive: true });

  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(CHAIN_DIR, "control.sql");
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

  const db = new PrismaClient({ datasources: { db: { url: `file:${CONTROL_DB}` } } });
  try {
    await db.account.create({ data: { id: 云端账号.id, name: 云端账号.name, email: 云端账号.contact, password: "e2e-not-a-real-hash" } });
    await db.deviceToken.create({
      data: { accountId: 云端账号.id, tokenHash: createHash("sha256").update(云端账号.token).digest("hex"), name: "e2e 桌面端" },
    });
  } finally {
    await db.$disconnect();
  }

  writeFileSync(path.join(CHAIN_DIR, "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.json" }, null, 2));
}

main().catch((e) => {
  console.error("[feedback-chain] 云端准备失败：", e);
  process.exit(1);
});
