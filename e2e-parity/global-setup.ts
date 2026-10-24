/**
 * 截图对比用的库：每轮从空库开始，只建企业版那一个管理员（CRM_ENTERPRISE=1 时 seed 只建 admin），
 * 业务数据由用例用排版闸门那份「像真客户」的种子灌。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
export const 库 = path.resolve(ROOT, "prisma/e2e-parity.db");

export default function globalSetup() {
  for (const f of [库, `${库}-wal`, `${库}-shm`]) rmSync(f, { force: true });
  writeFileSync(库, "");
  const env = { ...process.env, DATABASE_URL: `file:${库}`, CRM_ENTERPRISE: "1" };
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: ROOT, env, stdio: "pipe" });
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ROOT, env, stdio: "pipe" });
}
