import type { PrismaClient } from "@/generated/prisma";

/**
 * 网页那个共享工作区的演示数据。**通用销售口径**（公司 / 职位 / 行业），
 * 和默认的业务配置对得上——2026-09-18 之前这里是一整套教培招生数据，
 * 而默认措辞已经改成通用，一打开全是「王同学 / 华中科技大学 / 大三」就成了两张皮。
 *
 * 这不是测试夹具，是给陌生人看的第一印象，所以标准不一样：
 * 测试数据只要能触发分支，演示数据要让人相信「这机构真的在用」。
 * 空列表、三条记录、全是「测试1 测试2」的页面比没有演示更劝退。
 *
 * 所有日期都相对 now 生成——写死日期会让它一天比一天陈旧，
 * 半个月后打开全是「3 周前跟进」，看着像个废弃的系统。
 * 灌数据和重置见 scripts/seed-shared.ts。
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

const 公司 = ["星辰科技", "远望信息", "合德智造", "南屿文化", "长风建设", "锐维电子", "济安生物", "白羽设计", "通元商贸", "沐野数据"];
const 行业 = ["IT互联网", "软件服务", "智能制造", "文化传媒", "建筑工程", "电子科技", "生物医药", "设计服务", "商贸流通", "数据服务"];
const 职位 = ["创始人 / 老板", "高管", "部门负责人", "经办人", "技术"];
const 姓 = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "马", "朱", "胡", "林", "郭", "何"];
const 名 = ["思远", "浩然", "梓涵", "欣怡", "俊杰", "雨桐", "子轩", "诗琪", "宇航", "佳怡", "泽宇", "可欣", "博文", "雅婷", "天佑", "梦洁", "睿智", "静怡"];

/**
 * 取一个不重样的姓名。
 *
 * 姓按序走，名用互质步长错开，再按轮次再偏移一次——前者保证 38 个人不撞名，
 * 后者保证不会出现「王思远 李思远 张思远」这种一眼假的整齐排列。
 * 撞名不只是难看：演示区里出现 3 个「王思远」时 AI 会正确地要求消歧，
 * 但看演示的人只会觉得这系统在乱造数据。
 */
function 取名(i: number): string {
  const n = 姓.length;
  return `${姓[i % n]}${名[(i * 5 + Math.floor(i / n) * 7) % 名.length]}`;
}

const 跟进状态 = ["待跟进", "跟进中", "意向较高", "已签约", "暂缓"];
const 决策状态 = ["了解中", "与家人商议", "对比中", "已决定报名", "暂不考虑"];

const 跟进话术: Record<string, [string, string][]> = {
  待跟进: [["首次来电咨询", "官网留了电话，问我们这套东西多少钱、几个人能用。说还在比几家，让我这周内再联系一次。"]],
  跟进中: [
    ["电话回访", "介绍了部署方式和数据放在哪。对方最在意数据不能出他们内网，我说清楚了可以完全私有化，对方表示这是加分项。"],
    ["微信答疑", "发了功能清单和一份同行业的用法说明。经办人看了比较认可，说要拿给他们负责人过一遍。"],
  ],
  意向较高: [
    ["上门演示", "他们四个人一起听的，演示了从线索到签约那条线。当场问了能不能按年付、能不能加字段，我给了两种方案。临走时说这周内给答复。"],
    ["价格沟通", "对方拿了另一家的报价来比。我们贵三成，但不限人数、不按坐席收。逐项算完之后对方认可，卡在预算年度上，希望能挪到下季度。"],
  ],
  已签约: [
    ["签约确认", "线下签完合同，首付款已收。约定下周一开始导数据，对接人是他们的技术。"],
    ["交付跟进", "第一周用下来，反馈字段名想改成他们自己的叫法。已经教了他们在业务配置里自己改。"],
  ],
  暂缓: [["暂缓说明", "对方今年预算已经用完，采购推到明年一季度。已备注，明年 1 月再联系。"]],
};

export type 条数 = Record<string, number>;

/**
 * 往一个刚建好的工作区里灌演示数据。
 * ownerUserId 是 createWorkspace 建的那个管理员，这里只用它当「销售主管」，
 * 不给他挂客户——业绩排行榜按销售口径算，管理员混进去数字会怪。
 */
export async function 灌演示数据(db: PrismaClient, ownerUserId: string): Promise<条数> {
  const rnd = 取号(20260914);

  // ---------- 同事 ----------
  const 销售 = await Promise.all(
    [
      { email: "demo-sales-1@qiming.local", name: "张沁", title: "高级销售经理" },
      { email: "demo-sales-2@qiming.local", name: "李蔚然", title: "销售经理" },
      { email: "demo-sales-3@qiming.local", name: "陈牧", title: "销售经理" },
      { email: "demo-sales-4@qiming.local", name: "周昱", title: "销售经理" },
    ].map((u) => db.user.create({ data: { ...u, role: "SALES", password: "!demo" } })),
  );

  // ---------- 渠道 ----------
  const 渠道 = await Promise.all(
    [
      { name: "林工（行业协会）", phone: "13701002001", remark: "协会秘书处，每年两次会员活动带资源", 负责: 0 },
      { name: "方舟咨询", phone: "13701002002", remark: "管理咨询公司，互相导流", 负责: 1 },
      { name: "老客户·小禾科技", phone: "13701002003", remark: "用了两年，主动帮忙推荐同行", 负责: 0 },
      { name: "行业交流群", phone: "13701002004", remark: "客户自发建的群，问题多、线索也多", 负责: 2 },
    ].map((c) =>
      db.channel.create({
        data: { name: c.name, phone: c.phone, remark: c.remark, channelOwnerId: 销售[c.负责].id },
      }),
    ),
  );

  // ---------- 客户 ----------
  // 状态分布刻意不均匀：真实漏斗是上宽下窄的，五档各占 20% 一眼就假
  const 分布 = [
    ...Array(8).fill("待跟进"),
    ...Array(11).fill("跟进中"),
    ...Array(7).fill("意向较高"),
    ...Array(9).fill("已签约"),
    ...Array(3).fill("暂缓"),
  ];

  const 客户: { id: string; 状态: string; 销售: string }[] = [];
  for (let i = 0; i < 分布.length; i++) {
    const 状态 = 分布[i];
    const s = 销售[i % 销售.length];
    const ch = i % 3 === 0 ? 渠道[rnd(渠道.length)] : null;
    const 建于 = 前(分布.length - i + rnd(5));

    const c = await db.customer.create({
      data: {
        name: 取名(i),
        phone: `138${String(20000000 + i * 137).slice(0, 8)}`,
        school: 公司[rnd(公司.length)],
        major: 行业[rnd(行业.length)],
        grade: 职位[rnd(职位.length)],
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
    客户.push({ id: c.id, 状态, 销售: s.id });
  }

  // ---------- 推荐链：产品的差异点，演示里必须看得见 ----------
  // 小禾（渠道）→ 甲 → 乙 → 丙：归属往上两代，不足两代取链条顶端
  const 小禾 = 渠道[2];
  const 甲 = 客户[3];
  const 乙 = 客户[12];
  const 丙 = 客户[20];
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
  for (const [i, c] of 客户.entries()) {
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
          subject: c.状态 === "意向较高" ? "确认采购与付款方式" : "回访上次演示留下的问题",
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
  for (const c of 客户.filter((x) => ["意向较高", "跟进中"].includes(x.状态))) {
    await db.opportunity.create({
      data: {
        name: "年度授权 + 部署",
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
  for (const [i, c] of 客户.filter((x) => x.状态 === "已签约").entries()) {
    await db.contract.create({
      data: { customerId: c.id, amount: [12800, 19800, 24800][i % 3], signedAt: 前(rnd(50) + 5) },
    });
    合同数++;
  }

  // ---------- 待办 ----------
  const 待办 = [
    ["把分期方案发给对方财务", 1],
    ["确认能不能挪到下季度预算", 0],
    ["整理本周新签合同交财务", 2],
    ["回访上周来看过演示的三家", 3],
    ["跟技术确认私有化部署的时间", 1],
  ] as const;
  for (const [i, [标题, 偏移]] of 待办.entries()) {
    await db.task.create({
      data: {
        title: 标题,
        dueAt: 后(偏移, 18),
        done: false,
        customerId: 客户[i * 4].id,
        ownerId: i === 2 ? ownerUserId : 客户[i * 4].销售,
      },
    });
  }

  // ---------- 线索 ----------
  const 线索 = [
    { name: "郑工（沐野数据）", contact: "郑工", phone: "13702003001", source: "官网注册", status: "待跟进", remark: "留言问私有化部署" },
    { name: "何女士（白羽设计）", contact: "何女士", phone: "13702003002", source: "电话咨询", status: "跟进中", remark: "十来个人的团队，问按年付" },
    { name: "秋季行业展 A12", contact: "现场登记", phone: "13702003003", source: "展会", status: "待跟进", remark: "展会现场扫码留资 17 家，这是其中之一" },
    { name: "吴总（通元商贸）", contact: "吴总", phone: "13702003004", source: "转介绍", status: "跟进中", remark: "老客户介绍" },
  ];
  for (const [i, l] of 线索.entries()) {
    await db.lead.create({ data: { ...l, ownerId: 销售[i % 销售.length].id } });
  }

  return {
    成员: 销售.length + 1,
    渠道: 渠道.length,
    客户: 客户.length,
    跟进: 跟进数,
    商机: 商机数,
    合同: 合同数,
    待办: 待办.length,
    线索: 线索.length,
  };
}
