/**
 * 清空全部业务数据并重建账号。
 * 会删除所有客户、联系人、商机、跟进、任务、计划、线索与原有用户。
 *
 * 在容器内执行：
 *   docker compose exec -T -e CONFIRM=RESET -e INIT_PASSWORD=xxx crm node reset-data.js
 */
import { PrismaClient } from "../src/generated/prisma";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PASSWORD = process.env.INIT_PASSWORD ?? "crm@2026";

// 名单与 prisma/seed.ts 保持一致，有用例盯着（tests/accounts.test.ts）
const USERS = [
  { email: "admin",      name: "管理员", title: "系统管理员", role: "ADMIN" },
  { email: "zhangsan", name: "张三",   title: "销售",       role: "SALES" },
  { email: "lisi",        name: "李四", title: "销售",       role: "SALES" },
];

async function main() {
  // 这个脚本会不可逆地清空线上数据，必须显式确认才执行
  if (process.env.CONFIRM !== "RESET") {
    console.error("拒绝执行：这会删除全部数据。确认请加 -e CONFIRM=RESET");
    process.exit(1);
  }

  // 顺序很重要：先删依赖方，再删被依赖方，避免外键约束报错
  console.log("清除业务数据…");
  // 顺序：先删依赖方再删被依赖方，避免外键约束报错
  await prisma.task.deleteMany();
  await prisma.followPlan.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.lead.deleteMany();
  // 学员之间有自引用的推荐关系，先解除再删，否则会撞外键
  await prisma.customer.updateMany({
    data: { referrerCustomerId: null, attributionCustomerId: null },
  });
  await prisma.customer.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.user.deleteMany();

  console.log("创建账号…");
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const u of USERS) {
    await prisma.user.create({ data: { ...u, password: hash } });
    console.log(`  ${u.email.padEnd(9)} ${u.title}`);
  }

  const counts = {
    用户: await prisma.user.count(),
    客户: await prisma.customer.count(),
    联系人: await prisma.contact.count(),
    商机: await prisma.opportunity.count(),
    跟进: await prisma.followUp.count(),
    待办: await prisma.task.count(),
    计划: await prisma.followPlan.count(),
    线索: await prisma.lead.count(),
  };
  console.log("\n完成：", counts);
  console.log(`初始密码：${PASSWORD}（请登录后立即修改）`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
