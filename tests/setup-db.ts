/**
 * 测试库的建表步骤。
 *
 * 原本要先手工跑一次 prisma db push 才能测，换台机器或清掉 prisma/test.db
 * 之后整个套件会以「表不存在」全线报错，看上去像代码坏了。
 * 放进 globalSetup，npm test 一条命令自足。
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const TEST_DB = path.resolve(ROOT, "prisma/test.db");

export default function setup() {
  // Prisma 客户端是 generate 出来的、不进版本库，新克隆的仓库里还没有
  if (!existsSync(path.resolve(ROOT, "src/generated/prisma"))) {
    execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "pipe" });
  }

  // 每轮从空库开始，避免上一轮残留的表结构与当前 schema 不一致
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    rmSync(f, { force: true });
  }
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
      stdio: "pipe",
    },
  );
}
