/**
 * 选模版 + 币种（2026-10-03）。
 *   - 币种：内置 25 种、Intl 全量兜底、显示不混 $、合计不换汇
 *   - 模版：业务配置多了 template / currency；老库没存时按来源推断，不弹窗、不改它
 *   - 新用户选模版：只对桌面端的新库弹；选了整组套预设；绕过页面直接调也拦
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 金额, 是币种, 规整币种, 币种选项, 按币种合计, 合计文字, 内置币种, 币种名 } from "@/lib/currency";
import { mergeBusiness, BUSINESS_PRESETS, DEFAULT_BUSINESS, 推断模版 } from "@/lib/business-config";
import { invalidateSettingsCache, setSetting, getSetting } from "@/lib/settings";
import { 要选模版, 选过模版键 } from "@/lib/onboarding";
import { 选模版 } from "@/app/(app)/start/actions";
import { getBusiness } from "@/lib/business";

const 原值 = process.env.DESKTOP_LOCAL;

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  const jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
  process.env.DESKTOP_LOCAL = "1";
});

afterAll(async () => {
  if (原值 === undefined) delete process.env.DESKTOP_LOCAL;
  else process.env.DESKTOP_LOCAL = 原值;
  await prisma.$disconnect();
});

describe("币种", () => {
  it("内置 25 种，三组，每种都有中文名、都是合法 ISO 代码", () => {
    expect(内置币种).toHaveLength(25);
    expect(new Set(内置币种).size).toBe(25);
    for (const c of 内置币种) {
      expect(是币种(c), c).toBe(true);
      expect(币种名(c), c).not.toBe(c);
    }
  });

  it("显示：几种「元」不混成同一个 $；整数不带 .00；日元、韩元没有小数", () => {
    expect(金额(18600, "USD")).toBe("US$ 18,600");
    expect(金额(1000, "AUD")).toBe("AU$ 1,000");
    expect(金额(1000, "HKD")).toBe("HK$ 1,000");
    expect(金额(1000, "CAD")).toBe("CA$ 1,000");
    expect(金额(4860000, "CNY")).toBe("¥ 4,860,000");
    expect(金额(120000, "JPY")).toBe("JP¥ 120,000");
    expect(金额(3.2, "USD")).toBe("US$ 3.20");
    expect(金额(21500.5, "EUR")).toBe("€ 21,500.50");
  });

  it("老数据没有币种 / 填了认不得的：当人民币", () => {
    expect(金额(100, undefined)).toBe("¥ 100");
    expect(规整币种(null)).toBe("CNY");
    expect(规整币种("abc")).toBe("CNY");
    expect(规整币种(" usd ")).toBe("USD");
    expect(是币种("ABC")).toBe(false);
  });

  it("内置以外的也能选（Intl 全量），下拉里最近用过的排最前", () => {
    const g = 币种选项(["EUR", "USD"]);
    expect(g[0].label).toBe("最近用过");
    expect(g[0].options.map((o) => o.value)).toEqual(["EUR", "USD"]);
    // 置顶了的不在原组里重复出现
    expect(g.find((x) => x.label === "常用")!.options.map((o) => o.value)).not.toContain("USD");
    const 其他 = g.find((x) => x.label === "其他币种");
    expect(其他 && 其他.options.length).toBeGreaterThan(50);
  });

  it("合计按币种分开，**不换汇**：美元和欧元不加在一起", () => {
    const 合 = 按币种合计([{ a: 100, c: "USD" }, { a: 50, c: "EUR" }, { a: 200, c: "USD" }, { a: 20, c: null }], (r) => r.a, (r) => r.c);
    expect(合).toEqual([{ 币种: "USD", 合计: 300 }, { 币种: "EUR", 合计: 50 }, { 币种: "CNY", 合计: 20 }]);
    expect(合计文字(合)).toBe("US$ 300 · € 50 · ¥ 20");
    expect(合计文字([], "USD")).toBe("US$ 0");
  });
});

describe("模版", () => {
  it("预设带着模版和本位币：通用 CNY、外贸 USD；教培算通用", () => {
    expect(BUSINESS_PRESETS["通用销售"]).toMatchObject({ template: "general", currency: "CNY" });
    expect(BUSINESS_PRESETS["外贸出口"]).toMatchObject({ template: "trade", currency: "USD" });
    expect(BUSINESS_PRESETS["教培招生"]).toMatchObject({ template: "general", currency: "CNY" });
  });

  it("老库没存模版：来源里有外贸那组的就是外贸（本位币美元），其余通用", () => {
    const { template: _t, currency: _c, ...老外贸 } = BUSINESS_PRESETS["外贸出口"];
    expect(推断模版(老外贸)).toBe("trade");
    expect(mergeBusiness(老外贸)).toMatchObject({ template: "trade", currency: "USD" });
    const { template: _t2, currency: _c2, ...老通用 } = DEFAULT_BUSINESS;
    expect(mergeBusiness(老通用)).toMatchObject({ template: "general", currency: "CNY" });
    expect(mergeBusiness(null)).toMatchObject({ template: "general", currency: "CNY" });
  });

  it("存了的照存的来：外贸模版但本位币改成欧元，读回来还是欧元", () => {
    expect(mergeBusiness({ ...BUSINESS_PRESETS["外贸出口"], currency: "EUR" }).currency).toBe("EUR");
    expect(mergeBusiness({ ...BUSINESS_PRESETS["通用销售"], template: "trade" }).template).toBe("trade");
  });
});

describe("新用户选模版", () => {
  it("桌面端、新库：要选", async () => {
    expect(await 要选模版()).toBe(true);
  });

  it("网页版不弹", async () => {
    delete process.env.DESKTOP_LOCAL;
    expect(await 要选模版()).toBe(false);
  });

  it("老用户不弹：库里有客户，或者存过业务配置", async () => {
    await prisma.customer.create({ data: { name: "老客户", phone: "13800000000", salesOwnerId: mocks.user.id } });
    expect(await 要选模版()).toBe(false);
    await prisma.customer.deleteMany();
    await setSetting("business", BUSINESS_PRESETS["通用销售"]);
    expect(await 要选模版()).toBe(false);
  });

  it("选外贸：整组套外贸预设、本位币美元、记一笔，之后不再弹", async () => {
    expect((await 选模版("trade")).ok).toBe(true);
    const b = await getBusiness();
    expect(b).toMatchObject({ template: "trade", currency: "USD" });
    expect(b.sources).toContain("阿里国际站");
    expect(await getSetting(选过模版键)).toBeTruthy();
    expect(await 要选模版()).toBe(false);
  });

  it("绕过页面直接调：已经不该选了就什么都不改（不是一个跳过保存直接改全站措辞的口子）", async () => {
    await setSetting("business", { ...BUSINESS_PRESETS["通用销售"], customer: "会员" });
    expect((await 选模版("trade")).ok).toBe(true);
    const b = await getBusiness();
    expect(b.customer).toBe("会员");
    expect(b.template).toBe("general");
  });

  it("不是管理员不让选；乱传的模版名拒绝", async () => {
    mocks.user = { ...mocks.user, role: "SALES" };
    expect((await 选模版("trade")).ok).toBe(false);
    mocks.user = { ...mocks.user, role: "ADMIN" };
    expect((await 选模版("edu" as never)).ok).toBe(false);
  });
});
