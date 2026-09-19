/**
 * 导入落库与撤销。
 *
 * 纯函数那一半在 tests/import-plan.test.ts。这里钉的是**离不开数据库的三件事**，
 * 每一件做错的后果都比「导入失败」严重得多：
 *
 *   1. **重复的不许覆盖。** 一份表把人手录的备注刷掉，人不会立刻发现，
 *      发现时也说不清是什么时候没的。规矩：库里那格有值就一个字都不动。
 *   2. **一份表不改已有客户的归属。** 归属固化那条规则说「谁的数据没动，
 *      谁的归属就不变」，补一格备注不该让一个人静默换主。
 *   3. **撤销不能变成第二次事故。** 导进来之后有人跟过、改过的那条，
 *      撤销时留着并说清是哪几位。
 *
 * 外加一条这套 schema 特有的：phone **没有**唯一约束（家长和学生共用号码是真实场景）。
 * 库里同号两条时按手机号认不出人来，那就谁也不动——和重名不猜是同一条。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: mocks.userId, name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));
const mocks = { userId: "" };

import { 预览导入, 执行导入, 撤销批次, 最近批次, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

let 销售: string;

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", title: "管理员", role: "ADMIN", password: "x" } });
  销售 = u.id;
  mocks.userId = u.id;
});
afterAll(async () => { await prisma.$disconnect(); });

/** 一份 csv → 一份导入方案。列映射用自动猜的，和界面上默认的一样 */
function 方案(csv: string, 重复行: 导入方案["重复行"] = "跳过"): 导入方案 {
  const { 表头, 数据 } = 成表(解析CSV(csv));
  return { 表头, 数据, 映射: 猜列(表头, 字段表(DEFAULT_BUSINESS)), 重复行 };
}

const 建客户 = (name: string, phone: string, extra: Record<string, unknown> = {}) =>
  prisma.customer.create({ data: { name, phone, salesOwnerId: 销售, ...extra } });

describe("预览说的就是真正会发生的", () => {
  it("新建、跳过、进不了三个数各归各位", async () => {
    await 建客户("老客户", "13800000001");
    const r = await 预览导入(方案("姓名,手机号\n老客户,13800000001\n新客户,13800000002\n没号的,"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.预览.新建).toBe(1);
    expect(r.预览.跳过).toBe(1);
    expect(r.预览.进不了).toBe(1);
    expect(r.预览.挡下[0]).toMatchObject({ 行号: 4 });
  });

  it("表里同号的多行先合掉，预览上那个数不是「最多」而是就是", async () => {
    const r = await 预览导入(方案("姓名,手机号,备注\n张三,13800000001,\n张三,138 0000 0001,回电积极"));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.新建).toBe(1);
    expect(r.预览.合掉几行).toBe(1);

    const w = await 执行导入(方案("姓名,手机号,备注\n张三,13800000001,\n张三,138 0000 0001,回电积极"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    expect(w.新建, "预览说几条就是几条").toBe(1);
  });

  it("有问题的格子按「列+原值」归并，一个写法只让人改一次", async () => {
    const csv = "姓名,手机号,跟进状态\n" + Array.from({ length: 30 }, (_, i) => `张${i},1380000${String(i).padStart(4, "0")},已联系`).join("\n");
    const r = await 预览导入(方案(csv));
    if (!r.ok) throw new Error(r.error);
    expect(r.预览.待复核).toHaveLength(1);
    expect(r.预览.待复核[0]).toMatchObject({ 原值: "已联系", 几行: 30, 严重: "用默认" });
  });
});

describe("落库", () => {
  it("新建的那条销售负责人是导入的人本人，不从表里读", async () => {
    // 单人场景归属 = 导入人本人（2026-09-18 拍板），表里就算有这一列也不认
    const r = await 执行导入(方案("姓名,手机号,销售负责人\n张三,13800000001,别人"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.salesOwnerId).toBe(销售);
  });

  it("来源渠道对得上就挂上，顺带把归属算出来", async () => {
    const owner = await prisma.user.create({ data: { email: "o@x", name: "渠道负责人", role: "SALES", password: "x" } });
    const ch = await prisma.channel.create({ data: { name: "小红老师", channelOwnerId: owner.id } });
    const r = await 执行导入(方案("姓名,手机号,来源渠道\n张三,13800000001,小红老师"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.channelId).toBe(ch.id);
    expect(c.attributionChannelId).toBe(ch.id);
    expect(c.channelOwnerId).toBe(owner.id);
  });

  it("渠道名对不上就留空，人照样进得来", async () => {
    const r = await 执行导入(方案("姓名,手机号,来源渠道\n张三,13800000001,查无此渠道"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    expect(r.新建).toBe(1);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.channelId).toBeNull();
  });

  it("一格日期读不懂，其余字段照进——逐格留空，不整行拒绝", async () => {
    const r = await 执行导入(方案("姓名,手机号,预计签约,备注\n张三,13800000001,下周,回电积极"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.expectedSignAt).toBeNull();
    expect(c.remark).toBe("回电积极");
  });
});

describe("重复行：只补空，绝不覆盖", () => {
  it("库里那格有值就一个字都不动", async () => {
    await 建客户("张三", "13800000001", { remark: "人手写的备注", school: "老公司" });
    const r = await 执行导入(方案("姓名,手机号,备注,公司\n张三,13800000001,表里的备注,新公司", "补空"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.remark, "人录过的东西不许被一份表刷掉").toBe("人手写的备注");
    expect(c.school).toBe("老公司");
    expect(r.补空 + r.跳过).toBe(1);
  });

  it("空着的那格才填", async () => {
    await 建客户("张三", "13800000001", { remark: "人手写的备注" });
    await 执行导入(方案("姓名,手机号,备注,公司\n张三,13800000001,表里的备注,星辰科技", "补空"), "a.csv");
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.remark).toBe("人手写的备注");
    expect(c.school).toBe("星辰科技");
  });

  it("选「跳过」时一个字段都不碰", async () => {
    await 建客户("张三", "13800000001");
    const r = await 执行导入(方案("姓名,手机号,公司\n张三,13800000001,星辰科技", "跳过"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    expect(r.跳过).toBe(1);
    expect((await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } })).school).toBeNull();
  });

  it("补空不改归属——一份表不该让一个人静默换主", async () => {
    const owner = await prisma.user.create({ data: { email: "o@x", name: "原渠道负责人", role: "SALES", password: "x" } });
    const 另一位 = await prisma.user.create({ data: { email: "o2@x", name: "另一位", role: "SALES", password: "x" } });
    const 老渠道 = await prisma.channel.create({ data: { name: "老渠道", channelOwnerId: owner.id } });
    await prisma.channel.create({ data: { name: "新渠道", channelOwnerId: 另一位.id } });
    await 建客户("张三", "13800000001", { channelId: 老渠道.id, attributionChannelId: 老渠道.id, channelOwnerId: owner.id });

    await 执行导入(方案("姓名,手机号,来源渠道,备注\n张三,13800000001,新渠道,补一句", "补空"), "a.csv");
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.channelId, "来源渠道只在新建那条路上生效").toBe(老渠道.id);
    expect(c.channelOwnerId).toBe(owner.id);
    expect(c.remark, "该补的还是补上了").toBe("补一句");
  });

  it("库里同一个号码有两条时谁也不动：认不出人来就不猜", async () => {
    // phone 刻意没有唯一约束（家长和学生共用号码），所以这种情况是合法的
    await 建客户("学生", "13800000001");
    await 建客户("家长", "13800000001");
    const r = await 执行导入(方案("姓名,手机号,备注\n某人,13800000001,补一句", "补空"), "a.csv");
    if (!r.ok) throw new Error(r.error);
    expect(r.跳过).toBe(1);
    expect(r.补空).toBe(0);
    expect(await prisma.customer.count({ where: { remark: "补一句" } })).toBe(0);

    const p = await 预览导入(方案("姓名,手机号,备注\n某人,13800000001,补一句", "补空"));
    if (!p.ok) throw new Error(p.error);
    expect(p.预览.挡下[0].原因).toContain("不知道该算谁的");
  });
});

describe("整批撤销", () => {
  it("新建的那些删掉，批次标成已撤销，撤过的不能再撤", async () => {
    const w = await 执行导入(方案("姓名,手机号\n张三,13800000001\n李四,13800000002"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    expect(await prisma.customer.count()).toBe(2);

    const r = await 撤销批次(w.batchId);
    if (!r.ok) throw new Error(r.error);
    expect(r.删掉).toBe(2);
    expect(await prisma.customer.count()).toBe(0);

    const 再来 = await 撤销批次(w.batchId);
    expect(再来.ok).toBe(false);
  });

  it("补进去的那几格还原成空，人手写的那格不受影响", async () => {
    await 建客户("张三", "13800000001", { remark: "人手写的" });
    const w = await 执行导入(方案("姓名,手机号,备注,公司\n张三,13800000001,表里的,星辰科技", "补空"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    expect((await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } })).school).toBe("星辰科技");

    const r = await 撤销批次(w.batchId);
    if (!r.ok) throw new Error(r.error);
    expect(r.还原).toBe(1);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    expect(c.school).toBeNull();
    expect(c.remark, "这格本来就不是导入写的").toBe("人手写的");
  });

  it("导进来之后跟过一通电话的那位：撤销留着他，并说清是哪一位、为什么", async () => {
    // 撤销把人连带他的跟进记录一起删掉，那撤销本身就成了第二次事故
    const w = await 执行导入(方案("姓名,手机号\n张三,13800000001\n李四,13800000002"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    const 张三 = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    await prisma.followUp.create({ data: { customerId: 张三.id, ownerId: 销售, type: "电话", title: "首次电话", content: "聊了二十分钟" } });

    const r = await 撤销批次(w.batchId);
    if (!r.ok) throw new Error(r.error);
    expect(r.删掉).toBe(1);
    expect(r.没动).toEqual([{ name: "张三", 原因: "名下已经有跟进记录或商机了" }]);
    expect(await prisma.customer.count({ where: { id: 张三.id } })).toBe(1);
  });

  it("导进来之后被人改过档案的那位也留着", async () => {
    const w = await 执行导入(方案("姓名,手机号\n张三,13800000001"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    const c = await prisma.customer.findFirstOrThrow({ where: { phone: "13800000001" } });
    await prisma.customer.update({ where: { id: c.id }, data: { remark: "后来加的", updatedAt: new Date(Date.now() + 60_000) } });

    const r = await 撤销批次(w.batchId);
    if (!r.ok) throw new Error(r.error);
    expect(r.删掉).toBe(0);
    expect(r.没动[0].原因).toContain("改过");
  });

  it("导入和撤销各留一条痕", async () => {
    const w = await 执行导入(方案("姓名,手机号\n张三,13800000001"), "a.csv");
    if (!w.ok) throw new Error(w.error);
    await 撤销批次(w.batchId);
    const logs = await prisma.auditLog.findMany({ orderBy: { at: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["import", "import-revert"]));
  });

  it("批次列表按时间倒序，撤过的看得出来", async () => {
    const w = await 执行导入(方案("姓名,手机号\n张三,13800000001"), "b.csv");
    if (!w.ok) throw new Error(w.error);
    await 撤销批次(w.batchId);
    const [b] = await 最近批次();
    expect(b.fileName).toBe("b.csv");
    expect(b.created).toBe(1);
    expect(b.revertedAt).not.toBeNull();
  });
});
