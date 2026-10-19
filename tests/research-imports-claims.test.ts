/**
 * 10-18 对比免费产品第七点：英国 HMRC 进口商名录（verify/imports.ts）和「官网说法 vs 工商登记」（site.ts 认官网说法、check.ts 比官网说法）。
 * 不连网：一律假 fetch / 假依赖。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 查英国进口, 进口摘要, 月字, 品类名, 是照明类, type 进口记录 } from "@/lib/research/verify/imports";
import { 认官网说法 } from "@/lib/research/verify/site";
import { 核验, 比官网说法 } from "@/lib/research/verify/check";
import { 查不了 } from "@/lib/research/verify/net";
import type { 核验项 } from "@/lib/research/verify/types";
import { 初始状态, 归约 } from "@/lib/research/state";

afterEach(() => {
  vi.unstubAllGlobals();
});

const 回 = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("HMRC 进口商名录", () => {
  it("按名字找 Trader、名字要「同」或「近」，再取每月进口的商品编码，新的在前", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/Trader?")) return 回({ value: [{ TraderId: 7, CompanyName: "SUNRISE BAKERY LTD" }, { TraderId: 42, CompanyName: "SUNRGY LED LIGHTING LTD", Address1: "1 High St", Address2: "-", PostCode: "B1 1AA" }] });
      return 回({
        TraderId: 42,
        CompanyName: "SUNRGY LED LIGHTING LTD",
        Imports: [
          { MonthId: 202403, Commodity: { Cn8Code: "94054000", Hs4Code: "9405", Hs4Description: "Lamps" } },
          { MonthId: 202501, Commodity: { Cn8Code: "48191000", Hs4Code: "4819", Hs4Description: "Cartons, boxes, cases" } },
          { MonthId: 202501, Commodity: null },
        ],
      });
    });
    vi.stubGlobal("fetch", f);
    const r = (await 查英国进口(["Sunrgy LED Lighting Ltd"]))!;
    expect(r.名).toBe("SUNRGY LED LIGHTING LTD");
    expect(r.地址).toBe("1 High St, B1 1AA");
    expect(r.月份.map((x) => x.月)).toEqual(["2025-01", "2024-03"]);
    expect(r.链接).toContain("Trader(42)");
    // OData 查询：名字去掉后缀、大写
    expect(decodeURIComponent(String(f.mock.calls[0][0]))).toContain("contains(CompanyName,'SUNRGY LED LIGHTING')");
  });
  it("名录里没有像的名字 → null；对面 503 → 查不了（不当「没有」）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => 回({ value: [{ TraderId: 1, CompanyName: "TOTALLY DIFFERENT CO" }] })));
    expect(await 查英国进口(["Sunrgy LED Lighting Ltd"])).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => 回({}, 503)));
    await expect(查英国进口(["Sunrgy LED Lighting Ltd"])).rejects.toBeInstanceOf(查不了);
  });
  it("摘要：照明类单独数、最近一次不是照明要写出来；明说没有数量金额；没有月份不写", () => {
    const r: 进口记录 = {
      名: "SUNRGY LED LIGHTING LTD",
      链接: "x",
      月份: [
        { 月: "2025-01", 编码: "48191000", 品类: "Cartons" },
        { 月: "2024-03", 编码: "94054000", 品类: "灯具" },
        { 月: "2023-11", 编码: "85414100", 品类: "LED / 半导体器件" },
      ],
    };
    expect(进口摘要(r)).toBe(
      "HMRC 进口商名录（SUNRGY LED LIGHTING LTD）：2023-11 至 2025-01 有 3 个月申报过进口，其中照明类（灯具、LED / 半导体器件）2 个月，最近一次 2024-03，最近一次（2025-01）进口的是Cartons。HMRC 只公布商品编码，不公布数量和金额，不能据此判断采购量",
    );
    expect(进口摘要({ ...r, 月份: [{ 月: "2025-01", 编码: "48191000", 品类: "Cartons" }] })).toContain("其中没有照明类");
    expect(进口摘要({ ...r, 月份: [] })).toBeNull();
    expect(月字(202403)).toBe("2024-03");
    expect(品类名("9405")).toBe("灯具");
    expect(品类名("4819", "Cartons, boxes")).toBe("Cartons");
    expect(品类名(undefined)).toBe("其他商品");
    expect(是照明类("85395000")).toBe(true);
    expect(是照明类("48191000")).toBe(false);
  });
  it("进口事件带来源名：来源表里显示「HMRC 进口商名录 · …」而不是一串网址", () => {
    const s = 归约(初始状态({ name: "Sunrgy" }), { type: "import", 有: true, 摘要: "HMRC…", source: "https://api.uktradeinfo.com/Trader(42)", 来源名: "HMRC 进口商名录 · SUNRGY" });
    expect(s.sources).toContainEqual({ title: "HMRC 进口商名录 · SUNRGY", url: "https://api.uktradeinfo.com/Trader(42)" });
  });
});

describe("官网说法 vs 工商登记", () => {
  it("认几种明确的写法；认不出、年份不合理就当没说", () => {
    expect(认官网说法("Welcome. Since 2009 we supply LED panels.")).toMatchObject({ 成立年: 2009 });
    expect(认官网说法("We have 10+ years of experience in LED lighting")).toMatchObject({ 经验年: 10 });
    expect(认官网说法("Over 15 years experience")).toMatchObject({ 经验年: 15 });
    expect(认官网说法("Gegründet 1998 in Hamburg")).toMatchObject({ 成立年: 1998 });
    expect(认官网说法("Seit 2001 Ihr Partner")).toMatchObject({ 成立年: 2001 });
    expect(认官网说法("Fondée en 1987")).toMatchObject({ 成立年: 1987 });
    expect(认官网说法("Desde 1995")).toMatchObject({ 成立年: 1995 });
    expect(认官网说法("公司成立于 2008 年，拥有 12 年行业经验")).toMatchObject({ 成立年: 2008, 经验年: 12 });
    expect(认官网说法("Established in 2012. 20 years of experience")).toMatchObject({ 成立年: 2012, 经验年: 20, 原文: expect.stringContaining("Established in 2012") });
    expect(认官网说法("Copyright 2009-2025 LED panels 5W")).toBeUndefined();
    expect(认官网说法("since 2099")).toBeUndefined();
    expect(认官网说法("2 year warranty")).toBeUndefined();
    expect(认官网说法("")).toBeUndefined();
  });

  const 今年 = 2026;
  const site = (说法?: 核验项["说法"]): 核验项 => ({ key: "site", 灯: "green", 态: "已核", 事实: "官网能打开", ...(说法 ? { 说法 } : {}) });
  const 登记 = (成立?: string, 态: 核验项["态"] = "已核"): 核验项 => ({ key: "registry", 灯: "green", 态, 事实: "Companies House", ...(成立 ? { 成立 } : {}) });

  it("年轻公司（不到 10 年）官网说得比登记老 2 年以上 → 官网那一项标黄、补一句（Sunrgy：10+ 年经验，2020 年成立）", () => {
    const x = 比官网说法(site({ 经验年: 10, 原文: "10+ years of experience" }), 登记("2020-06-01"), 今年);
    expect(x.灯).toBe("yellow");
    expect(x.事实).toBe("官网能打开；官网写 10 年以上经验（「10+ years of experience」），工商登记 2020 年才成立，对不上（也可能是前身公司的年头，问一句）");
    expect(比官网说法(site({ 成立年: 2009, 原文: "since 2009" }), 登记("2021"), 今年).事实).toContain("官网写 2009 年起");
  });
  it("对得上、老公司（10 年以上，常有改名换主体）、登记没核成、官网没说：都不动", () => {
    expect(比官网说法(site({ 经验年: 7, 原文: "7 years experience" }), 登记("2020-01-01"), 今年).灯).toBe("green");
    expect(比官网说法(site({ 成立年: 2019, 原文: "since 2019" }), 登记("2020-01-01"), 今年).灯).toBe("green");
    expect(比官网说法(site({ 成立年: 1990, 原文: "since 1990" }), 登记("2010-01-01"), 今年).灯).toBe("green");
    expect(比官网说法(site({ 成立年: 1990, 原文: "since 1990" }), 登记("2020-01-01", "没查到"), 今年).灯).toBe("green");
    expect(比官网说法(site({ 成立年: 1990, 原文: "since 1990" }), 登记(undefined), 今年).灯).toBe("green");
    expect(比官网说法(site(), 登记("2020-01-01"), 今年).灯).toBe("green");
  });
  it("核验里接上：官网说法和登记一起回来就比；英国公司才查进口，查不了不写这一句", async () => {
    const 今 = new Date().getFullYear();
    const 查进口 = vi.fn(async () => ({ 名: "SUNRGY LED LIGHTING LTD", 月份: [], 链接: "x" }));
    const 依赖 = {
      查年龄: async () => ({ 有: false as const, 查不了: true as const }),
      查MX: async () => true,
      取名单: async () => [],
      查官网: async (): Promise<核验项> => site({ 经验年: 30, 原文: "30 years experience" }),
      查工商: async (): Promise<核验项> => 登记(`${今 - 3}-01-01`),
      查税号: async (): Promise<核验项> => ({ key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号" }),
      查进口,
    };
    const 英 = await 核验({ 公司: "Sunrgy LED Lighting Ltd", 域名: "sunrgy.co.uk", 国家: "GB" }, 依赖);
    expect(英.项.find((x) => x.key === "site")?.灯).toBe("yellow");
    expect(英.进口).toMatchObject({ 名: "SUNRGY LED LIGHTING LTD" });
    expect(查进口).toHaveBeenCalledWith(["Sunrgy LED Lighting Ltd"], undefined);
    const 德 = await 核验({ 公司: "SLV GmbH", 域名: "slv.com", 国家: "DE" }, 依赖);
    expect("进口" in 德).toBe(false);
    expect(查进口).toHaveBeenCalledTimes(1);
    const 没 = await 核验({ 公司: "Sunrgy", 域名: "sunrgy.co.uk", 国家: "GB" }, { ...依赖, 查进口: async () => null });
    expect(没.进口).toBeNull();
    const 坏 = await 核验({ 公司: "Sunrgy", 域名: "sunrgy.co.uk", 国家: "GB" }, { ...依赖, 查进口: async () => Promise.reject(new 查不了("超时")) });
    expect("进口" in 坏).toBe(false);
  });
});
