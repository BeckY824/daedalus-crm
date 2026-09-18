/**
 * agent 手上的「清单类」只读工具。
 *
 * 2026-09-18 报上来的那条：问「我目前的渠道有哪些」，它调了
 * `query_metric(customers_count, groupBy=channel)`，拿回一行，然后想了 74 秒。
 * 根因不是模型笨，是**它够不着数据**——那时工具只有客户那条线加一个指标聚合，
 * 而按渠道分组的客户数里，**没带来过客户的渠道根本不出现**，答案必然是错的。
 *
 * 所以这组用例盯的是「够得着」：新建一个还没有任何客户的渠道，它也得出现在清单里。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { TOOLS } from "@/lib/agent/tools";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 我: { id: string };

const ctx = () => ({ userId: 我.id, userName: "甲", b: DEFAULT_BUSINESS, recordOffset: 0, proposals: [] });
const 用 = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`没有叫 ${name} 的工具`);
  return t;
};

beforeEach(async () => {
  await resetDb();
  我 = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "SALES", password: "x" } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("list_channels", () => {
  it("一个客户都没带来的渠道也要列出来——这正是原来答错的那一类", async () => {
    await prisma.channel.create({ data: { name: "小红书", channelOwnerId: 我.id } });
    const r = await 用("list_channels").run({}, ctx());
    const 名字 = (r.data as { 名称: string }[]).map((c) => c.名称);
    expect(名字).toEqual(["小红书"]);
    expect(r.summary).toContain("1 个渠道");
  });

  it("带出负责人、带来多少客户、这条链上的签约额", async () => {
    const ch = await prisma.channel.create({ data: { name: "老客户转介绍", channelOwnerId: 我.id } });
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000001", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: ch.id },
    });
    await prisma.contract.create({ data: { customerId: c.id, amount: 19800, signedAt: new Date() } });

    const [行] = (await 用("list_channels").run({}, ctx())).data as { 渠道负责人: string; 直接带来: number; 签约额: number }[];
    expect(行.渠道负责人).toBe("甲");
    expect(行.直接带来).toBe(1);
    expect(行.签约额).toBe(19800);
  });

  it("默认不列停用的，要看得显式要", async () => {
    await prisma.channel.create({ data: { name: "停了的", channelOwnerId: 我.id, active: false } });
    expect((await 用("list_channels").run({}, ctx())).data).toEqual([]);
    expect(((await 用("list_channels").run({ includeInactive: true }, ctx())).data as unknown[]).length).toBe(1);
  });
});

describe("list_leads", () => {
  beforeEach(async () => {
    await prisma.lead.createMany({
      data: [
        { name: "DDW-Display", contact: "Steven", phone: "13417558100", source: "其他", status: "待跟进", ownerId: 我.id },
        { name: "已经跟上的", source: "转介绍", status: "跟进中", ownerId: 我.id },
      ],
    });
  });

  it("线索是另一张表：列出来，带状态和来源", async () => {
    const r = await 用("list_leads").run({}, ctx());
    const d = r.data as { 总数: number; 线索: { 名称: string; 状态: string }[] };
    expect(d.总数).toBe(2);
    expect(d.线索.map((l) => l.名称).sort()).toEqual(["DDW-Display", "已经跟上的"]);
  });

  it("按状态筛", async () => {
    const d = (await 用("list_leads").run({ status: "跟进中" }, ctx())).data as { 总数: number };
    expect(d.总数).toBe(1);
  });

  it("按关键词能搜到联系人和电话", async () => {
    const d = (await 用("list_leads").run({ keyword: "Steven" }, ctx())).data as { 线索: { 名称: string }[] };
    expect(d.线索[0].名称).toBe("DDW-Display");
  });
});

describe("list_opportunities", () => {
  beforeEach(async () => {
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000002", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.opportunity.createMany({
      data: [
        { name: "大单", customerId: c.id, amount: 200000, stage: "方案报价", status: "OPEN", probability: 60, ownerId: 我.id },
        { name: "小单", customerId: c.id, amount: 5000, stage: "初步沟通", status: "OPEN", probability: 20, ownerId: 我.id },
        { name: "丢了的", customerId: c.id, amount: 90000, stage: "谈判审核", status: "LOST", probability: 0, ownerId: 我.id },
      ],
    });
  });

  it("默认只列进行中的，按金额从大到小", async () => {
    const r = await 用("list_opportunities").run({}, ctx());
    const d = r.data as { 总数: number; 商机: { 名称: string; 金额: number }[] };
    expect(d.商机.map((o) => o.名称)).toEqual(["大单", "小单"]);
    expect(r.summary).toContain("205000");
  });

  it("要丢单的得显式要——不然「手上有哪些单子」会把丢掉的也算进去", async () => {
    const d = (await 用("list_opportunities").run({ status: "LOST" }, ctx())).data as { 商机: { 名称: string; 状态: string }[] };
    expect(d.商机.map((o) => o.名称)).toEqual(["丢了的"]);
    expect(d.商机[0].状态).toBe("丢单");
  });
});

describe("search_followups", () => {
  beforeEach(async () => {
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000003", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.followUp.createMany({
      data: [
        { customerId: c.id, ownerId: 我.id, type: "PHONE", title: "", content: "问了预算，说年底才批", status: "已完成", occurredAt: new Date() },
        { customerId: c.id, ownerId: 我.id, type: "PHONE", title: "", content: "寄了样品", status: "已完成", occurredAt: new Date() },
      ],
    });
  });

  it("跨客户按词找，带出是谁、什么时候", async () => {
    const r = await 用("search_followups").run({ keyword: "预算" }, ctx());
    const d = r.data as { 总数: number; 记录: { 客户: string; 内容: string }[] };
    expect(d.总数).toBe(1);
    expect(d.记录[0].客户).toBe("张三");
    expect(d.记录[0].内容).toContain("年底才批");
  });

  it("没给关键词时明确报错，不是把全库倒出来", async () => {
    const r = await 用("search_followups").run({}, ctx());
    expect((r.data as { error?: string }).error).toBeTruthy();
  });
});

/**
 * 按渠道筛客户。
 *
 * 2026-09-18 报上来的第二条：问「小红这个渠道里有谁」，它答不出来。
 * 根因和上面那条一样是「够不着」——list_channels 只给每个渠道**多少**客户，
 * search_customers 的关键词又只匹配姓名/学校/专业/备注，
 * 于是「某个渠道下面是哪些人」这个最普通的问题，全套工具里没有一个入口。
 * 数据一直都在（Customer.channelId），是工具没开这个口。
 */
describe("search_customers 按渠道筛", () => {
  const 建渠道客户 = async (渠道名: string, 客户名: string[]) => {
    const ch = await prisma.channel.create({ data: { name: 渠道名, channelOwnerId: 我.id } });
    for (const n of 客户名) {
      await prisma.customer.create({
        data: { name: n, phone: `138${Math.random().toString().slice(2, 10)}`, followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: ch.id },
      });
    }
    return ch;
  };

  it("给渠道名，列出这个渠道带来的人——别的渠道的不混进来", async () => {
    await 建渠道客户("小红", ["张三", "李四"]);
    await 建渠道客户("小红书", ["王五"]);
    const r = await 用("search_customers").run({ channelName: "小红书" }, ctx());
    const d = r.data as { total: number; customers: { name: string; channel: string | null }[] };
    expect(d.total).toBe(1);
    expect(d.customers.map((c) => c.name)).toEqual(["王五"]);
    expect(d.customers[0].channel).toBe("小红书");
  });

  it("只给 channelName 就够了——原来不给 query 会被当成「没给条件」挡回去", async () => {
    await 建渠道客户("老客户转介绍", ["赵六"]);
    const r = await 用("search_customers").run({ channelName: "老客户转介绍" }, ctx());
    expect((r.data as { error?: string }).error).toBeFalsy();
    expect(r.summary).toContain("渠道 老客户转介绍");
    expect(r.summary).toContain("赵六");
  });

  it("没有渠道的客户不会被「空渠道名」捞出来", async () => {
    await prisma.customer.create({
      data: { name: "散客", phone: "13900000001", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    const r = await 用("search_customers").run({ channelName: "小红" }, ctx());
    expect((r.data as { total: number }).total).toBe(0);
  });

  it("渠道和跟进状态能叠着筛——两个条件都得生效，不是只认一个", async () => {
    const 小红 = await 建渠道客户("小红", ["张三"]);
    const 别家 = await 建渠道客户("别家", []);
    // 李四：渠道对、状态对 —— 唯一该命中的
    await prisma.customer.create({
      data: { name: "李四", phone: "13900000002", followStatus: "已签约", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: 小红.id },
    });
    // 王五：状态对但渠道不对 —— 光按状态筛会把它也捞出来，这一条就是钉这个的
    await prisma.customer.create({
      data: { name: "王五", phone: "13900000003", followStatus: "已签约", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: 别家.id },
    });
    const r = await 用("search_customers").run({ channelName: "小红", followStatus: "已签约" }, ctx());
    const d = r.data as { total: number; customers: { name: string }[] };
    expect(d.total).toBe(1);
    expect(d.customers[0].name).toBe("李四");
  });
});

/**
 * 口径一致性。
 *
 * Customer 上有**两个**渠道字段：`channelId`（推荐链最顶端，所有后代继承）和
 * `attributionChannelId`（往上第二代的归属口径，算提成用的）。两个数天然不一样。
 * list_channels 的「直接带来」、query_metric 的 groupBy=channel、
 * search_customers 的 channelName——三处现在都走 `channelId`。
 * 哪天有人把其中一处改成归属口径，用户就会看到「渠道清单说 3 个，点进去只有 2 个」。
 */
describe("渠道口径：清单上的数 = 点进去的人", () => {
  it("list_channels 报几个，search_customers 就得列出几个", async () => {
    const ch = await prisma.channel.create({ data: { name: "小红", channelOwnerId: 我.id } });
    const 张三 = await prisma.customer.create({
      data: { name: "张三", phone: "13800000011", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: ch.id },
    });
    // 转介绍来的后代：链顶仍是小红，所以「小红渠道里有谁」该把他算上
    await prisma.customer.create({
      data: { name: "李四", phone: "13800000012", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, channelId: ch.id, referrerCustomerId: 张三.id },
    });

    const [清单] = (await 用("list_channels").run({}, ctx())).data as { 名称: string; 直接带来: number }[];
    const 名单 = (await 用("search_customers").run({ channelName: "小红" }, ctx())).data as { total: number };
    expect(清单.直接带来).toBe(2);
    expect(名单.total).toBe(清单.直接带来);
  });
});

/**
 * 2026-09-18 第三轮：把「用户会问但工具够不着」的问题一次探完。
 *
 * 探针跑下来六问全空：「乙手上有哪些客户」「大三的有哪些人」「还在犹豫的有谁」
 * 「张三家长的微信」——数据全都在库里，是 search_customers / get_customer 没开口子。
 * 这类洞的共同形状是：**query_metric 能按这个维度分组，名单却筛不了它**——
 * 说明它本来就是一等维度，只是列表那条线漏了。
 */
describe("够得着：探针里答不出来的那几问", () => {
  const 建 = async (n: string, 额外: Record<string, unknown> = {}) =>
    prisma.customer.create({
      data: { name: n, phone: `138${Math.random().toString().slice(2, 10)}`, followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, ...额外 },
    });

  it("「乙手上有哪些客户」——按负责人姓名筛，不是只有 mine", async () => {
    const 乙 = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
    await 建("张三", { salesOwnerId: 乙.id });
    await 建("李四");
    const r = await 用("search_customers").run({ ownerName: "乙" }, ctx());
    const d = r.data as { total: number; customers: { name: string }[] };
    expect(d.total).toBe(1);
    expect(d.customers[0].name).toBe("张三");
  });

  it("「大三的有哪些人」——年级也得进关键词，原来只匹配姓名/学校/专业/备注", async () => {
    await 建("张三", { grade: "大三" });
    await 建("李四", { grade: "大四" });
    const d = (await 用("search_customers").run({ query: "大三" }, ctx())).data as { total: number; customers: { name: string }[] };
    expect(d.total).toBe(1);
    expect(d.customers[0].name).toBe("张三");
  });

  it("「还在犹豫的有谁」——决策状态能筛（query_metric 早就能按它分组了）", async () => {
    await 建("张三", { decisionStatus: "与家人商议" });
    await 建("李四", { decisionStatus: "已决定报名" });
    const d = (await 用("search_customers").run({ decisionStatus: "与家人商议" }, ctx())).data as { total: number; customers: { name: string }[] };
    expect(d.total).toBe(1);
    expect(d.customers[0].name).toBe("张三");
  });

  it("决策状态认这家自己的叫法——业务配置改过名字也筛得到", async () => {
    await 建("张三", { decisionStatus: "与家人商议" });
    const b = { ...DEFAULT_BUSINESS, statusLabels: { ...DEFAULT_BUSINESS.statusLabels, 与家人商议: "内部讨论" } };
    const d = (await 用("search_customers").run({ decisionStatus: "内部讨论" }, { ...ctx(), b })).data as { total: number };
    expect(d.total).toBe(1);
  });

  it("「张三家长的微信是多少」——联系人是另一张表，档案里得带上", async () => {
    const c = await 建("张三");
    await prisma.contact.create({ data: { name: "张妈妈", position: "母亲", phone: "13900000009", wechat: "zhangma", customerId: c.id, isPrimary: true } });
    const d = (await 用("get_customer").run({ id: c.id }, ctx())).data as { contacts: string[] };
    expect(d.contacts).toHaveLength(1);
    expect(d.contacts[0]).toContain("张妈妈");
    expect(d.contacts[0]).toContain("zhangma");
    expect(d.contacts[0]).toContain("主要联系人");
  });
});

/**
 * list_contracts：签约名单。
 *
 * 签约是这个 CRM 里最重要的事件，原来却只有聚合没有名单——
 * 问「这个月签了哪几单、分别是谁」，query_metric 只能回 {全部: 19800}。
 * 老板问这句的频率不会低于问渠道。
 */
describe("list_contracts", () => {
  let 乙: { id: string };
  const 签 = async (客户: string, 金额: number, 日子: string, 额外: Record<string, unknown> = {}) => {
    const c = await prisma.customer.create({
      data: { name: 客户, phone: `138${Math.random().toString().slice(2, 10)}`, followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, ...额外 },
    });
    await prisma.contract.create({ data: { customerId: c.id, amount: 金额, signedAt: new Date(`${日子}T10:00:00`) } });
    return c;
  };

  beforeEach(async () => {
    乙 = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
  });

  it("「这个月签了哪几单、分别是谁」——给名单，不是给一个总额", async () => {
    await 签("张三", 19800, "2026-09-03");
    await 签("李四", 29800, "2026-09-20");
    await 签("旧的", 10000, "2026-08-15");
    const r = await 用("list_contracts").run({ from: "2026-09-01", to: "2026-09-30" }, ctx());
    const d = r.data as { 总数: number; 总额: number; 签约: { 客户: string; 金额: number; 签约日: string }[] };
    expect(d.总数).toBe(2);
    expect(d.总额).toBe(49600);
    expect(d.签约.map((c) => c.客户)).toEqual(["李四", "张三"]); // 按签约日从近到远
    expect(d.签约[0].签约日).toBe("2026-09-20");
  });

  it("to 含当天——说「到 9 月 30 日」，那天签的也算", async () => {
    await 签("压线的", 5000, "2026-09-30");
    const d = (await 用("list_contracts").run({ from: "2026-09-01", to: "2026-09-30" }, ctx())).data as { 总数: number };
    expect(d.总数).toBe(1);
  });

  it("按负责人、按渠道筛", async () => {
    const ch = await prisma.channel.create({ data: { name: "小红", channelOwnerId: 我.id } });
    await 签("张三", 19800, "2026-09-03", { salesOwnerId: 乙.id });
    await 签("李四", 29800, "2026-09-04", { channelId: ch.id });
    const 按人 = (await 用("list_contracts").run({ ownerName: "乙" }, ctx())).data as { 总数: number; 签约: { 客户: string }[] };
    expect(按人.签约.map((c) => c.客户)).toEqual(["张三"]);
    const 按渠道 = (await 用("list_contracts").run({ channelName: "小红" }, ctx())).data as { 签约: { 客户: string; 渠道: string | null }[] };
    expect(按渠道.签约.map((c) => c.客户)).toEqual(["李四"]);
    expect(按渠道.签约[0].渠道).toBe("小红");
  });

  it("超过 30 笔时，总额算的是全量，不是列出来那几行的和", async () => {
    for (let i = 0; i < 32; i++) await 签(`客户${i}`, 1000, "2026-09-10");
    const d = (await 用("list_contracts").run({}, ctx())).data as { 总数: number; 已列出: number; 总额: number };
    expect(d.总数).toBe(32);
    expect(d.已列出).toBe(30);
    expect(d.总额).toBe(32000); // 不是 30000
  });

  it("from/to 写反了自动换过来，不是回一个空名单让人以为真没签", async () => {
    await 签("张三", 19800, "2026-09-10");
    const d = (await 用("list_contracts").run({ from: "2026-09-30", to: "2026-09-01" }, ctx())).data as { 总数: number };
    expect(d.总数).toBe(1);
  });

  it("日期不合法就明说，不是当没给然后把全库倒出来", async () => {
    await 签("张三", 19800, "2026-09-10");
    const r = await 用("list_contracts").run({ from: "上个月" }, ctx());
    expect((r.data as { error?: string }).error).toBeTruthy();
  });

  it("这段时间没签就明说没有", async () => {
    await 签("张三", 19800, "2026-09-10");
    const r = await 用("list_contracts").run({ from: "2026-10-01", to: "2026-10-31" }, ctx());
    expect((r.data as { 总数: number }).总数).toBe(0);
    expect(r.summary).toContain("没有");
  });
});

/**
 * get_customer 认姓名。
 *
 * schema 从 0.37.0（e2d915d）起就声明了 name 参数，实现却一直只认 id——
 * 模型照着 schema 传姓名，拿回「客户不存在」，是对着库里明明有的人说没有。
 * 这条漏出去没人发现，因为两份清单（tools.ts 的 args 样例 / schemas.ts）没人对；
 * 现在 tests/agent-schemas.test.ts 会把这类不一致挡在 CI。
 */
describe("get_customer 直接给姓名", () => {
  const 建 = async (n: string, 额外: Record<string, unknown> = {}) =>
    prisma.customer.create({
      data: { name: n, phone: `138${Math.random().toString().slice(2, 10)}`, followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id, ...额外 },
    });

  it("只给姓名，唯一命中就直接读档案", async () => {
    await 建("张三", { school: "武汉大学" });
    const r = await 用("get_customer").run({ name: "张三" }, ctx());
    const d = r.data as { name?: string; profile?: string };
    expect(d.name).toBe("张三");
    expect(d.profile).toContain("武汉大学");
  });

  it("重名不猜——把候选摆出来让人挑", async () => {
    await 建("张三", { school: "武汉大学" });
    await 建("张三", { school: "华中科技大学" });
    const r = await 用("get_customer").run({ name: "张三" }, ctx());
    const d = r.data as { 需要挑一位?: { 姓名: string; 学校: string }[] };
    expect(d.需要挑一位).toHaveLength(2);
    expect(r.summary).toContain("2 位");
  });

  it("查无此人就明说，不是回一个空档案", async () => {
    const r = await 用("get_customer").run({ name: "查无此人" }, ctx());
    expect((r.data as { error?: string }).error).toBeTruthy();
  });

  it("id 和 name 都没给，明确报错", async () => {
    const r = await 用("get_customer").run({}, ctx());
    expect((r.data as { error?: string }).error).toBeTruthy();
  });
});

/**
 * 2026-09-18 第四轮：把剩下的几个缺口做完。
 */
describe("get_my_plans：计划和待办是两张表，得一起给", () => {
  it("「我有哪些待办」——Task 表原来够不着，只能逐个 get_customer", async () => {
    const c = await prisma.customer.create({
      data: { name: "张三", phone: "13800000021", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.followPlan.create({ data: { subject: "回访", plannedAt: new Date("2026-09-20T10:00:00"), customerId: c.id, ownerId: 我.id } });
    await prisma.task.create({ data: { title: "寄资料", dueAt: new Date("2026-09-19T10:00:00"), customerId: c.id, ownerId: 我.id } });

    const r = await 用("get_my_plans").run({}, ctx());
    const d = r.data as { 跟进计划: { subject: string }[]; 待办: { title: string }[] };
    expect(d.跟进计划.map((x) => x.subject)).toEqual(["回访"]);
    expect(d.待办.map((x) => x.title)).toEqual(["寄资料"]);
    expect(r.summary).toContain("1 条计划");
    expect(r.summary).toContain("1 条待办");
  });

  it("逾期的要标出来并且在 summary 里说一声", async () => {
    const c = await prisma.customer.create({
      data: { name: "李四", phone: "13800000022", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.task.create({ data: { title: "早该做的", dueAt: new Date("2020-01-01T10:00:00"), customerId: c.id, ownerId: 我.id } });
    const r = await 用("get_my_plans").run({}, ctx());
    expect((r.data as { 待办: { overdue: boolean }[] }).待办[0].overdue).toBe(true);
    expect(r.summary).toContain("逾期");
  });

  it("做完的不算，别人的也不算", async () => {
    const 乙 = await prisma.user.create({ data: { email: "yi2", name: "乙", title: "销售", role: "SALES", password: "x" } });
    const c = await prisma.customer.create({
      data: { name: "王五", phone: "13800000023", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.task.create({ data: { title: "已完成的", customerId: c.id, ownerId: 我.id, done: true } });
    await prisma.task.create({ data: { title: "乙的", customerId: c.id, ownerId: 乙.id } });
    const d = (await 用("get_my_plans").run({}, ctx())).data as { 待办: unknown[] };
    expect(d.待办).toEqual([]);
  });
});

describe("list_users：团队名单", () => {
  it("一个客户都还没有的人也要列出来——和当初「没带来客户的渠道」是同一个坑", async () => {
    await prisma.user.create({ data: { email: "xin", name: "新来的", title: "销售", role: "SALES", password: "x" } });
    const d = (await 用("list_users").run({}, ctx())).data as { 姓名: string; 负责客户: number }[];
    expect(d.map((u) => u.姓名).sort()).toEqual(["新来的", "甲"].sort());
    expect(d.find((u) => u.姓名 === "新来的")!.负责客户).toBe(0);
  });

  it("带出岗位、角色、手上多少客户、负责几个渠道", async () => {
    await prisma.customer.create({
      data: { name: "张三", phone: "13800000024", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我.id },
    });
    await prisma.channel.create({ data: { name: "小红", channelOwnerId: 我.id } });
    const [甲] = (await 用("list_users").run({}, ctx())).data as { 姓名: string; 岗位: string; 角色: string; 负责客户: number; 负责渠道: number }[];
    expect(甲).toMatchObject({ 姓名: "甲", 岗位: "销售", 角色: "销售", 负责客户: 1, 负责渠道: 1 });
  });

  it("默认不列已停用的，要看得显式要", async () => {
    await prisma.user.create({ data: { email: "zou", name: "走了的", title: "销售", role: "SALES", password: "x", active: false } });
    const 默认 = (await 用("list_users").run({}, ctx())).data as unknown[];
    const 全部 = (await 用("list_users").run({ includeInactive: true }, ctx())).data as { 状态: string }[];
    expect(默认.length).toBe(1);
    expect(全部.length).toBe(2);
    expect(全部.find((u) => u.状态 === "已停用")).toBeTruthy();
  });
});
