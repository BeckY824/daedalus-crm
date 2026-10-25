/**
 * 截图对比用的库：每轮从空库开始，只建企业版那一个管理员（CRM_ENTERPRISE=1 时 seed 只建 admin），
 * 业务数据由用例用排版闸门那份「像真客户」的种子灌。
 * 企业版那一份（组织规则开关、部门树、线索分配）在这里灌：设置是服务端进程里一次读进内存的，
 * 得在服务器处理第一个请求之前写进库，用例里再写就读不到了。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { 灌企业版 } from "./企业版种子";

const ROOT = path.resolve(__dirname, "..");
export const 库 = path.resolve(ROOT, "prisma/e2e-parity.db");

export default async function globalSetup() {
  for (const f of [库, `${库}-wal`, `${库}-shm`]) rmSync(f, { force: true });
  writeFileSync(库, "");
  const env = { ...process.env, DATABASE_URL: `file:${库}`, CRM_ENTERPRISE: "1" };
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: ROOT, env, stdio: "pipe" });
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ROOT, env, stdio: "pipe" });
  const db = new PrismaClient({ datasourceUrl: `file:${库}` });
  try {
    const 我 = (await db.user.findFirstOrThrow({ where: { email: "admin" } })).id;
    await 灌企业版(db, 我);
  } finally {
    await db.$disconnect();
  }
}
