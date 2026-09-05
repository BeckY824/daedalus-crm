/**
 * 走查用的模拟数据。
 *
 * 空状态只能看出「没数据时长什么样」，看不出分页、长列表、图表有数据时的样子，
 * 也看不出推荐链、各种状态标签堆在一起会不会挤。所以造一批像样的假数据，
 * 走查完再清掉。
 *
 * 直接用 Prisma 写库而不是走界面：造 60 条要点几百次，没必要。
 * 只连 E2E 库（prisma/e2e.db），绝不碰开发库与线上库。
 */
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma";

const E2E_DB = path.resolve(__dirname, "../prisma/e2e.db");

export function 连库() {
  return new PrismaClient({ datasourceUrl: `file:${E2E_DB}` });
}

/** 清空全部业务数据，保留账号 */
export async function 清空业务数据(p: PrismaClient) {
  await p.auditLog.deleteMany();
  await p.task.deleteMany();
  await p.followPlan.deleteMany();
  await p.followUp.deleteMany();
  await p.contract.deleteMany();
  await p.opportunity.deleteMany();
  await p.contact.deleteMany();
  await p.lead.deleteMany();
  await p.customer.updateMany({ data: { referrerCustomerId: null, attributionCustomerId: null } });
  await p.customer.deleteMany();
  await p.channel.deleteMany();
}

const 姓 = ["张", "王", "李", "赵", "陈", "刘", "杨", "黄", "周", "吴"];
const 名 = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "艳", "勇", "杰"];
const 院校 = ["北京大学", "清华大学", "复旦大学", "上海交通大学", "浙江大学", "南京大学", "武汉大学"];
const 专业 = ["计算机科学与技术", "金融学", "软件工程", "电子信息工程", "工商管理", "临床医学"];
const 年级 = ["大一", "大二", "大三", "大四", "研一", "研二"];
const 跟进 = ["待跟进", "跟进中", "已加微信", "已试听", "意向较高", "暂缓跟进", "已签约", "已流失"];
const 决策 = ["了解中", "对比中", "与家人商议", "等待预算", "已决定报名", "暂不考虑"];

/** 造一批覆盖各种状态的数据。返回造了多少条，便于用例断言 */
export async function 造模拟数据(p: PrismaClient) {
  // 与产品规则一致：管理员不担任业务负责人，造数据时也不要分给他
  const 员工 = await p.user.findMany({
    where: { role: { not: "ADMIN" } },
    orderBy: { createdAt: "asc" },
  });
  if (!员工.length) throw new Error("库里没有账号，globalSetup 没跑？");

  const 渠道 = [];
  for (const [i, n] of ["小红老师", "王主任", "学长推荐群"].entries()) {
    渠道.push(await p.channel.create({
      data: { name: n, phone: `1380000${1000 + i}`, channelOwnerId: 员工[i % 员工.length].id },
    }));
  }

  // 先造一条完整的推荐链，走查时用来看归属展示
  const 链: string[] = [];
  for (let i = 0; i < 4; i++) {
    const 上一个 = 链[链.length - 1];
    const c = await p.customer.create({
      data: {
        name: `链条${i + 1}号`,
        phone: `13911110${String(i).padStart(3, "0")}`,
        school: 院校[i % 院校.length],
        major: 专业[i % 专业.length],
        grade: 年级[i % 年级.length],
        followStatus: 跟进[i % 跟进.length],
        decisionStatus: 决策[i % 决策.length],
        salesOwnerId: 员工[i % 员工.length].id,
        channelId: 渠道[0].id,
        channelOwnerId: 渠道[0].channelOwnerId,
        referrerCustomerId: 上一个 ?? null,
        attributionChannelId: i <= 1 ? 渠道[0].id : null,
        attributionCustomerId: i >= 2 ? 链[链.length - 2] : null,
      },
    });
    链.push(c.id);
  }

  // 再造一批普通学员，凑够多页
  const 学员: string[] = [...链];
  for (let i = 0; i < 56; i++) {
    const c = await p.customer.create({
      data: {
        name: `${姓[i % 姓.length]}${名[(i * 3) % 名.length]}${i > 9 ? i : ""}`,
        phone: `137${String(10000000 + i * 137).slice(0, 8)}`,
        school: 院校[i % 院校.length],
        major: 专业[i % 专业.length],
        grade: 年级[i % 年级.length],
        followStatus: 跟进[i % 跟进.length],
        decisionStatus: 决策[i % 决策.length],
        salesOwnerId: 员工[i % 员工.length].id,
        expectedSignAt: i % 3 === 0 ? new Date(2026, 8, (i % 27) + 1) : null,
        remark: i % 5 === 0 ? "家长比较关注就业情况，需要准备往届学员去向数据" : null,
        ...(i % 4 === 0
          ? { channelId: 渠道[i % 渠道.length].id, channelOwnerId: 渠道[i % 渠道.length].channelOwnerId,
              attributionChannelId: 渠道[i % 渠道.length].id }
          : {}),
      },
    });
    学员.push(c.id);
  }

  // 签约：给「已签约」的人配上金额
  const 已签约 = await p.customer.findMany({ where: { followStatus: "已签约" }, select: { id: true } });
  for (const [i, c] of 已签约.entries()) {
    await p.contract.create({
      data: { customerId: c.id, amount: [19800, 24800, 9800, 39800][i % 4], signedAt: new Date(2026, 7, (i % 28) + 1) },
    });
  }

  // 跟进记录：让时间线和沟通统计有东西
  for (const [i, id] of 学员.slice(0, 20).entries()) {
    await p.followUp.create({
      data: {
        customerId: id, ownerId: 员工[i % 员工.length].id,
        type: ["PHONE", "MEETING", "VISIT", "EMAIL"][i % 4],
        title: i % 2 === 0 ? "" : "首次沟通",
        content: "介绍了课程体系与价格，家长关心就业去向，约好周末再聊一次",
        status: "已完成",
        duration: i % 4 === 0 ? 600 + i * 30 : null,
        occurredAt: new Date(2026, 7, (i % 28) + 1, 10, 0),
      },
    });
  }

  // 商机：铺满漏斗各阶段
  const 阶段 = ["初步沟通", "需求确认", "方案报价", "谈判审核", "赢单成交"];
  for (const [i, id] of 学员.slice(0, 15).entries()) {
    await p.opportunity.create({
      data: {
        customerId: id, ownerId: 员工[i % 员工.length].id,
        name: `${阶段[i % 阶段.length]}的商机 ${i + 1}`,
        amount: 10000 + i * 2500,
        stage: 阶段[i % 阶段.length],
        status: i % 7 === 6 ? "LOST" : i % 阶段.length === 4 ? "WON" : "OPEN",
        probability: [20, 40, 60, 80, 100][i % 5],
      },
    });
  }

  // 线索：含已转化与未转化
  for (let i = 0; i < 18; i++) {
    await p.lead.create({
      data: {
        name: `线索-${姓[i % 姓.length]}同学`,
        contact: `${姓[i % 姓.length]}家长`,
        phone: `1355000${String(1000 + i)}`,
        source: ["官网注册", "电话咨询", "展会获取", "转介绍", "广告投放"][i % 5],
        status: ["待跟进", "跟进中", "已放弃"][i % 3],
        ownerId: 员工[i % 员工.length].id,
        remark: i % 4 === 0 ? "从公众号文章进来的，问了集训营时间" : null,
      },
    });
  }

  // 联系人与待办
  for (const [i, id] of 学员.slice(0, 12).entries()) {
    await p.contact.create({
      data: { customerId: id, name: i % 2 ? "本人" : "母亲", phone: `1366000${1000 + i}`, isPrimary: true,
              position: i % 2 ? "学生" : "家长" },
    });
    await p.task.create({
      data: { customerId: id, ownerId: 员工[i % 员工.length].id, title: "把往届去向表发给家长",
              dueAt: new Date(2026, 8, (i % 27) + 1) },
    });
  }

  return {
    学员: await p.customer.count(),
    线索: await p.lead.count(),
    商机: await p.opportunity.count(),
    签约: await p.contract.count(),
    跟进: await p.followUp.count(),
  };
}
