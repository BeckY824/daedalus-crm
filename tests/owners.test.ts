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
import { 默认负责人 } from "@/lib/me-client";
import fs from "node:fs";
import path from "node:path";

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

/*
  2026-10-04 补（回归核对 D-038）：桌面端老库里还留着样例同事张三 / 李四时，
  按「有别人就排除管理员」负责人下拉只有他俩、业绩榜没有用户本人（10-02 排查 B5，修在 负责人口径 的 本地模式() 分支）。
  修了但没有用例钉着
*/
describe("桌面端老库里残留样例同事张三李四", () => {
  const 原来 = process.env.DESKTOP_LOCAL;
  beforeEach(async () => {
    process.env.DESKTOP_LOCAL = "1";
    await 建人("用户本人", "ADMIN");
    await 建人("张三", "SALES");
    await 建人("李四", "SALES");
  });
  afterAll(() => {
    if (原来 === undefined) delete process.env.DESKTOP_LOCAL;
    else process.env.DESKTOP_LOCAL = 原来;
  });

  it("负责人候选里有用户本人", async () => {
    expect((await 负责人候选()).map((u) => u.name)).toContain("用户本人");
  });

  it("排行榜口径也含本人：不然他自己的业绩永远看不见", async () => {
    expect(await 负责人口径()).toEqual({ active: true });
  });

  it("AI 按名字找得到本人", async () => {
    expect((await 按名字找负责人("用户本人")).length).toBe(1);
  });
});

/*
  T-015 / T-025（2026-10-04 上线前回归核对）：新建客户 / 商机 / 渠道时负责人默认是「我」。
  团队版里同事账号也同步进来了，默认落到名单第一人 = 业务员建的客户挂到同事名下，建完自己就看不到了（等于丢客户）
*/
describe("新建时负责人默认是我（T-015 / T-025）", () => {
  const 我 = { id: "me" };
  const 候选 = [{ id: "colleague" }, { id: "me" }, { id: "other" }];

  it("我在候选里：是我，不是排第一的同事", () => {
    expect(默认负责人(我, 候选)).toBe("me");
  });

  it("我不在候选里（网页多人版管理员不做销售）、没登录：留空让人选", () => {
    expect(默认负责人(我, [{ id: "colleague" }, { id: "other" }])).toBeUndefined();
    expect(默认负责人(null, 候选)).toBeUndefined();
    expect(默认负责人(我, [])).toBeUndefined();
  });

  it("三张新建表单都只用 默认负责人()，不兜底到名单第一人", () => {
    // 新建商机原来写成 默认负责人(我, users) ?? users[0]?.id：网页多人管理员不在候选里，默认就是名单第一个销售
    const 表单 = {
      "src/app/(app)/customers/CustomerForm.tsx": "salesOwnerId",
      "src/app/(app)/opportunities/OpportunityForm.tsx": "ownerId",
      "src/app/(app)/channels/ChannelsView.tsx": "channelOwnerId",
    };
    for (const [文件, 字段] of Object.entries(表单)) {
      const 源 = fs.readFileSync(path.resolve(__dirname, "..", 文件), "utf8");
      const 行 = 源.split("\n").filter((l) => l.includes("默认负责人(我, users)"));
      expect(行.length, 文件).toBe(1);
      expect(行[0], 文件).toContain(`${字段}: 默认负责人(我, users)`);
      expect(行[0], 文件).not.toMatch(/默认负责人\(我, users\)\s*(\?\?|\|\|)/);
    }
  });
});
