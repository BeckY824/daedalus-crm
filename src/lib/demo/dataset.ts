import type { PrismaClient } from "@/generated/prisma";

/**
 * 演示工作区的数据。
 *
 * 这不是测试夹具，是给陌生人看的第一印象，所以标准不一样：
 * 测试数据只要能触发分支，演示数据要让人相信「这机构真的在用」。
 * 空列表、三条记录、全是「测试1 测试2」的页面比没有演示更劝退。
 *
 * 所有日期都相对 now 生成——演示库每晚重置，写死日期会让它一天比一天陈旧，
 * 半个月后打开全是「3 周前跟进」，看着像个废弃的系统。
 */

const 天 = 86_400_000;
const 前 = (d: number, h = 10) => new Date(Date.now() - d * 天 + h * 3600_000);
const 后 = (d: number, h = 10) => new Date(Date.now() + d * 天 + h * 3600_000);

/** 固定顺序的伪随机，保证每次重置后演示数据一致——排查问题时能对得上 */
function 取号(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

const 院校 = ["北京大学", "清华大学", "复旦大学", "上海交通大学", "浙江大学", "南京大学", "武汉大学", "中山大学", "华中科技大学", "四川大学"];
const 专业 = ["计算机科学与技术", "软件工程", "金融学", "会计学", "电子信息工程", "自动化", "临床医学", "法学", "英语", "工商管理"];
const 年级 = ["大二", "大三", "大四", "研一", "研二"];
const 姓 = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "马", "朱", "胡", "林", "郭", "何"];
const 名 = ["思远", "浩然", "梓涵", "欣怡", "俊杰", "雨桐", "子轩", "诗琪", "宇航", "佳怡", "泽宇", "可欣", "博文", "雅婷", "天佑", "梦洁", "睿智", "静怡"];

const 跟进状态 = ["待跟进", "跟进中", "意向较高", "已签约", "暂缓"];
const 决策状态 = ["了解中", "与家人商议", "对比其他机构", "已决定报名", "暂不考虑"];

const 跟进话术: Record<string, [string, string][]> = {
  待跟进: [["首次来电咨询", "官网留了电话，问秋季语言班的开课时间和价格。说还在比较几家，让我周末前再联系一次。"]],
  跟进中: [
    ["电话回访", "介绍了小班课的师资和课表。家长关心能不能保过，我说清楚了我们不承诺保过但有重修政策，对方表示理解。"],
    ["微信答疑", "发了课程大纲和往期学员的成绩单。学生本人看了比较心动，说要和爸妈商量一下学费。"],
  ],
  意向较高: [
    ["到校参观", "家长和学生一起来的，看了教室和自习区。当场问了分期付款怎么办，我给了两种方案。临走时说这周内给答复。"],
    ["价格沟通", "对方拿了另一家的报价来比。我们贵 3000，但课时多 40 节。逐项算完之后对方认可，卡在开课时间上，希望能提前两周。"],
  ],
  已签约: [
    ["签约确认", "线下签完合同，首付 12000 已收。约定 9 月 1 日开课，班级和班主任下周确认后告知。"],
    ["开课跟进", "第一周上完，学生反馈进度偏快。已经跟教学组沟通，给他单独加了一次答疑。"],
  ],
  暂缓: [["暂缓说明", "学生决定先考研，语言培训推到明年春季。已备注，明年 2 月再联系。"]],
};

export type DemoCounts = Record<string, number>;

/**
 * 往一个刚建好的工作区里灌演示数据。
 * ownerUserId 是 createWorkspace 建的那个管理员，这里只用它当「教务主任」，
 * 不给他挂学员——业绩排行榜按销售口径算，管理员混进去数字会怪。
 */
export async function seedDemo(db: PrismaClient, ownerUserId: string): Promise<DemoCounts> {
  const rnd = 取号(20260914);

  // ---------- 同事 ----------
  const 销售 = await Promise.all(
    [
      { email: "demo-sales-1@qiming.local", name: "张沁", title: "高级课程顾问" },
      { email: "demo-sales-2@qiming.local", name: "李蔚然", title: "课程顾问" },
      { email: "demo-sales-3@qiming.local", name: "陈牧", title: "课程顾问" },
      { email: "demo-sales-4@qiming.local", name: "周昱", title: "课程顾问" },
    ].map((u) => db.user.create({ data: { ...u, role: "SALES", password: "!demo" } })),
  );

  // ---------- 渠道 ----------
  const 渠道 = await Promise.all(
    [
      { name: "林老师（附中）", phone: "13701002001", remark: "附中高三年级组长，每届稳定推荐 5-8 人", 负责: 0 },
      { name: "方舟留学", phone: "13701002002", remark: "留学中介，互相导流", 负责: 1 },
      { name: "校园大使·小禾", phone: "13701002003", remark: "在读学员兼职推广，按人头结算", 负责: 0 },
      { name: "家长社群", phone: "13701002004", remark: "老学员家长自发建的群", 负责: 2 },
    ].map((c) =>
      db.channel.create({
        data: { name: c.name, phone: c.phone, remark: c.remark, channelOwnerId: 销售[c.负责].id },
      }),
    ),
  );

  // ---------- 学员 ----------
  // 状态分布刻意不均匀：真实漏斗是上宽下窄的，五档各占 20% 一眼就假
  const 分布 = [
    ...Array(8).fill("待跟进"),
    ...Array(11).fill("跟进中"),
    ...Array(7).fill("意向较高"),
    ...Array(9).fill("已签约"),
    ...Array(3).fill("暂缓"),
  ];

  const 学员: { id: string; 状态: string; 销售: string }[] = [];
  for (let i = 0; i < 分布.length; i++) {
    const 状态 = 分布[i];
    const s = 销售[i % 销售.length];
    const ch = i % 3 === 0 ? 渠道[rnd(渠道.length)] : null;
    const 建于 = 前(分布.length - i + rnd(5));

    const c = await db.customer.create({
      data: {
        name: `${姓[i % 姓.length]}${名[(i * 7) % 名.length]}`,
        phone: `138${String(20000000 + i * 137).slice(0, 8)}`,
        school: 院校[rnd(院校.length)],
        major: 专业[rnd(专业.length)],
        grade: 年级[rnd(年级.length)],
        followStatus: 状态,
        decisionStatus:
          状态 === "已签约" ? "已决定报名" : 状态 === "暂缓" ? "暂不考虑" : 决策状态[rnd(3)],
        salesOwnerId: s.id,
        channelId: ch?.id ?? null,
        attributionChannelId: ch?.id ?? null,
        channelOwnerId: ch?.channelOwnerId ?? null,
        expectedSignAt: 状态 === "意向较高" ? 后(rnd(20) + 3) : null,
        lastFollowAt: 状态 === "待跟进" ? null : 前(rnd(12)),
        createdAt: 建于,
      },
    });
    学员.push({ id: c.id, 状态, 销售: s.id });
  }

  // ---------- 推荐链：产品的差异点，演示里必须看得见 ----------
  // 小禾（渠道）→ 甲 → 乙 → 丙：归属往上两代，不足两代取链条顶端
  const 小禾 = 渠道[2];
  const 甲 = 学员[3];
  const 乙 = 学员[12];
  const 丙 = 学员[20];
  await db.customer.update({
    where: { id: 甲.id },
    data: { channelId: 小禾.id, attributionChannelId: 小禾.id, channelOwnerId: 小禾.channelOwnerId },
  });
  await db.customer.update({
    where: { id: 乙.id },
    data: { channelId: 小禾.id, referrerCustomerId: 甲.id, attributionChannelId: 小禾.id, channelOwnerId: 小禾.channelOwnerId },
  });
  await db.customer.update({
    where: { id: 丙.id },
    data: { channelId: 小禾.id, referrerCustomerId: 乙.id, attributionCustomerId: 甲.id, channelOwnerId: 小禾.channelOwnerId },
  });

  // ---------- 跟进记录 ----------
  let 跟进数 = 0;
  for (const [i, c] of 学员.entries()) {
    const 模板 = 跟进话术[c.状态] ?? [];
    for (const [j, [标题, 正文]] of 模板.entries()) {
      await db.followUp.create({
        data: {
          type: j === 0 ? "PHONE" : "MEETING",
          title: 标题,
          content: 正文,
          status: "已完成",
          duration: 300 + rnd(1500),
          occurredAt: 前(rnd(25) + j * 3, 9 + rnd(8)),
          customerId: c.id,
          ownerId: c.销售,
        },
      });
      跟进数++;
    }
    // 一部分人有「下次跟进计划」，首页盯盘清单才有东西可盯
    if (["跟进中", "意向较高"].includes(c.状态) && i % 2 === 0) {
      await db.followPlan.create({
        data: {
          subject: c.状态 === "意向较高" ? "确认报班与付款方式" : "回访课程疑问",
          plannedAt: 后(rnd(6) - 2, 14),
          method: "电话沟通",
          customerId: c.id,
          ownerId: c.销售,
        },
      });
    }
  }

  // ---------- 商机与合同 ----------
  let 商机数 = 0;
  for (const c of 学员.filter((x) => ["意向较高", "跟进中"].includes(x.状态))) {
    await db.opportunity.create({
      data: {
        name: "秋季雅思冲刺班",
        amount: [12800, 19800, 24800][rnd(3)],
        stage: c.状态 === "意向较高" ? "谈判审核" : "需求确认",
        probability: c.状态 === "意向较高" ? 70 : 30,
        expectedDealAt: 后(rnd(25) + 5),
        customerId: c.id,
        ownerId: c.销售,
      },
    });
    商机数++;
  }

  let 合同数 = 0;
  for (const [i, c] of 学员.filter((x) => x.状态 === "已签约").entries()) {
    await db.contract.create({
      data: { customerId: c.id, amount: [12800, 19800, 24800][i % 3], signedAt: 前(rnd(50) + 5) },
    });
    合同数++;
  }

  // ---------- 待办 ----------
  const 待办 = [
    ["把分期方案发给家长", 1],
    ["确认开课时间能否提前两周", 0],
    ["整理本周新签合同交财务", 2],
    ["回访上周到校参观的三位", 3],
    ["跟教学组确认加课安排", 1],
  ] as const;
  for (const [i, [标题, 偏移]] of 待办.entries()) {
    await db.task.create({
      data: {
        title: 标题,
        dueAt: 后(偏移, 18),
        done: false,
        customerId: 学员[i * 4].id,
        ownerId: i === 2 ? ownerUserId : 学员[i * 4].销售,
      },
    });
  }

  // ---------- 线索 ----------
  const 线索 = [
    { name: "郑同学", contact: "郑同学", phone: "13702003001", source: "官网注册", status: "待跟进", remark: "留言问寒假班" },
    { name: "何家长", contact: "何女士", phone: "13702003002", source: "电话咨询", status: "跟进中", remark: "孩子大三，问保研背景提升" },
    { name: "秋季教育展 A12", contact: "现场登记", phone: "13702003003", source: "展会", status: "待跟进", remark: "展会现场扫码留资 17 人，这是其中之一" },
    { name: "吴同学", contact: "吴同学", phone: "13702003004", source: "转介绍", status: "跟进中", remark: "老学员介绍" },
  ];
  for (const [i, l] of 线索.entries()) {
    await db.lead.create({ data: { ...l, ownerId: 销售[i % 销售.length].id } });
  }

  return {
    成员: 销售.length + 1,
    渠道: 渠道.length,
    学员: 学员.length,
    跟进: 跟进数,
    商机: 商机数,
    合同: 合同数,
    待办: 待办.length,
    线索: 线索.length,
  };
}
