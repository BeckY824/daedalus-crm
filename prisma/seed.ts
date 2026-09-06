/**
 * 账号初始化 / 同步。
 *
 * 首次启动时由 docker-entrypoint.sh 自动执行；也可以在已有库上手动重跑，
 * 用来同步账号的姓名与角色（不会动密码，除非显式加 RESET_PASSWORDS=1）。
 *
 *   node seed.js                        # 只补齐缺的账号、同步姓名与角色
 *   INIT_PASSWORD=xxx node seed.js      # 新建账号时用指定密码
 *   RESET_PASSWORDS=1 node seed.js      # 顺便把三个账号的密码重置回初始密码
 *   PRUNE_ACCOUNTS=1 node seed.js       # 停用名单外的账号（名下有数据的不动）
 *
 * 只建账号，不写业务数据。带演示数据的版本见 seed-demo.ts。
 */
import { PrismaClient } from "../src/generated/prisma";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/** 初始密码可用 INIT_PASSWORD 覆盖 */
const PASSWORD = process.env.INIT_PASSWORD ?? "crm@2026";

/**
 * 正式账号名单。**改这里**——`reset-data.mjs` 与 `seed-demo.ts` 里的副本
 * 必须跟着改，有用例（tests/accounts.test.ts）盯着三处是否一致。
 *
 * email 字段实际存的是登录用户名，不是邮箱：界面上填的就是这个。
 */
export const USERS = [
  { email: "admin", name: "管理员", title: "系统管理员", role: "ADMIN" },
  { email: "zhangsan", name: "张三", title: "销售", role: "SALES" },
  { email: "lisi", name: "李四", title: "销售", role: "SALES" },
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const 重置密码 = process.env.RESET_PASSWORDS === "1";

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      // 姓名和角色跟着名单走，重跑能同步改名；密码默认不动，免得误重置
      update: { name: u.name, title: u.title, role: u.role, active: true, ...(重置密码 ? { password: hash } : {}) },
      create: { ...u, password: hash },
    });
    console.log(`  ${u.email.padEnd(11)} ${u.name}（${u.title}）`);
  }

  // 名单外的账号：默认只提示，不擅自处理——有人可能是在界面上正常加的
  const 名单外 = await prisma.user.findMany({
    where: { email: { notIn: USERS.map((u) => u.email) } },
    select: {
      id: true, email: true, name: true, active: true,
      _count: { select: { salesCustomers: true, opportunities: true, followUps: true, leads: true } },
    },
  });

  for (const u of 名单外) {
    const 名下 = u._count.salesCustomers + u._count.opportunities + u._count.followUps + u._count.leads;
    if (!process.env.PRUNE_ACCOUNTS) {
      console.log(`  ! 名单外账号 ${u.email}（${u.name}），名下 ${名下} 条数据。加 PRUNE_ACCOUNTS=1 可停用`);
      continue;
    }
    if (名下 > 0) {
      console.log(`  ! ${u.email} 名下还有 ${名下} 条数据，不动它——请先在界面上「停用并转交」`);
      continue;
    }
    await prisma.user.delete({ where: { id: u.id } });
    console.log(`  - 已删除名单外的空账号 ${u.email}（${u.name}）`);
  }

  // 容器首启由 entrypoint 统一打印初始密码（只打一次、格式醒目），这里就不重复了
  if (process.env.QUIET_PASSWORD === "1") {
    console.log(`\n共 ${await prisma.user.count()} 个账号`);
  } else {
    console.log(`\n共 ${await prisma.user.count()} 个账号，初始密码：${PASSWORD}`);
    console.log("请各自登录后到「设置管理 → 修改密码」修改");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
