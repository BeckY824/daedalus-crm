/**
 * 推荐归属算法测试。
 *
 * 这是全系统最高危的逻辑：算错了不会报错、不会白屏，
 * 只会把提成算到别人头上，可能几个月后对账才发现。
 *
 * 规则：
 *   推荐人   —— 逐级如实记录
 *   渠道归属 —— 推荐链往上第二代；不足两代取链条顶端
 *   渠道负责人 —— 顶端渠道的负责人，整条链永久继承
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { resolveAttribution, attributionLabel, wouldCreateCycle } from "../src/lib/attribution";


let owner: { id: string };
let owner2: { id: string };
let sales: { id: string };
let channel: { id: string };

/** 建一个学员并按规则算好归属，返回其 id */
async function add(name: string, ref: { channelId?: string; referrerCustomerId?: string }) {
  const a = await resolveAttribution(ref);
  const c = await prisma.customer.create({
    data: {
      name,
      phone: "139" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
      salesOwnerId: sales.id,
      referrerCustomerId: ref.referrerCustomerId ?? null,
      ...a,
    },
  });
  return c.id;
}

async function readBack(id: string) {
  const c = await prisma.customer.findUniqueOrThrow({
    where: { id },
    select: {
      attributionChannelId: true,
      attributionCustomerId: true,
      channelOwnerId: true,
      channelId: true,
      referrerCustomerId: true,
    },
  });
  return c;
}

beforeEach(async () => {
  // 学员之间有自引用，先解除再删，否则撞外键
  await resetDb();
  await prisma.user.deleteMany({ where: { email: { startsWith: "t_" } } });

  owner = await prisma.user.create({
    data: { email: "t_owner", name: "张三", title: "销售", role: "SALES", password: "x" },
  });
  owner2 = await prisma.user.create({
    data: { email: "t_owner2", name: "另一负责人", title: "销售", role: "SALES", password: "x" },
  });
  sales = await prisma.user.create({
    data: { email: "t_sales", name: "销售甲", title: "销售", role: "SALES", password: "x" },
  });
  channel = await prisma.channel.create({
    data: { name: "小红", channelOwnerId: owner.id },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("正常分支", () => {
  it("自然流量：三个归属字段全为空", async () => {
    const a = await resolveAttribution({});
    expect(a).toEqual({
      channelId: null,
      attributionChannelId: null,
      attributionCustomerId: null,
      channelOwnerId: null,
    });
  });

  it("渠道直推（第一代）：不足两代，归属取链条顶端渠道", async () => {
    const id = await add("小明", { channelId: channel.id });
    const c = await readBack(id);
    expect(c.attributionChannelId).toBe(channel.id);
    expect(c.attributionCustomerId).toBeNull();
    expect(c.channelOwnerId).toBe(owner.id);
  });

  it("学员推荐、上游是渠道直推（第二代）：归属仍是渠道", async () => {
    const gen1 = await add("小明", { channelId: channel.id });
    const gen2 = await add("室友", { referrerCustomerId: gen1 });
    const c = await readBack(gen2);
    expect(c.attributionChannelId).toBe(channel.id);
    expect(c.attributionCustomerId).toBeNull();
  });

  it("学员推荐、上游也是被学员推荐（第三代）：归属落到往上第二代的学员", async () => {
    const gen1 = await add("小明", { channelId: channel.id });
    const gen2 = await add("室友", { referrerCustomerId: gen1 });
    const gen3 = await add("朋友", { referrerCustomerId: gen2 });
    const c = await readBack(gen3);
    expect(c.attributionCustomerId).toBe(gen1); // 小明
    expect(c.attributionChannelId).toBeNull();
  });

  it("第四代：归属是第二代，不会一路回到渠道", async () => {
    const g1 = await add("小明", { channelId: channel.id });
    const g2 = await add("室友", { referrerCustomerId: g1 });
    const g3 = await add("朋友", { referrerCustomerId: g2 });
    const g4 = await add("朋友的朋友", { referrerCustomerId: g3 });
    const c = await readBack(g4);
    expect(c.attributionCustomerId).toBe(g2); // 室友
    expect(c.attributionChannelId).toBeNull();
  });

  it("六代链条：每一代的归属都等于其往上第二代", async () => {
    const ids: string[] = [];
    ids.push(await add("g1", { channelId: channel.id }));
    for (let i = 2; i <= 6; i++) ids.push(await add("g" + i, { referrerCustomerId: ids[i - 2] }));
    // g3 起，归属应为 ids[i-3]
    for (let i = 3; i <= 6; i++) {
      const c = await readBack(ids[i - 1]);
      expect(c.attributionCustomerId).toBe(ids[i - 3]);
    }
  });
});

describe("渠道负责人继承", () => {
  it("整条链的渠道负责人都等于顶端渠道的负责人", async () => {
    const ids: string[] = [];
    ids.push(await add("g1", { channelId: channel.id }));
    for (let i = 2; i <= 5; i++) ids.push(await add("g" + i, { referrerCustomerId: ids[i - 2] }));
    for (const id of ids) {
      expect((await readBack(id)).channelOwnerId).toBe(owner.id);
    }
  });

  it("无渠道链条时渠道负责人留空，待人工指定", async () => {
    const id = await add("自然流量学员", {});
    expect((await readBack(id)).channelOwnerId).toBeNull();
  });

  it("整条链继承的是链条顶端渠道，不受其它渠道影响", async () => {
    const other = await prisma.channel.create({ data: { name: "小蓝", channelOwnerId: owner2.id } });
    const a = await add("A", { channelId: channel.id });
    const b = await add("B", { channelId: other.id });
    const aChild = await add("A的下线", { referrerCustomerId: a });
    expect((await readBack(aChild)).channelOwnerId).toBe(owner.id);
    expect((await readBack(b)).channelOwnerId).toBe(owner2.id);
  });
});

describe("归属固化：历史业绩不能被上游改动追溯性篡改", () => {
  it("改上游学员的推荐人后，下游已有学员的归属保持不变", async () => {
    const g1 = await add("小明", { channelId: channel.id });
    const g2 = await add("室友", { referrerCustomerId: g1 });
    const g3 = await add("朋友", { referrerCustomerId: g2 });
    const before = await readBack(g3);

    // 把小明的推荐人改掉（模拟事后订正上游）
    const other = await prisma.channel.create({ data: { name: "小蓝", channelOwnerId: owner2.id } });
    await prisma.customer.update({
      where: { id: g1 },
      data: { channelId: other.id, attributionChannelId: other.id, channelOwnerId: owner2.id },
    });

    const after = await readBack(g3);
    expect(after.attributionCustomerId).toBe(before.attributionCustomerId);
    expect(after.channelOwnerId).toBe(before.channelOwnerId);
  });
});

describe("脏数据", () => {
  it("推荐人 id 不存在：降级为自然流量而非抛错", async () => {
    const a = await resolveAttribution({ referrerCustomerId: "not-a-real-id" });
    expect(a.attributionCustomerId).toBeNull();
    expect(a.channelOwnerId).toBeNull();
  });

  it("渠道 id 不存在：同样降级为自然流量", async () => {
    const a = await resolveAttribution({ channelId: "not-a-real-id" });
    expect(a.channelId).toBeNull();
    expect(a.channelOwnerId).toBeNull();
  });

  it("两个 id 都传空字符串时按自然流量处理", async () => {
    const a = await resolveAttribution({ channelId: "", referrerCustomerId: "" });
    expect(a.channelOwnerId).toBeNull();
  });
});

describe("同时传入渠道与学员推荐人", () => {
  it("当前实现优先取渠道，不报错——固化该行为以便日后察觉变更", async () => {
    const g1 = await add("小明", { channelId: channel.id });
    const a = await resolveAttribution({ channelId: channel.id, referrerCustomerId: g1 });
    expect(a.attributionChannelId).toBe(channel.id);
    expect(a.attributionCustomerId).toBeNull();
  });
});

/**
 * attributionLabel 是列表与详情共用的展示口径。
 * 它此前一条测试都没有——覆盖率量出来才发现，整个函数是裸奔的。
 * 显示错了不会报错，只会让人看着错的归属对象做判断。
 */
describe("归属对象的展示名", () => {
  it("归属是渠道时显示渠道名", () => {
    expect(attributionLabel({ attributionChannel: { name: "小红老师" } })).toBe("小红老师");
  });

  it("归属是学员时显示学员名", () => {
    expect(attributionLabel({ attributionCustomer: { name: "小明" } })).toBe("小明");
  });

  it("渠道与学员都在时以渠道为准，与 resolveAttribution 的优先级一致", () => {
    expect(
      attributionLabel({
        attributionChannel: { name: "小红老师" },
        attributionCustomer: { name: "小明" },
      }),
    ).toBe("小红老师");
  });

  it("自然流量显示破折号，不能显示空白或 undefined", () => {
    expect(attributionLabel({})).toBe("—");
    expect(attributionLabel({ attributionChannel: null, attributionCustomer: null })).toBe("—");
  });
});

describe("成环检查的早退分支", () => {
  it("把推荐人设成自己，在查库之前就判定成环", async () => {
    // saveCustomer 另有一道「推荐人不能是本人」的校验，走不到这里，
    // 但这个函数是公开导出的，早退分支要自己锁住
    expect(await wouldCreateCycle("同一个人", "同一个人")).toBe(true);
  });
});
