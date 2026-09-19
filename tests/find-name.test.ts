/**
 * 「找一个人」不能只认客户表。
 *
 * 2026-09-19 首页那一问：「明杰哥的电话是多少」——明杰哥是一个**渠道**，
 * 客户库里当然没有，于是连问两次都是「没找到，你给个更完整的姓名我再查一次」。
 * 页面上下文只在渠道页上盖住了这个洞，而首页正是这个 agent 的主场。
 *
 * 所以搜空这件事本身要带上答案：另外四张有人名的表顺手查一遍，连电话一起给回去。
 * 这一组钉的就是「搜空之后手上有没有线索」。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 名字在别处, 别处说法, 别处附件 } from "@/lib/agent/find-name";

const 原样 = (p: string | null) => p;

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("名字在别处", () => {
  it("渠道表里的人找得到，连电话一起给", async () => {
    const u = await prisma.user.create({ data: { email: "o", name: "负责人", title: "销售", role: "SALES", password: "x" } });
    await prisma.channel.create({ data: { name: "明杰哥", phone: "13900008888", remark: "外贸方面的资源", channelOwnerId: u.id } });
    const r = await 名字在别处("明杰哥", 原样);
    expect(r).toHaveLength(1);
    expect(r[0].表).toBe("渠道");
    expect(r[0].记录[0]).toMatchObject({ 名称: "明杰哥", 电话: "13900008888" });
    // 要更多时该用哪个工具，也一并说清
    expect(r[0].怎么查).toContain("list_channels");
  });

  it("联系人、线索、成员三张表也认", async () => {
    const u = await prisma.user.create({ data: { email: "z", name: "周经理", title: "经理", role: "SALES", password: "x" } });
    const c = await prisma.customer.create({ data: { name: "某客户", phone: "13800000001", salesOwnerId: u.id } });
    await prisma.contact.create({ data: { name: "钱阿姨", phone: "13700000002", customerId: c.id } });
    await prisma.lead.create({ data: { name: "孙氏贸易", contact: "孙老板", phone: "13600000003", status: "待跟进", ownerId: u.id } });

    expect((await 名字在别处("钱阿姨", 原样))[0]).toMatchObject({ 表: "联系人" });
    // 线索两个人名字段都要匹配：线索名称本身，和它的联系人
    expect((await 名字在别处("孙老板", 原样))[0]).toMatchObject({ 表: "线索" });
    expect((await 名字在别处("孙氏贸易", 原样))[0]).toMatchObject({ 表: "线索" });
    expect((await 名字在别处("周经理", 原样))[0]).toMatchObject({ 表: "团队成员" });
  });

  it("成员那条不给电话——那是同事的私人号码，不是客户资料", async () => {
    await prisma.user.create({ data: { email: "z", name: "周经理", title: "经理", role: "SALES", password: "x" } });
    const r = await 名字在别处("周经理", 原样);
    expect(JSON.stringify(r[0].记录)).not.toContain("电话");
  });

  it("号码走脱敏器——共享工作区里不能从这条路绕过去拿到完整号码", async () => {
    const u = await prisma.user.create({ data: { email: "o", name: "负责人", title: "销售", role: "SALES", password: "x" } });
    await prisma.channel.create({ data: { name: "明杰哥", phone: "13900008888", channelOwnerId: u.id } });
    const r = await 名字在别处("明杰哥", (p) => (p ? `${p.slice(0, 3)}****${p.slice(-4)}` : null));
    expect(r[0].记录[0].电话).toBe("139****8888");
  });

  it("一个名字同时在两张表里，两张都给出来", async () => {
    const u = await prisma.user.create({ data: { email: "z", name: "明杰", title: "销售", role: "SALES", password: "x" } });
    await prisma.channel.create({ data: { name: "明杰哥", phone: "13900008888", channelOwnerId: u.id } });
    const r = await 名字在别处("明杰", 原样);
    expect(r.map((x) => x.表).sort()).toEqual(["团队成员", "渠道"]);
  });

  it("谁都没命中就返回空，不硬凑", async () => {
    expect(await 名字在别处("查无此名", 原样)).toEqual([]);
    expect(await 名字在别处("", 原样)).toEqual([]);
  });
});

describe("别处说法", () => {
  it("没命中时是空串——不能让「没有」那句话后面多出一截废话", () => {
    expect(别处说法("张三", [])).toBe("");
  });

  it("命中时直接指着答案说，不是「你去别处看看」", () => {
    const 说 = 别处说法("明杰哥", [{ 表: "渠道", 条数: 1, 记录: [{ 名称: "明杰哥", 电话: "139" }], 怎么查: "list_channels" }]);
    expect(说).toContain("渠道");
    expect(说).toContain("明杰哥");
    // 这一句是给模型看的：别再反过来问用户
    expect(说).toContain("不用再问用户");
  });
});

describe("别处附件（进 data 的那一段——模型只看得见 data）", () => {
  it("没命中返回 null，data 里不多出任何东西", () => {
    expect(别处附件("张三", [])).toBeNull();
  });

  it("命中时带上记录和一句「接下来该怎么办」", () => {
    const 附 = 别处附件("明杰哥", [{ 表: "渠道", 条数: 1, 记录: [{ 名称: "明杰哥", 电话: "139" }], 怎么查: "list_channels" }])!;
    expect(附.这个名字在别的表里).toHaveLength(1);
    // 这句必须在 data 里：summary 只进过程条，写在那儿模型一个字都看不到
    expect(String(附.该怎么办)).toContain("不要反过来让用户");
  });
});
