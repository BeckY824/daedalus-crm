/**
 * 企业版导入 · AI 清洗（2026-10-26）：规则认不出的格子问 AI，回来照规则再认一遍才落进映射。
 * 不调真的模型：用 模拟清洗 / 测试里写的假清洗器；ENT_IMPORT_AI 只在这里临时改。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 清洗, 认金额 } from "@/lib/enterprise-import/clean";
import {
  AI补清洗,
  能发,
  找要问的,
  收清洗建议,
  模拟清洗,
  去掉AI清洗,
  选清洗器,
  格式说明键,
  同一家说明键,
  type 清洗器,
  type 清洗输入,
} from "@/lib/enterprise-import/ai-clean";
import { 试跑, 重新试跑, 合并改动 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 读文件们 } from "@/lib/enterprise-import/excel";
import type { 原始记录, 实体, 映射 } from "@/lib/enterprise-import/types";

function 映射样(改: Partial<映射> = {}): 映射 {
  return {
    列: {
      customer: { 外部: "id", 名称: "name", 电话: "phone", 邮箱: "email", 国家: "country", 来源: "source", 备注: "remark" },
      lead: { 外部: "id", 名称: "name", 电话: "phone", 来源: "source" },
      opportunity: { 外部: "id", 客户ID: "customerRef", 名称: "name", 金额: "amount", 预计: "expectedDealAt" },
      followup: { 外部: "id", 客户ID: "customerRef", 内容: "content", 时间: "occurredAt" },
    },
    负责人: {},
    值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} },
    默认负责人Id: "u-default",
    ...改,
  };
}

let 序 = 0;
function 条(实体: 实体, 字段: Record<string, string>): 原始记录 {
  序++;
  return { 实体, 外部ID: 字段.外部 ?? `auto${序}`, 字段, 行号: 序 + 1, 出处: "测试.xlsx" };
}

const 金额 = (s: string) => 条("opportunity", { 外部: `O-${s}`, 客户ID: "C1", 名称: "单子", 金额: s });

describe("金额规则（AI 之前先多认几种写法）", () => {
  it("全角、US$、元整、k / 千 / 万 / 亿", () => {
    expect(认金额("１２，０００")).toBe(12000);
    expect(认金额("US$3,000")).toBe(3000);
    expect(认金额("5000元整")).toBe(5000);
    expect(认金额("3k")).toBe(3000);
    expect(认金额("2千")).toBe(2000);
    expect(认金额("1.5亿")).toBe(150000000);
    expect(认金额("约5万")).toBeNull();
    expect(认金额("面议")).toBeNull();
  });
});

describe("电话格里写的不是电话", () => {
  const 洗一家 = (电话: string, 另: Record<string, string> = {}) =>
    清洗([条("customer", { 外部: "C1", 名称: "甲公司", 电话, ...另 })], 映射样()).待写[0].值;

  it("邮箱放进邮箱、微信放进微信、WhatsApp 放进 WhatsApp", () => {
    expect(洗一家("buyer@acme.com")).toMatchObject({ phone: "", email: "buyer@acme.com" });
    expect(洗一家("微信：yunfan_88")).toMatchObject({ phone: "", wechat: "yunfan_88" });
    expect(洗一家("WhatsApp: +1 415 555 0100")).toMatchObject({ phone: "", whatsapp: "+1 415 555 0100" });
  });

  it("邮箱格本来有值：电话格里的邮箱进备注，不盖", () => {
    const v = 洗一家("b@acme.com", { 邮箱: "a@acme.com" });
    expect(v.email).toBe("a@acme.com");
    expect(String(v.remark)).toContain("邮箱：b@acme.com");
  });

  it("一格几个号：第一个当电话，其余进备注", () => {
    const v = 洗一家("13800000001/13900000002");
    expect(v.phone).toBe("13800000001");
    expect(String(v.remark)).toContain("另一个电话：13900000002");
  });
});

describe("找要问的", () => {
  it("只问规则认不出、映射里没有、能发出去的；按出现次数多的先问", () => {
    const 记录 = [
      金额("约5万"), 金额("约5万"), 金额("面议"), 金额("12万"),
      金额("13800000001元"), // 像手机号，不发
      条("customer", { 外部: "C1", 名称: "杭州云帆科技有限公司", 电话: "13800000001", 国家: "美国加州", 来源: "领英私信" }),
      条("customer", { 外部: "C2", 名称: "云帆科技", 电话: "13900000002", 国家: "美国", 来源: "领英" }),
      条("customer", { 外部: "C3", 名称: "宁波海川贸易", 电话: "13700000003", 邮箱: "x@y.com" }),
    ];
    const m = 映射样({ 格式: { 金额: { 面议: null } } }); // 面议 人已经定过了
    const 输入 = 找要问的(记录, m);
    expect(输入.格式.金额).toEqual(["约5万"]);
    expect(输入.格式.国家).toEqual(["美国加州"]);
    expect(输入.格式.来源).toEqual(["领英私信"]);
    expect(输入.同一家).toEqual([{ 键: "杭州云帆科技有限公司|云帆科技", 前: "杭州云帆科技有限公司", 后: "云帆科技" }]);
    // 发出去的只有这些格子和两个公司名，没有电话、邮箱
    const 发 = JSON.stringify(输入);
    for (const 不该 of ["13800000001", "13900000002", "x@y.com", "宁波海川贸易"]) expect(发).not.toContain(不该);
  });

  it("同号的两家不问同一家（清洗本来就并）", () => {
    const 记录 = [
      条("customer", { 外部: "C1", 名称: "杭州云帆科技有限公司", 电话: "13800000001" }),
      条("customer", { 外部: "C2", 名称: "云帆科技", 电话: "13800000001" }),
    ];
    expect(找要问的(记录, 映射样()).同一家).toEqual([]);
  });

  it("能发：带 @、像手机号、7 位以上连续数字、超过 40 字的都不发", () => {
    expect(能发("约5万")).toBe(true);
    expect(能发("a@b")).toBe(false);
    expect(能发("138 0000 0001")).toBe(false);
    expect(能发("单号1234567")).toBe(false);
    expect(能发("很".repeat(41))).toBe(false);
    expect(能发("  ")).toBe(false);
  });
});

describe("收清洗建议", () => {
  const 输入: 清洗输入 = {
    格式: { 金额: ["约5万", "面议"], 国家: ["美国加州"] },
    国家候选: [],
    来源候选: [],
    同一家: [{ 键: "a|b", 前: "A", 后: "B" }],
  };

  it("只收问过的键；照规则再认一遍，认不出的丢掉；同一家只收 true / false", () => {
    const m = 映射样();
    const n = 收清洗建议(
      m,
      {
        格式: {
          金额: { 约5万: "50000", 面议: "看情况", 没问的: "1" },
          国家: { 美国加州: "火星" },
          日期: { 没问: "2026-01-01" },
        },
        同一家: { "a|b": true, "x|y": true },
      },
      输入,
    );
    expect(n).toBe(2);
    expect(m.格式).toEqual({ 金额: { 约5万: "50000" } });
    expect(m.同一家).toEqual({ "a|b": true });
    expect(m.说明).toMatchObject({ [格式说明键("金额", "约5万")]: "AI", [同一家说明键("a|b")]: "AI" });
  });

  it("AI 回的乱七八糟也不炸", () => {
    const m = 映射样();
    expect(收清洗建议(m, { 格式: { 金额: "不是对象" as never }, 同一家: { "a|b": "是" as never } }, 输入)).toBe(0);
    expect(m.格式).toBeUndefined();
  });
});

describe("清洗照 m.格式 / m.同一家 用", () => {
  it("金额、日期、国家、来源用补认的；人定了不认（null）的照规则进备注", () => {
    const m = 映射样({
      格式: { 金额: { 约5万: "50000", 面议: null }, 日期: { 年底前: "2026-12-31" }, 国家: { 美国加州: "美国" }, 来源: { 领英私信: "领英" } },
    });
    const { 待写 } = 清洗(
      [
        条("customer", { 外部: "C1", 名称: "甲公司", 电话: "13800000001", 国家: "美国加州", 来源: "领英私信" }),
        条("opportunity", { 外部: "O1", 客户ID: "C1", 名称: "一单", 金额: "约5万", 预计: "年底前" }),
        条("opportunity", { 外部: "O2", 客户ID: "C1", 名称: "二单", 金额: "面议" }),
      ],
      m,
    );
    const [客户, 一单, 二单] = 待写;
    expect(客户.值).toMatchObject({ country: "美国", source: "领英" });
    expect(一单.值.amount).toBe(50000);
    expect(String(一单.值.expectedDealAt).slice(0, 10)).toBe(new Date(2026, 11, 31).toISOString().slice(0, 10));
    expect(二单.值.amount).toBe(0);
    expect(String(二单.值.remark)).toContain("金额：面议");
  });

  it("补认的值不合规（人手改坏、库里老数据）照样不用", () => {
    const m = 映射样({ 格式: { 金额: { 约5万: "五万" }, 国家: { 美国加州: "火星" } } });
    const { 待写 } = 清洗(
      [
        条("customer", { 外部: "C1", 名称: "甲公司", 电话: "13800000001", 国家: "美国加州" }),
        条("opportunity", { 外部: "O1", 客户ID: "C1", 名称: "一单", 金额: "约5万" }),
      ],
      m,
    );
    expect(待写[0].值.country).toBe("美国加州");
    expect(待写[1].值.amount).toBe(0);
  });

  it("认作同一家：后一家并进前一家，空着的格子、又名、另一个电话、备注带过去", () => {
    const m = 映射样({ 同一家: { "杭州云帆科技有限公司|云帆科技": true } });
    const { 待写, 问题 } = 清洗(
      [
        条("customer", { 外部: "C1", 名称: "杭州云帆科技有限公司", 电话: "13800000001" }),
        条("customer", { 外部: "C2", 名称: "云帆科技", 电话: "13900000002", 邮箱: "a@yunfan.com", 国家: "美国", 备注: "老客户" }),
      ],
      m,
    );
    expect(待写).toHaveLength(2);
    const [前, 后] = 待写;
    expect(后.并入).toBe("C1");
    expect(前.值).toMatchObject({ name: "杭州云帆科技有限公司", phone: "13800000001", email: "a@yunfan.com", country: "美国" });
    expect(String(前.值.remark)).toContain("又名：云帆科技");
    expect(String(前.值.remark)).toContain("另一个电话：13900000002");
    expect(String(前.值.remark)).toContain("老客户");
    expect(问题.some((x) => x.类别 === "重名" && /认作同一家/.test(x.说明))).toBe(true);
  });

  it("认作不是同一家（false）：各建各的", () => {
    const m = 映射样({ 同一家: { "杭州云帆科技有限公司|云帆科技": false } });
    const { 待写 } = 清洗(
      [
        条("customer", { 外部: "C1", 名称: "杭州云帆科技有限公司", 电话: "13800000001" }),
        条("customer", { 外部: "C2", 名称: "云帆科技", 电话: "13900000002" }),
      ],
      m,
    );
    expect(待写.map((w) => w.并入 ?? null)).toEqual([null, null]);
  });
});

describe("AI补清洗 / 去掉AI清洗", () => {
  const 记录 = () => [
    条("customer", { 外部: "C1", 名称: "杭州云帆科技有限公司", 电话: "13800000001", 国家: "美国加州" }),
    条("customer", { 外部: "C2", 名称: "云帆科技", 电话: "13900000002" }),
    金额("约5万"),
  ];

  it("模拟清洗走通：补认的落进映射、标 AI，给一条提醒", async () => {
    const m = 映射样();
    const r = await AI补清洗(记录(), m, 模拟清洗);
    expect(r.补了).toBe(3);
    expect(r.提醒.join()).toMatch(/AI 清洗补认了 3 格/);
    expect(m.格式).toEqual({ 金额: { 约5万: "50000" }, 国家: { 美国加州: "美国" } });
    expect(m.同一家).toEqual({ "杭州云帆科技有限公司|云帆科技": true });
  });

  it("AI 抛错：只加一条提醒，映射不动", async () => {
    const m = 映射样();
    const r = await AI补清洗(记录(), m, async () => {
      throw new Error("超时了");
    });
    expect(r).toEqual({ 补了: 0, 提醒: [expect.stringMatching(/AI 清洗这一步没成功（超时了）/)] });
    expect(m.格式).toBeUndefined();
  });

  it("人改过的不再问，也不会被 AI 盖掉", async () => {
    const m = 映射样({ 格式: { 金额: { 约5万: "40000" } }, 说明: { [格式说明键("金额", "约5万")]: "手动" } });
    const 问到: 清洗输入[] = [];
    await AI补清洗(记录(), m, async (x) => {
      问到.push(x);
      return { 格式: { 金额: { 约5万: "50000" } } };
    });
    expect(问到[0].格式.金额).toBeUndefined();
    expect(m.格式!.金额).toEqual({ 约5万: "40000" });
  });

  it("没东西可问就不调", async () => {
    const 调 = vi.fn<清洗器>(async () => ({}));
    const r = await AI补清洗([金额("12万")], 映射样(), 调);
    expect(调).not.toHaveBeenCalled();
    expect(r).toEqual({ 补了: 0, 提醒: [] });
  });

  it("不采用：AI 补的拿掉，人改的留着", () => {
    const m = 映射样({
      格式: { 金额: { 约5万: "50000", 面议: "0" } },
      同一家: { "a|b": true, "c|d": false },
      说明: {
        [格式说明键("金额", "约5万")]: "AI",
        [格式说明键("金额", "面议")]: "手动",
        [同一家说明键("a|b")]: "AI",
        [同一家说明键("c|d")]: "手动",
      },
    });
    去掉AI清洗(m);
    expect(m.格式).toEqual({ 金额: { 面议: "0" } });
    expect(m.同一家).toEqual({ "c|d": false });
    expect(Object.values(m.说明!)).toEqual(["手动", "手动"]);
  });
});

describe("试跑带 AI 清洗（带库）", () => {
  const 我 = { id: "tester-id", name: "测试员" };
  const 原开关 = process.env.ENT_IMPORT_AI;
  const 表们 = () => [
    ...读文件们({
      名: "客户.csv",
      bytes: new TextEncoder().encode(
        "客户ID,客户名称,手机号码,国家\nC1,杭州云帆科技有限公司,13800000001,美国加州\nC2,云帆科技,13900000002,\nC3,宁波海川贸易,13700000003,美国\n",
      ),
    }),
    ...读文件们({
      名: "商机.csv",
      bytes: new TextEncoder().encode("商机ID,客户ID,商机名称,商机金额\nO1,C1,服务器采购,约5万\nO2,C3,样品单,12万\nO3,C3,年框,面议\n"),
    }),
  ];
  const 金额们 = async () =>
    Object.fromEntries((await prisma.opportunity.findMany({ select: { name: true, amount: true } })).map((o) => [o.name, Number(o.amount)]));

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", title: "管理员", role: "ADMIN", password: "x" } });
  });
  afterEach(() => {
    if (原开关 === undefined) delete process.env.ENT_IMPORT_AI;
    else process.env.ENT_IMPORT_AI = 原开关;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("模拟清洗：报告列出 AI 认的，预演数 = 实际写入数，零丢失零重复", async () => {
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 表们(), 建议器: null, 清洗器: 模拟清洗 });
    expect(报告.清洗?.格式).toEqual(
      expect.arrayContaining([
        { 类: "金额", 原值: "约5万", 认作: "50000", 说明: "AI" },
        { 类: "国家", 原值: "美国加州", 认作: "美国", 说明: "AI" },
      ]),
    );
    // AI 也认不出的（面议）不落进映射，照规则进备注
    expect(报告.清洗?.格式.some((x) => x.原值 === "面议")).toBe(false);
    expect(报告.清洗?.同一家).toEqual([{ 键: "杭州云帆科技有限公司|云帆科技", 前: "杭州云帆科技有限公司", 后: "云帆科技", 是: true, 说明: "AI" }]);
    expect(报告.提醒.join("\n")).toMatch(/AI 清洗补认了/);

    const 写 = await 写一批(批次Id, 我);
    expect(报告.预演?.合计).toEqual({ 新建: 写.新建, 更新: 写.更新, 跳过: 写.跳过, 冲突: 写.冲突, 失败: 写.失败 });
    // 3 行客户并成 2 家，3 个商机一个不少
    expect((await prisma.customer.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((c) => c.name)).toEqual(["宁波海川贸易", "杭州云帆科技有限公司"]);
    expect(await 金额们()).toEqual({ 服务器采购: 50000, 样品单: 120000, 年框: 0 });
    const 云帆 = await prisma.customer.findFirstOrThrow({ where: { name: "杭州云帆科技有限公司" }, include: { extra: true } });
    expect(云帆.extra?.country).toBe("美国");
    expect(云帆.remark).toContain("又名：云帆科技");
  });

  it("AI 抛错：照规则走，只多一条提醒", async () => {
    const { 批次Id, 报告 } = await 试跑({
      来源: "excel",
      用户Id: "tester-id",
      表: 表们(),
      建议器: null,
      清洗器: async () => {
        throw new Error("401 key 不对");
      },
    });
    expect(报告.提醒.join("\n")).toMatch(/AI 清洗这一步没成功（401 key 不对）/);
    expect(报告.清洗).toEqual({ 格式: [], 同一家: [] });
    await 写一批(批次Id, 我);
    expect(await prisma.customer.count()).toBe(3);
    expect(await 金额们()).toEqual({ 服务器采购: 0, 样品单: 120000, 年框: 0 });
  });

  it("重新试跑不再问 AI；人改的标手动；整块不采用就回到规则", async () => {
    const 调 = vi.fn<清洗器>(模拟清洗);
    const 首 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 表们(), 建议器: null, 清洗器: 调 });
    expect(调).toHaveBeenCalledTimes(1);

    const 改 = await 重新试跑(首.批次Id, { 格式: { 金额: { 面议: "8000" } } }, "tester-id");
    expect(调).toHaveBeenCalledTimes(1);
    expect(改.报告.清洗?.格式).toEqual(
      expect.arrayContaining([
        { 类: "金额", 原值: "约5万", 认作: "50000", 说明: "AI" },
        { 类: "金额", 原值: "面议", 认作: "8000", 说明: "手动" },
      ]),
    );

    const 不用 = await 重新试跑(首.批次Id, { 不采用AI清洗: true }, "tester-id");
    expect(调).toHaveBeenCalledTimes(1);
    expect(不用.报告.清洗?.格式).toEqual([{ 类: "金额", 原值: "面议", 认作: "8000", 说明: "手动" }]);
    expect(不用.报告.清洗?.同一家).toEqual([]);
    await 写一批(不用.批次Id, 我);
    expect(await prisma.customer.count()).toBe(3);
    expect(await 金额们()).toEqual({ 服务器采购: 0, 样品单: 120000, 年框: 8000 });
  });

  it("合并改动：清空的格子记 null（不认）", () => {
    const m = 合并改动(映射样(), { 格式: { 金额: { 面议: "  " } }, 同一家: { "a|b": false } })!;
    expect(m.格式).toEqual({ 金额: { 面议: null } });
    expect(m.同一家).toEqual({ "a|b": false });
    expect(m.说明).toMatchObject({ [格式说明键("金额", "面议")]: "手动", [同一家说明键("a|b")]: "手动" });
  });

  it("选清洗器：传了用传的；ENT_IMPORT_AI=mock / off；都没有又没配 Key 就不用", async () => {
    const 我的: 清洗器 = async () => ({});
    expect((await 选清洗器(我的)).清洗器).toBe(我的);
    expect((await 选清洗器(null)).清洗器).toBeNull();
    process.env.ENT_IMPORT_AI = "mock";
    expect((await 选清洗器()).清洗器).toBe(模拟清洗);
    process.env.ENT_IMPORT_AI = "off";
    expect((await 选清洗器()).清洗器).toBeNull();
    delete process.env.ENT_IMPORT_AI;
    expect((await 选清洗器()).清洗器).toBeNull();
  });

  it("没传清洗器、建议器 = null（每小时增量同步、测试）：即使 ENT_IMPORT_AI=mock 也不问", async () => {
    process.env.ENT_IMPORT_AI = "mock";
    const { 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 表们(), 建议器: null });
    expect(报告.清洗).toEqual({ 格式: [], 同一家: [] });
    expect(报告.提醒.join("\n")).not.toMatch(/AI 清洗/);
  });
});

describe("企业版没开", () => {
  const 原 = process.env.CRM_ENTERPRISE;
  afterEach(() => {
    if (原 === undefined) delete process.env.CRM_ENTERPRISE;
    else process.env.CRM_ENTERPRISE = 原;
  });

  it("上传试跑、改映射重新试跑都进不来，不建批次、不问 AI", async () => {
    delete process.env.CRM_ENTERPRISE;
    process.env.ENT_IMPORT_AI = "mock";
    const { POST } = await import("@/app/api/enterprise-import/upload/route");
    const { 改映射重新试跑 } = await import("@/app/(app)/settings/enterprise-import-actions");
    const 前 = await prisma.entImportBatch.count();

    const r = await POST(new Request("http://x/api/enterprise-import/upload", { method: "POST" }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "企业版没开" });
    await expect(改映射重新试跑("不存在", {})).rejects.toThrow("企业版没开");
    expect(await prisma.entImportBatch.count()).toBe(前);
    delete process.env.ENT_IMPORT_AI;
  });
});
