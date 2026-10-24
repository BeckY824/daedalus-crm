/**
 * 企业版导入 · 测试机准备：照样例的员工名单建在职账号，再建 说明.md 里那家「已有客户」。
 * 测试机上手工建 26 个账号太慢；E2E（playwright.enterprise.config.ts）也用它，两边准备的东西一样。
 *
 *   本机 / CI：DATABASE_URL=file:/path/to/xxx.db npx tsx scripts/ent-import-prepare.ts [样例目录]
 *     样例目录默认 tests/fixtures/ent-sample
 *   容器里（Dockerfile 预打包成 ent-import-prepare.js，容器里没有 tsx 也没有 tests/，样例目录要先拷进去）：
 *     docker compose cp 企业版导入样例 crm:/tmp/ent-sample
 *     docker compose exec crm node ent-import-prepare.js /tmp/ent-sample
 *     新账号的密码用 INIT_PASSWORD；不给就随机（这些账号只是当负责人用，要登录在设置里重置）
 *
 * 重跑不重复：账号按登录名（名单里的邮箱）认，已有客户按电话认，有了就不动。
 * 钱进是离职的，不建——样例里写他当负责人的那几家，报告要提醒「负责人对不上」。
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma";
import { 读文件 } from "../src/lib/enterprise-import/excel";

const 目录 = path.resolve(process.argv[2] ?? path.join(__dirname, "../tests/fixtures/ent-sample"));
const prisma = new PrismaClient();

function 列(表: ReturnType<typeof 读文件>, 头: string) {
  const i = 表.表头.indexOf(头);
  if (i < 0) throw new Error(`${表.名} 没有「${头}」列`);
  return 表.行.map((r) => String(r[i] ?? "").trim());
}

async function main() {
  if (!existsSync(path.join(目录, "员工与部门.xlsx"))) throw new Error(`${目录} 里没有 员工与部门.xlsx：把样例目录的路径跟在命令后面`);
  const 管理员 = await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" } });
  if (!管理员) throw new Error("库里还没有管理员：先跑 prisma/seed.ts");

  const 员工 = 读文件({ 名: "员工与部门.xlsx", bytes: new Uint8Array(readFileSync(path.join(目录, "员工与部门.xlsx"))) });
  const [名, 邮箱, 职位, 状态] = ["姓名", "邮箱", "职位", "在职状态"].map((h) => 列(员工, h));
  const hash = await bcrypt.hash(process.env.INIT_PASSWORD ?? randomBytes(18).toString("base64url"), 10);
  let 新建 = 0;
  let 已有 = 0;
  for (let i = 0; i < 名.length; i++) {
    if (状态[i] !== "在职") continue;
    if (await prisma.user.findUnique({ where: { email: 邮箱[i] } })) {
      已有++;
      continue;
    }
    await prisma.user.create({ data: { email: 邮箱[i], name: 名[i], title: 职位[i], role: "SALES", password: hash } });
    新建++;
  }
  console.log(`账号：新建 ${新建}，原来就有 ${已有}`);

  const 说明 = readFileSync(path.join(目录, "说明.md"), "utf8").match(/已有客户：「(.+?)」，电话 (\d+)/);
  if (!说明) throw new Error("说明.md 里没找到「已有客户：「名称」，电话 xxx」那句");
  const [, 客户名, 电话] = 说明;
  if (await prisma.customer.findFirst({ where: { phone: 电话 } })) console.log(`已有客户：${客户名} 原来就有`);
  else {
    await prisma.customer.create({ data: { name: 客户名, phone: 电话, salesOwnerId: 管理员.id, remark: "测试机上本来就有" } });
    console.log(`已有客户：建了 ${客户名}（${电话}），负责人 ${管理员.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
