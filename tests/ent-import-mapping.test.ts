import { afterEach, describe, expect, it, vi } from "vitest";
import {
  打码,
  进备注,
  规则猜列,
  规则对值,
  规则对负责人,
  猜映射,
  模拟建议,
  选建议器,
  说明键,
  type 建议器,
  type 成员,
} from "@/lib/enterprise-import/mapping";
import { 成记录, 猜实体, 读文件 } from "@/lib/enterprise-import/excel";
import type { 原始记录 } from "@/lib/enterprise-import/types";

const 成员们: 成员[] = [
  { id: "u-zhang", name: "张伟", email: "zhangwei@acme.cn" },
  { id: "u-li", name: "李娜", email: "lina@acme.cn" },
  { id: "u-wang1", name: "王芳", email: null },
  { id: "u-wang2", name: "王芳", email: "wangfang2@acme.cn" },
];

function 表(实体: 原始记录["实体"], 表头: string[], 行: string[][]) {
  return { 实体, 表头, 行 };
}

function 记录(实体: 原始记录["实体"], 表头: string[], 行: string[][]): 原始记录[] {
  return 行.map((r, i) => ({ 实体, 外部ID: `x${i}`, 字段: Object.fromEntries(表头.map((h, j) => [h, r[j] ?? ""])), 行号: i + 2 }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("规则猜列", () => {
  it("飞书 / 钉钉常见列名落到标准字段，认不出的拼进备注，系统列不用", () => {
    const m = 规则猜列("customer", ["客户名称", "手机号码", "客户负责人", "客户等级", "主营产品", "创建时间", "记录ID"]);
    expect(m).toEqual({
      客户名称: "name",
      手机号码: "phone",
      客户负责人: "owner",
      客户等级: "level",
      主营产品: 进备注,
      创建时间: "",
      记录ID: "id",
    });
  });

  it("一个字段只占一列：两列都像电话时只认第一列，第二列拼进备注", () => {
    const m = 规则猜列("customer", ["客户名称", "手机", "座机"]);
    expect(m.手机).toBe("phone");
    expect(m.座机).toBe(进备注);
  });

  it("跟进表的「创建时间」「创建人」当跟进时间和跟进人，不当系统列", () => {
    const m = 规则猜列("followup", ["客户名称", "跟进内容", "创建时间", "创建人"]);
    expect(m).toMatchObject({ 客户名称: "customerName", 跟进内容: "content", 创建时间: "occurredAt", 创建人: "owner" });
  });

  it("全角、括号里的说明、空格不影响认列", () => {
    const m = 规则猜列("opportunity", ["商机名称（必填）", "预计成交金额 (元)", "客户 名称"]);
    expect(m).toMatchObject({ "商机名称（必填）": "name", "预计成交金额 (元)": "amount", "客户 名称": "customerName" });
  });
});

describe("规则对值", () => {
  it("阶段：我们的阶段名原样认，丢单类写法认成输单（「未成交」不能被「成交」抢走）", () => {
    expect(规则对值("阶段", "方案报价")).toBe("方案报价");
    expect(规则对值("阶段", "输单")).toBe("输单");
    expect(规则对值("阶段", "未成交")).toBe("输单");
    expect(规则对值("阶段", "赢单")).toBe("赢单成交");
  });

  it("跟进方式：中文说法和英文值都认成英文值", () => {
    expect(规则对值("跟进类型", "电话沟通")).toBe("PHONE");
    expect(规则对值("跟进类型", "PHONE")).toBe("PHONE");
    expect(规则对值("跟进类型", "微信")).toBe("WECHAT");
  });

  it("认不出返回空串，不瞎猜", () => {
    expect(规则对值("阶段", "神秘阶段 X")).toBe("");
    expect(规则对值("跟进状态", "随便写的")).toBe("");
  });
});

describe("规则对负责人", () => {
  it("名字唯一命中才认；带邮箱按邮箱认；重名不认", () => {
    expect(规则对负责人("张伟", 成员们)).toBe("u-zhang");
    expect(规则对负责人("张伟（销售一部）", 成员们)).toBe("u-zhang");
    expect(规则对负责人("LiNa@acme.cn", 成员们)).toBe("u-li");
    expect(规则对负责人("王芳", 成员们)).toBe("");
    expect(规则对负责人("赵六", 成员们)).toBe("");
  });
});

describe("打码", () => {
  it("长数字只留头尾、邮箱藏本名、长文本截断", () => {
    expect(打码("13812345678")).toBe("138******78");
    expect(打码("lina@acme.cn")).toBe("***@acme.cn");
    expect(打码("一二三四五六七八九十一二三四五六七八九十一二三四五六")).toMatch(/…$/);
    expect(打码("123")).toBe("123");
  });
});

describe("选建议器", () => {
  it("传了就用传的；null = 不用 AI", async () => {
    const f: 建议器 = async () => ({});
    expect((await 选建议器(f)).建议器).toBe(f);
    expect((await 选建议器(null)).建议器).toBeNull();
  });

  it("ENT_IMPORT_AI=mock 走模拟，=off 不用", async () => {
    vi.stubEnv("ENT_IMPORT_AI", "mock");
    expect((await 选建议器()).建议器).toBe(模拟建议);
    vi.stubEnv("ENT_IMPORT_AI", "off");
    expect((await 选建议器()).建议器).toBeNull();
  });
});

describe("猜映射", () => {
  const 客户头 = ["客户名称", "手机", "负责人", "跟进状态", "主营产品"];
  const 客户行 = [
    ["甲公司", "13800000001", "张伟", "待跟进", "灯具"],
    ["乙公司", "13800000002", "zhangwei@acme.cn", "神秘状态", "五金"],
    ["丙公司", "13800000003", "Lina", "", ""],
  ];
  const 商机头 = ["客户名称", "商机名称", "商机阶段", "预计成交金额"];
  const 商机行 = [
    ["甲公司", "灯具订单", "需求确认", "10万"],
    ["乙公司", "五金订单", "谈判中", "5000"],
  ];

  it("不用 AI：规则认得出的都认上，认不出的留空并说明", async () => {
    const { 映射, 提醒 } = await 猜映射({
      表: [表("customer", 客户头, 客户行), 表("opportunity", 商机头, 商机行)],
      记录: [...记录("customer", 客户头, 客户行), ...记录("opportunity", 商机头, 商机行)],
      候选: 成员们,
      默认负责人Id: "u-zhang",
      建议器: null,
    });
    expect(映射.列.customer).toMatchObject({ 客户名称: "name", 手机: "phone", 负责人: "owner", 主营产品: 进备注 });
    expect(映射.负责人).toEqual({ 张伟: "u-zhang", "zhangwei@acme.cn": "u-zhang", Lina: "" });
    expect(映射.值.跟进状态).toEqual({ 待跟进: "待跟进", 神秘状态: "" });
    expect(映射.值.阶段.需求确认).toBe("需求确认");
    expect(映射.说明?.[说明键.人("张伟")]).toBe("规则");
    expect(提醒.join("\n")).toContain("没用 AI");
  });

  it("AI 建议要过校验：不在可选里的字段、不合法的值、重名或不存在的人一律丢掉", async () => {
    const 输入们: unknown[] = [];
    const 假AI: 建议器 = async (输入) => {
      输入们.push(输入);
      return {
        列: { customer: { 主营产品: "website", 客户名称: "remark", 不存在的列: "email" }, opportunity: { 商机名称: "nope" } },
        值: { 跟进状态: { 神秘状态: "已成交", 待跟进: "无效客户" }, 阶段: { 谈判中: "谈判审核" } },
        负责人: { Lina: "李娜", 张伟: "李娜" },
      };
    };
    const { 映射, 提醒 } = await 猜映射({
      表: [表("customer", 客户头, 客户行), 表("opportunity", 商机头, 商机行)],
      记录: [...记录("customer", 客户头, 客户行), ...记录("opportunity", 商机头, 商机行)],
      候选: 成员们,
      默认负责人Id: "u-zhang",
      建议器: 假AI,
    });
    // 只问规则认不出的；样例打过码
    const 问 = 输入们[0] as { 列: { customer: { 表头: string; 样例: string[] }[] }; 负责人: { 原写法: string[]; 成员: string[] } };
    expect(问.列.customer.map((c) => c.表头)).toEqual(["主营产品"]);
    expect(问.负责人.原写法).toEqual(["Lina"]);
    expect(问.负责人.成员).toEqual(["张伟", "李娜", "王芳"]);
    // 问了的列、可选里的字段 → 收
    expect(映射.列.customer?.主营产品).toBe("website");
    expect(映射.说明?.[说明键.列("customer", "主营产品")]).toBe("AI");
    // 没问的列（规则已认）不让 AI 改
    expect(映射.列.customer?.客户名称).toBe("name");
    // 值：只收问了的，且必须合法
    expect(映射.值.阶段.谈判中).toBe("谈判审核");
    expect(映射.值.跟进状态.待跟进).toBe("待跟进");
    // 人：问了、名单里唯一 → 收；没问的（张伟已规则认）不动
    expect(映射.负责人.Lina).toBe("u-li");
    expect(映射.负责人.张伟).toBe("u-zhang");
    expect(提醒.join("\n")).toMatch(/AI 补认了 \d+ 项/);
  });

  it("AI 报错不挡路：按规则的结果走，提醒里说清楚", async () => {
    const 坏AI: 建议器 = async () => {
      throw new Error("超时了");
    };
    const { 映射, 提醒 } = await 猜映射({
      表: [表("customer", 客户头, 客户行)],
      记录: 记录("customer", 客户头, 客户行),
      候选: 成员们,
      默认负责人Id: "u-zhang",
      建议器: 坏AI,
    });
    expect(映射.列.customer?.客户名称).toBe("name");
    expect(提醒.join("\n")).toContain("AI 这一步没成功（超时了）");
  });

  it("人手动改过的项，重新猜时不动", async () => {
    const 第一次 = await 猜映射({ 表: [表("customer", 客户头, 客户行)], 记录: 记录("customer", 客户头, 客户行), 候选: 成员们, 默认负责人Id: "u-zhang", 建议器: null });
    const 改 = 第一次.映射;
    改.列.customer!.主营产品 = "website";
    改.说明![说明键.列("customer", "主营产品")] = "手动";
    改.负责人.Lina = "u-li";
    改.说明![说明键.人("Lina")] = "手动";
    const 第二次 = await 猜映射({ 表: [表("customer", 客户头, 客户行)], 记录: 记录("customer", 客户头, 客户行), 候选: 成员们, 默认负责人Id: "u-zhang", 建议器: null, 已有: 改 });
    expect(第二次.映射.列.customer?.主营产品).toBe("website");
    expect(第二次.映射.负责人.Lina).toBe("u-li");
  });

  it("模拟模式：按中文名认列、按说法认值，一个人都不认", async () => {
    const 头 = ["客户名称", "所在国家", "跟进状态"];
    const 行 = [["甲", "德国", "已报价客户"]];
    const { 映射 } = await 猜映射({ 表: [表("customer", 头, 行)], 记录: 记录("customer", 头, 行), 候选: 成员们, 默认负责人Id: "u-zhang", 建议器: 模拟建议 });
    expect(映射.列.customer?.所在国家).toBe("country");
  });

  it("缺名称列、挂不到客户时直接提醒", async () => {
    const 头 = ["联系人姓名", "手机"];
    const { 提醒 } = await 猜映射({ 表: [表("contact", 头, [["小王", "138"]])], 记录: [], 候选: 成员们, 默认负责人Id: "u-zhang", 建议器: null });
    expect(提醒.join("\n")).toContain("联系人表没认出「所属客户」列");
  });
});

describe("Excel 读表", () => {
  it("按文件名猜类别，联系人优先于客户", () => {
    expect(猜实体("客户联系人导出.xlsx", [])).toBe("contact");
    expect(猜实体("商机跟进记录.csv", [])).toBe("followup");
    expect(猜实体("export.csv", ["商机名称", "阶段"])).toBe("opportunity");
    expect(猜实体("export.csv", ["a", "b"])).toBeNull();
  });

  it("CSV：空表头叫第 N 列、重名列加序号、空行不算；没有 ID 列时稳定 ID 换一次导出不变", () => {
    const csv = "客户名称,手机,,备注,备注\n甲公司,138 0000 0001,x,a,b\n,,,,\n乙公司,13800000002,,,\n";
    const t = 读文件({ 名: "客户.csv", bytes: new TextEncoder().encode(csv) });
    expect(t.实体).toBe("customer");
    expect(t.表头).toEqual(["客户名称", "手机", "第 3 列", "备注", "备注（2）"]);
    expect(t.行).toHaveLength(2);
    const 列 = 规则猜列("customer", t.表头);
    const a = 成记录(t, "customer", 列);
    expect(a[0].外部ID).toMatch(/^h:/);
    // 电话写法不同（空格）也是同一个 ID
    const t2 = 读文件({ 名: "客户.csv", bytes: new TextEncoder().encode("客户名称,手机\n甲公司,13800000001\n") });
    expect(成记录(t2, "customer", 规则猜列("customer", t2.表头))[0].外部ID).toBe(a[0].外部ID);
  });

  it("有 ID 列就用原系统 ID", () => {
    const t = 读文件({ 名: "客户.csv", bytes: new TextEncoder().encode("记录ID,客户名称\nrec001,甲公司\n") });
    expect(成记录(t, "customer", 规则猜列("customer", t.表头))[0].外部ID).toBe("rec001");
  });
});
