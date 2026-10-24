import { describe, expect, it } from "vitest";
import { 清洗, 空索引, 认金额, 认赢率, 认时间, 公司名键, 数一数, type 本地索引 } from "@/lib/enterprise-import/clean";
import { 进备注, 输单 } from "@/lib/enterprise-import/mapping";
import type { 原始记录, 实体, 映射 } from "@/lib/enterprise-import/types";

function 映射样(改: Partial<映射> = {}): 映射 {
  return {
    列: {
      customer: { 外部: "id", 名称: "name", 电话: "phone", 负责人: "owner", 状态: "followStatus", 等级: "level", 邮箱: "email", 主营: 进备注, 创建时间: "" },
      contact: { 外部: "id", 客户ID: "customerRef", 客户: "customerName", 姓名: "name", 手机: "phone", 主联系人: "isPrimary" },
      lead: { 外部: "id", 名称: "name", 电话: "phone", 状态: "status", 负责人: "owner" },
      opportunity: { 外部: "id", 客户ID: "customerRef", 客户: "customerName", 名称: "name", 金额: "amount", 阶段: "stage", 状态: "status", 赢率: "probability", 预计: "expectedDealAt", 负责人: "owner" },
      followup: { 外部: "id", 客户ID: "customerRef", 客户: "customerName", 商机: "opportunityName", 方式: "type", 内容: "content", 时间: "occurredAt", 跟进人: "owner", 地点: 进备注 },
    },
    负责人: { 张伟: "u-zhang", 李娜: "u-li", Lina: "" },
    值: {
      阶段: { 需求确认: "需求确认", 谈判中: "谈判审核", 丢单: 输单, 成交: "赢单成交" },
      线索状态: { 新线索: "待跟进" },
      跟进类型: { 电话: "PHONE", 拜访: "VISIT" },
      跟进状态: { 待跟进: "待跟进" },
    },
    默认负责人Id: "u-default",
    ...改,
  };
}

let 序 = 0;
function 条(实体: 实体, 字段: Record<string, string>, 外部ID?: string): 原始记录 {
  序++;
  return { 实体, 外部ID: 外部ID ?? 字段.外部 ?? `auto${序}`, 字段, 行号: 序 + 1, 出处: "测试.xlsx" };
}

describe("小工具", () => {
  it("认金额", () => {
    expect(认金额("¥1,234.5")).toBe(1234.5);
    expect(认金额("10万")).toBe(100000);
    expect(认金额("3.5 万元")).toBe(35000);
    expect(认金额("USD 2000")).toBe(2000);
    expect(认金额("面议")).toBeNull();
    expect(认金额("-5")).toBeNull();
  });

  it("认赢率", () => {
    expect(认赢率("60%")).toBe(60);
    expect(认赢率("0.6")).toBe(60);
    expect(认赢率("60")).toBe(60);
    expect(认赢率("120")).toBeNull();
    expect(认赢率("高")).toBeNull();
  });

  it("认时间：带时分、Excel 小数、只有日期", () => {
    const a = 认时间("2026-10-20 14:30")!;
    expect([a.getFullYear(), a.getMonth() + 1, a.getDate(), a.getHours(), a.getMinutes()]).toEqual([2026, 10, 20, 14, 30]);
    const b = 认时间("2026年10月20日 9:05:07")!;
    expect([b.getDate(), b.getHours(), b.getMinutes(), b.getSeconds()]).toEqual([20, 9, 5, 7]);
    // 46315 = 2026-10-20；.75 = 18:00
    const c = 认时间("46315.75")!;
    expect([c.getMonth() + 1, c.getDate(), c.getHours(), c.getMinutes()]).toEqual([10, 20, 18, 0]);
    const d = 认时间("2026/10/20")!;
    expect([d.getDate(), d.getHours()]).toEqual([20, 0]);
    expect(认时间("上周")).toBeNull();
  });

  it("公司名键：去掉有限公司、括号", () => {
    expect(公司名键("杭州甲乙科技有限公司")).toBe(公司名键("杭州甲乙科技（总部）"));
    expect(公司名键("ACME Co.,Ltd")).toBe(公司名键("acme"));
  });
});

describe("清洗：客户", () => {
  it("落字段、负责人和状态按映射换、认不出的进备注并提醒，一格不丢", () => {
    const { 待写, 问题 } = 清洗(
      [条("customer", { 外部: "c1", 名称: "甲公司", 电话: "138 0000 0001", 负责人: "Lina", 状态: "神秘状态", 等级: "a类", 邮箱: "a@x.cn", 主营: "灯具", 创建时间: "2020-01-01" })],
      映射样({ 值: { ...映射样().值, 跟进状态: { 神秘状态: "" } } }),
    );
    expect(待写).toHaveLength(1);
    expect(待写[0].值).toMatchObject({
      name: "甲公司",
      phone: "13800000001",
      salesOwnerId: "u-default",
      followStatus: "待跟进",
      level: "A",
      email: "a@x.cn",
      remark: "主营：灯具",
    });
    expect(待写[0].目标).toBeUndefined();
    expect(问题.map((p) => p.类别).sort()).toEqual(["值对不上", "负责人对不上"]);
    expect(问题[0]).toMatchObject({ 级别: "提醒", 行号: expect.any(Number), 出处: "测试.xlsx" });
  });

  it("没名称跳过；电话认不出原样进备注；等级认不出进备注", () => {
    const { 待写, 问题 } = 清洗(
      [条("customer", { 外部: "c1", 名称: "", 电话: "13800000001" }), 条("customer", { 外部: "c2", 名称: "乙", 电话: "138****0001", 等级: "VIP" })],
      映射样(),
    );
    expect(待写.map((w) => w.外部ID)).toEqual(["c2"]);
    expect(待写[0].值.phone).toBe("");
    expect(待写[0].值.level).toBeNull();
    expect(待写[0].值.remark).toBe("电话：138****0001\n客户等级：VIP");
    expect(问题.find((p) => p.外部ID === "c1")).toMatchObject({ 级别: "跳过", 类别: "缺必填" });
    expect(问题.find((p) => p.外部ID === "c2")).toMatchObject({ 类别: "格式不对" });
  });

  it("同一批：外部 ID 重复只导前一条；同名同号并进前一条；名字像、号不同只提醒", () => {
    const { 待写, 问题 } = 清洗(
      [
        条("customer", { 外部: "c1", 名称: "杭州甲乙科技有限公司", 电话: "13800000001" }),
        条("customer", { 外部: "c1", 名称: "重复的 ID", 电话: "13800000009" }),
        条("customer", { 外部: "c2", 名称: "杭州甲乙科技有限公司", 电话: "+86 138-0000-0001" }),
        条("customer", { 外部: "c3", 名称: "杭州甲乙科技（总部）", 电话: "13800000003" }),
      ],
      映射样(),
    );
    expect(待写.map((w) => [w.外部ID, w.并入 ?? null])).toEqual([
      ["c1", null],
      ["c2", "c1"],
      ["c3", null],
    ]);
    expect(问题.map((p) => [p.外部ID, p.类别])).toEqual([
      ["c1", "ID 重复"],
      ["c2", "重名"],
      ["c3", "疑似重名"],
    ]);
    expect(问题[0].级别).toBe("跳过");
  });

  it("以前导过 → 对照；没导过但我们这边有同号客户 → 同号连上；同号多个 → 新建并提醒", () => {
    const 本地: 本地索引 = {
      ...空索引(),
      引用: new Map([["customer|c1", "local-1"]]),
      客户号: new Map([
        ["13800000002", ["local-2"]],
        ["13800000003", ["local-3a", "local-3b"]],
      ]),
      客户名: new Map([["丁公司", ["local-4"]]]),
    };
    const { 待写, 问题 } = 清洗(
      [
        条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" }),
        条("customer", { 外部: "c2", 名称: "乙", 电话: "13800000002" }),
        条("customer", { 外部: "c3", 名称: "丙", 电话: "13800000003" }),
        条("customer", { 外部: "c4", 名称: "丁公司", 电话: "13800000004" }),
      ],
      映射样(),
      本地,
    );
    expect(待写.map((w) => w.目标 ?? null)).toEqual([{ 本地ID: "local-1", 方式: "对照" }, { 本地ID: "local-2", 方式: "同号" }, null, null]);
    expect(问题.filter((p) => p.外部ID === "c3")[0].类别).toBe("疑似重名");
    expect(问题.filter((p) => p.外部ID === "c4")[0]).toMatchObject({ 类别: "疑似重名", 说明: expect.stringContaining("我们这边已经有") });
  });

  it("指纹：内容一样指纹一样，改一格就变", () => {
    const a = 清洗([条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" })], 映射样()).待写[0].指纹;
    const b = 清洗([条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" })], 映射样()).待写[0].指纹;
    const c = 清洗([条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000002" })], 映射样()).待写[0].指纹;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("清洗：挂客户", () => {
  const 客户们 = [
    条("customer", { 外部: "c1", 名称: "甲公司", 电话: "13800000001" }),
    条("customer", { 外部: "c2", 名称: "甲公司", 电话: "13800000002" }),
    条("customer", { 外部: "c3", 名称: "乙公司", 电话: "13800000003" }),
    条("customer", { 外部: "c4", 名称: "乙公司", 电话: "13800000003" }), // 并进 c3
  ];

  it("客户 ID 优先；按名字只认本批唯一的；被并入的客户 ID 挂到并入的那条", () => {
    const { 待写, 问题 } = 清洗(
      [
        ...客户们,
        条("contact", { 外部: "p1", 客户ID: "c2", 姓名: "小王", 主联系人: "是" }),
        条("contact", { 外部: "p2", 客户: "乙公司", 姓名: "小李" }),
        条("contact", { 外部: "p3", 客户: "甲公司", 姓名: "小赵" }),
        条("contact", { 外部: "p4", 客户ID: "c4", 姓名: "小钱" }),
        条("contact", { 外部: "p5", 客户: "不存在", 姓名: "小孙" }),
      ],
      映射样(),
    );
    const 联系人 = 待写.filter((w) => w.实体 === "contact");
    expect(联系人.map((w) => [w.外部ID, w.父客户])).toEqual([
      ["p1", { 外部ID: "c2" }],
      ["p2", { 外部ID: "c3" }],
      ["p4", { 外部ID: "c3" }],
    ]);
    expect(联系人[0].值.isPrimary).toBe(true);
    // 乙公司本批 c3、c4 两条，但 c4 并进了 c3 → 其实是一家，按名字能挂；甲公司 c1、c2 号不同 → 分不出
    const 跳 = 问题.filter((p) => p.实体 === "contact").map((p) => [p.外部ID, p.类别]);
    expect(跳).toEqual([
      ["p3", "客户不唯一"],
      ["p5", "找不到客户"],
    ]);
  });

  it("本批没有，就找以前导过的（对照）和我们这边唯一同名的", () => {
    const 本地: 本地索引 = {
      ...空索引(),
      引用: new Map([["customer|old1", "local-1"]]),
      客户名: new Map([
        ["丙公司", ["local-3"]],
        ["丁公司", ["local-4a", "local-4b"]],
      ]),
    };
    const { 待写, 问题 } = 清洗(
      [
        条("contact", { 外部: "p1", 客户ID: "old1", 姓名: "甲" }),
        条("contact", { 外部: "p2", 客户: "丙公司", 姓名: "乙" }),
        条("contact", { 外部: "p3", 客户: "丁公司", 姓名: "丙" }),
      ],
      映射样(),
      本地,
    );
    expect(待写.map((w) => w.父客户)).toEqual([{ 本地ID: "local-1" }, { 本地ID: "local-3" }]);
    expect(问题).toHaveLength(1);
    expect(问题[0]).toMatchObject({ 外部ID: "p3", 类别: "客户不唯一", 级别: "跳过" });
  });
});

describe("清洗：商机", () => {
  const 甲 = 条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" });

  it("金额、阶段、赢率、预计日期；输单 → LOST + 默认阶段 + 赢率 0；成交 → WON", () => {
    const { 待写, 问题 } = 清洗(
      [
        甲,
        条("opportunity", { 外部: "o1", 客户ID: "c1", 名称: "A", 金额: "10万", 阶段: "需求确认", 预计: "2026-12-01", 负责人: "张伟" }),
        条("opportunity", { 外部: "o2", 客户ID: "c1", 名称: "B", 金额: "5000", 阶段: "丢单" }),
        条("opportunity", { 外部: "o3", 客户ID: "c1", 名称: "C", 阶段: "成交" }),
        条("opportunity", { 外部: "o4", 客户ID: "c1", 名称: "D", 阶段: "谈判中", 赢率: "65%" }),
        条("opportunity", { 外部: "o5", 客户ID: "c1", 名称: "E", 金额: "面议", 阶段: "需求确认", 状态: "已赢单" }),
      ],
      映射样(),
    );
    const 值 = Object.fromEntries(待写.filter((w) => w.实体 === "opportunity").map((w) => [w.外部ID, w.值]));
    expect(值.o1).toMatchObject({ amount: 100000, stage: "需求确认", status: "OPEN", probability: 40, ownerId: "u-zhang" });
    expect(new Date(String(值.o1.expectedDealAt)).getDate()).toBe(1);
    expect(值.o2).toMatchObject({ stage: "初步沟通", status: "LOST", probability: 0 });
    expect(值.o3).toMatchObject({ stage: "赢单成交", status: "WON", probability: 100 });
    expect(值.o4).toMatchObject({ stage: "谈判审核", probability: 65 });
    expect(值.o5).toMatchObject({ amount: 0, status: "WON", stage: "赢单成交", remark: "金额：面议" });
    expect(问题.filter((p) => p.类别 !== "缺日期").map((p) => [p.外部ID, p.类别])).toEqual([["o5", "格式不对"]]);
    expect(值.o1.closedAt).toBeNull();
  });

  it("赢单 / 输单的结单日期：有就用，没有退预计成交日期，都没有提醒", () => {
    const 映 = 映射样();
    映.列.opportunity = { ...映.列.opportunity, 结单: "closedAt" };
    const { 待写, 问题 } = 清洗(
      [
        甲,
        条("opportunity", { 外部: "o1", 客户ID: "c1", 名称: "A", 阶段: "成交", 结单: "2025-03-05" }),
        条("opportunity", { 外部: "o2", 客户ID: "c1", 名称: "B", 阶段: "丢单", 预计: "2025-04-01" }),
        条("opportunity", { 外部: "o3", 客户ID: "c1", 名称: "C", 阶段: "成交" }),
        条("opportunity", { 外部: "o4", 客户ID: "c1", 名称: "D", 阶段: "需求确认", 结单: "2025-03-05" }),
      ],
      映,
    );
    const 值 = Object.fromEntries(待写.filter((w) => w.实体 === "opportunity").map((w) => [w.外部ID, w.值]));
    expect(new Date(String(值.o1.closedAt)).getMonth()).toBe(2);
    expect(new Date(String(值.o2.closedAt)).getMonth()).toBe(3);
    expect(值.o3.closedAt).toBeNull();
    expect(值.o4.closedAt).toBeNull();
    expect(问题.map((p) => [p.外部ID, p.类别, p.级别])).toEqual([
      ["o2", "缺日期", "提醒"],
      ["o3", "缺日期", "提醒"],
    ]);
  });

  it("阶段对不上：按默认阶段写、提醒", () => {
    const { 待写, 问题 } = 清洗([甲, 条("opportunity", { 外部: "o1", 客户ID: "c1", 名称: "A", 阶段: "神秘" })], 映射样());
    expect(待写[1].值.stage).toBe("初步沟通");
    expect(问题[0]).toMatchObject({ 类别: "阶段对不上", 级别: "提醒" });
  });
});

describe("清洗：跟进", () => {
  it("内容 / 标题互补、挂商机、时间带时分、没时间提醒、进备注列拼进内容", () => {
    const { 待写, 问题 } = 清洗(
      [
        条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" }),
        条("opportunity", { 外部: "o1", 客户ID: "c1", 名称: "灯具订单" }),
        条("followup", { 外部: "f1", 客户ID: "c1", 商机: "灯具订单", 方式: "拜访", 内容: "聊了报价，客户想要样品，下周寄出", 时间: "2026-10-20 14:30", 跟进人: "李娜", 地点: "上海" }),
        条("followup", { 外部: "f2", 客户ID: "c1", 商机: "不存在的商机", 方式: "微信群", 内容: "发了目录" }),
        条("followup", { 外部: "f3", 客户ID: "c1", 内容: "" }),
      ],
      映射样(),
    );
    const 跟 = 待写.filter((w) => w.实体 === "followup");
    expect(跟).toHaveLength(2);
    expect(跟[0]).toMatchObject({ 父客户: { 外部ID: "c1" }, 父商机: { 外部ID: "o1" } });
    expect(跟[0].值).toMatchObject({ type: "VISIT", content: "聊了报价，客户想要样品，下周寄出\n地点：上海", title: "聊了报价，客户想要样品，下周寄出", status: "已完成", ownerId: "u-li" });
    expect(new Date(String(跟[0].值.occurredAt)).getHours()).toBe(14);
    expect(跟[1].值).toMatchObject({ type: "OTHER", occurredAt: null });
    expect(跟[1].父商机).toBeUndefined();
    const f2 = 问题.filter((p) => p.外部ID === "f2").map((p) => p.类别).sort();
    expect(f2).toEqual(["值对不上", "找不到商机", "格式不对"].sort());
    expect(问题.find((p) => p.外部ID === "f3")).toMatchObject({ 级别: "跳过", 类别: "缺必填" });
  });

  it("按商机名挂我们这边已有的商机（同一客户下唯一）", () => {
    const 本地: 本地索引 = { ...空索引(), 客户名: new Map([["甲", ["local-c"]]]), 商机名: new Map([["local-c|灯具订单", ["local-o"]]]) };
    const { 待写 } = 清洗([条("followup", { 外部: "f1", 客户: "甲", 商机: "灯具订单", 内容: "回访", 时间: "2026-10-20" })], 映射样(), 本地);
    expect(待写[0]).toMatchObject({ 父客户: { 本地ID: "local-c" }, 父商机: { 本地ID: "local-o" } });
  });
});

describe("数一数", () => {
  it("按类数新建 / 更新 / 并入 / 跳过 / 提醒", () => {
    const 本地: 本地索引 = { ...空索引(), 引用: new Map([["customer|c1", "local-1"]]) };
    const r = 清洗(
      [
        条("customer", { 外部: "c1", 名称: "甲", 电话: "13800000001" }),
        条("customer", { 外部: "c2", 名称: "乙", 电话: "13800000002" }),
        条("customer", { 外部: "c3", 名称: "乙", 电话: "13800000002" }),
        条("customer", { 外部: "c4", 名称: "" }),
      ],
      映射样(),
      本地,
    );
    expect(数一数(r).customer).toEqual({ 待写: 3, 新建: 1, 更新: 1, 并入: 1, 跳过: 1, 提醒: 1 });
  });
});
