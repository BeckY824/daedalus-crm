/**
 * 桌面端 e2e 的「装好一台刚登录的桌面端」：由 playwright.desktop.config.ts 的 webServer 命令
 * 在 next dev **之前**跑（npx tsx e2e-desktop/prepare.ts && npx next dev …）。
 *
 * 为什么不放 globalSetup：Playwright 先起 webServer 再跑 globalSetup。那时删库重建，
 * dev server 万一已经开过上一轮的库（SQLite 连着一个被删掉的文件照样能读写），
 * 这一轮就悄悄跑在旧数据上——连跑两遍都绿就成了碰运气。放在 next dev 前面，起服务时库一定是新的。
 *
 * 做的事照着真壳第一次启动走（desktop/server-entry.js + 登录动作 lib/desktop/cloud.ts 的 登录）：
 *   1. 建一个只有账号的空库（和默认 e2e 一样：prisma db push + seed）
 *   2. 新库去掉张三 / 李四两个样例账号，管理员的名字邮箱对成云端账号，记下同步过的名字
 *   3. 数据目录里写 .cloud.json（登录过云端）和 .owner（这份目录归这个账号）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { CLOUD_URL, DATA_DIR, DB, ROOT, 云端账号 } from "./env";

async function main() {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DB}-journal`]) rmSync(f, { force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const env = { ...process.env, DATABASE_URL: `file:${DB}` };
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: ROOT, env, stdio: "pipe" });
  execFileSync("npx", ["tsx", "prisma/seed.ts"], { cwd: ROOT, env, stdio: "pipe" });

  const p = new PrismaClient({ datasourceUrl: `file:${DB}` });
  try {
    // server-entry.js：新建的库里不该有自部署演示用的样例账号，桌面端是一个人用
    await p.user.deleteMany({ where: { email: { in: ["zhangsan", "lisi"] } } });
    await p.user.update({
      where: { email: "admin" },
      data: { email: 云端账号.contact, name: 云端账号.name, title: "管理员" },
    });
    await p.setting.upsert({
      where: { key: "desktop.syncedName" },
      update: { value: JSON.stringify(云端账号.name) },
      create: { key: "desktop.syncedName", value: JSON.stringify(云端账号.name) },
    });
    /*
      「上次看过的更新记录」记成上一版：第一次进主界面就该弹「已更新到 <现在>」（whats-new-actions.ts）。
      不记的话新库第一次打开直接记成现在这版、什么都不弹，更新记录那条路就测不到。
      必须在起服务之前写：设置走进程内缓存，服务起来以后从外面改库它看不见（lib/settings.ts）
    */
    await p.setting.create({ data: { key: "desktop.whatsNewSeen", value: JSON.stringify("0.46.14") } });
  } finally {
    await p.$disconnect();
  }

  写云端凭据();
  writeFileSync(path.join(DATA_DIR, ".owner"), 云端账号.id, { mode: 0o600 });
}

/** 和 lib/desktop/cloud.ts 登录() 写出来的同一个形状（用例里挪开 / 放回它来模拟退出云端账号，见 helpers.ts） */
function 写云端凭据() {
  writeFileSync(
    path.join(DATA_DIR, ".cloud.json"),
    JSON.stringify(
      {
        baseUrl: CLOUD_URL,
        token: 云端账号.token,
        accountId: 云端账号.id,
        name: 云端账号.name,
        contact: 云端账号.contact,
        models: ["e2e-model|默认"],
        loggedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

main().catch((e) => {
  console.error("[e2e-desktop] 准备失败：", e);
  process.exit(1);
});
