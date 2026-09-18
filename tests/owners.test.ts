/**
 * 负责人候选名单的回退。
 *
 * 「管理员不承担销售职责」这条规则本身是对的，但它在「工作区只有一个人，
 * 而那个人是管理员」时会把产品卡死——负责人必填、下拉却空着。
 * 桌面端天生是这个状态（一个人自己的库），托管版每个新工作区一开始也是。
 *
 * 2026-09-18 报上来的那条：桌面端「新建渠道」的负责人下拉是「暂无数据」，
 * 而它是必填项——整条路走不通。根因不是渠道页，是**同一份名单被抄了好几处**，
 * 有的走回退、有的没走。所以这组用例直接盯真函数，不再另抄一份逻辑来验。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 可担任负责人 } from "@/lib/constants";
import { 负责人候选, 负责人口径, 按名字找负责人 } from "@/lib/owners";

beforeEach(resetDb);
afterAll(async () => { await prisma.$disconnect(); });

const 建人 = (name: string, role: string, active = true) =>
  prisma.user.create({ data: { email: `${name}@t.local`, name, title: role, role, active, password: "x" } });

describe("有销售的工作区", () => {
  beforeEach(async () => {
    await 建人("管理员", "ADMIN");
    await 建人("张三", "SALES");
    await 建人("李四", "SALES");
  });

  it("候选里不列管理员", async () => {
    expect((await 负责人候选()).map((u) => u.name)).toEqual(["张三", "李四"]);
  });

  it("AI 建议里写管理员的名字，照样不认——多人工作区里他不做销售", async () => {
    expect(await 按名字找负责人("管理员")).toEqual([]);
    expect((await 按名字找负责人("张三")).length).toBe(1);
  });

  it("排行榜口径仍然严格排除管理员", async () => {
    expect(await 负责人口径()).toEqual(可担任负责人);
  });
});

describe("只有一个管理员的工作区（桌面端）", () => {
  beforeEach(async () => { await 建人("becky", "ADMIN"); });

  it("候选回退到他自己——否则新建渠道 / 客户 / 商机全都没有负责人可选", async () => {
    expect((await 负责人候选()).map((u) => u.name)).toEqual(["becky"]);
  });

  it("AI 按名字也找得到他：下拉能选到、AI 却说「没有这个人」是说不通的", async () => {
    expect((await 按名字找负责人("becky")).length).toBe(1);
  });

  it("排行榜口径跟着放宽：他就是销售本人，不然自己的业绩永远看不见", async () => {
    expect(await 负责人口径()).toEqual({ active: true });
  });
});

describe("停用的人", () => {
  it("有在职销售时，停用的人不列", async () => {
    await 建人("张三", "SALES");
    await 建人("离职的", "SALES", false);
    expect((await 负责人候选()).map((u) => u.name)).toEqual(["张三"]);
  });

  it("回退也只回退到在职的人，不会把停用的塞回来", async () => {
    await 建人("管理员", "ADMIN");
    await 建人("离职的", "SALES", false);
    expect((await 负责人候选()).map((u) => u.name)).toEqual(["管理员"]);
  });

  it("全员停用时是空名单", async () => {
    await 建人("管理员", "ADMIN", false);
    await 建人("张三", "SALES", false);
    expect(await 负责人候选()).toEqual([]);
  });
});
