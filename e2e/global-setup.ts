/**
 * E2E 跑之前把测试库建好并写入账号。
 * 每轮从空库开始，用例之间的数据依赖才是可预期的。
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const E2E_DB = path.resolve(ROOT, "prisma/e2e.db");

export default function globalSetup() {
  for (const f of [E2E_DB, `${E2E_DB}-wal`, `${E2E_DB}-shm`]) rmSync(f, { force: true });

  const env = { ...process.env, DATABASE_URL: `file:${E2E_DB}` };
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT, env, stdio: "pipe",
  });
  // 只建账号，不写业务数据——业务数据由用例自己按链条造，才测得出流程
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ROOT, env, stdio: "pipe" });
}
