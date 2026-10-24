/**
 * 企业版 e2e 的库：空库 → 种子（企业版只建管理员）→ 测试机准备脚本（样例的在职账号 + 一家已有客户）。
 * 和测试机上走的是同一个脚本，测试机那天照 tests/fixtures/ent-sample/说明.md 跑就是这里验过的状态。
 *
 * 由 playwright.enterprise.config.ts 的 webServer 命令在起服务**之前**跑，不放 globalSetup：
 * Playwright 先起 webServer 再跑 globalSetup，那时删库重建，服务连着的还是被删掉的旧文件（见 e2e-desktop/prepare.ts 开头）。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENT_E2E_DB } from "./env";

const ROOT = path.resolve(__dirname, "..");
for (const f of [ENT_E2E_DB, `${ENT_E2E_DB}-wal`, `${ENT_E2E_DB}-shm`, `${ENT_E2E_DB}-journal`]) rmSync(f, { force: true });
// Prisma 6 的部分 macOS 引擎建不了不存在的 SQLite 文件，先放个空文件，表由 db push 建
writeFileSync(ENT_E2E_DB, "");

const env = { ...process.env, DATABASE_URL: `file:${ENT_E2E_DB}`, CRM_ENTERPRISE: "1" };
const 跑 = (...args: string[]) => execFileSync("npx", args, { cwd: ROOT, env, stdio: "inherit" });
跑("prisma", "db", "push", "--skip-generate", "--accept-data-loss");
跑("tsx", "prisma/seed.ts");
跑("tsx", "scripts/ent-import-prepare.ts");
