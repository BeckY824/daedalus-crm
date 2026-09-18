/**
 * 通用销售场景的演示数据（公司 / 职位 / 行业），和默认业务配置对得上。
 * 其中的推荐链专门用来验证归属规则：
 *   小红(渠道·张三负责) → 小明 → 张工 → 李经理
 * 预期归属：小明→小红，张工→小红，李经理→小明；三人渠道负责人都是张三。
 */
import { PrismaClient } from "../src/generated/prisma";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const pwd = await bcrypt.hash("admin123", 10);

  const [admin, zhangsan, customer] = await Promise.all([
    prisma.user.upsert({ where: { email: "admin" }, update: {},
      create: { email: "admin", name: "管理员", title: "系统管理员", role: "ADMIN", password: pwd } }),
    prisma.user.upsert({ where: { email: "zhangsan" }, update: {},
      create: { email: "zhangsan", name: "张三", title: "销售", role: "SALES", password: pwd } }),
    prisma.user.upsert({ where: { email: "lisi" }, update: {},
      create: { email: "lisi", name: "李四", title: "销售", role: "SALES", password: pwd } }),
  ]);

  // 外部渠道：小红，由张三负责
  const xiaohong = await prisma.channel.upsert({
    where: { name: "小红" },
    update: {},
    create: { name: "小红", phone: "13700001111", remark: "合作伙伴，互相导流", channelOwnerId: zhangsan.id },
  });

  // 第一代：渠道直接推荐 → 归属取链条顶端（小红）
  const xiaoming = await prisma.customer.create({
    data: {
      name: "小明", phone: "13800001001", school: "星辰科技", major: "IT互联网", grade: "部门负责人",
      followStatus: "已签约", decisionStatus: "已决定报名",
      salesOwnerId: customer.id,
      channelId: xiaohong.id,
      attributionChannelId: xiaohong.id,
      channelOwnerId: zhangsan.id,
      contracts: { create: { amount: 19800, signedAt: new Date() } },
    },
  });

  // 第二代：小明推荐 → 往上两代是小红
  const zhanggong = await prisma.customer.create({
    data: {
      name: "张工", phone: "13800001002", school: "远望信息", major: "软件服务", grade: "技术",
      followStatus: "意向较高", decisionStatus: "与家人商议",
      salesOwnerId: customer.id,
      channelId: xiaohong.id,
      referrerCustomerId: xiaoming.id,
      attributionChannelId: xiaohong.id,
      channelOwnerId: zhangsan.id,
    },
  });

  // 第三代：室友推荐 → 往上两代是小明，不再归小红
  await prisma.customer.create({
    data: {
      name: "李经理", phone: "13800001003", school: "合德智造", major: "智能制造", grade: "经办人",
      followStatus: "跟进中", decisionStatus: "了解中",
      salesOwnerId: zhangsan.id,
      channelId: xiaohong.id,
      referrerCustomerId: zhanggong.id,
      attributionCustomerId: xiaoming.id,
      channelOwnerId: zhangsan.id,
    },
  });

  // 自然流量：无推荐人
  await prisma.customer.create({
    data: {
      name: "王自然", phone: "13800001004", school: "通元商贸", major: "商贸流通", grade: "创始人 / 老板",
      followStatus: "待跟进", decisionStatus: "了解中",
      salesOwnerId: zhangsan.id,
    },
  });

  const counts = {
    用户: await prisma.user.count(),
    渠道: await prisma.channel.count(),
    客户: await prisma.customer.count(),
    签约: await prisma.contract.count(),
  };
  console.log("演示数据已写入：", counts);
  console.log("登录：admin / admin123");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
