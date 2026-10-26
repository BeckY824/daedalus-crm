/**
 * 企业版导入 · 试跑报告：读出的表 → 猜映射 → 清洗 → 报告 + preview 批次（一条都不写进客户表）。
 * AI 只用测试里的假建议器或不用（null），不调真的模型。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { saveBusiness } from "@/lib/business";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { 试跑, 重新试跑, 合并改动 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 说明键, type AI输入, type 建议器 } from "@/lib/enterprise-import/mapping";
import { 读文件们, type 读出的表 } from "@/lib/enterprise-import/excel";
import type { 实体, 映射 } from "@/lib/enterprise-import/types";

function 表(名: string, 实体: 实体 | null, 表头: string[], 行: string[][]): 读出的表 {
  return { 名, 实体, 表头, 行, 行号: 行.map((_, i) => i + 2), 提醒: [] };
}

/** 几天前的日期（YYYY-MM-DD） */
function 天前(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const 客户表 = () =>
  表("客户.xlsx", "customer", ["记录ID", "客户名称", "手机号码", "客户负责人", "客户等级", "主营产品"], [
    ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", "服务器"],
    ["C2", "宁波海川贸易", "13800000002", "李娜", "B", "外贸"],
    ["C3", "苏州老客户", "13900000009", "不认识的人", "", ""],
  ]);

const 跟进表 = () =>
  表("跟进记录.xlsx", "followup", ["客户ID", "客户名称", "跟进方式", "跟进内容", "跟进时间"], [
    ["C1", "杭州云帆科技有限公司", "电话", "聊了报价", 天前(90)],
    ["C2", "宁波海川贸易", "拜访", "上门看样", 天前(3)],
    ["C3", "苏州老客户", "电话", "老客户回访", 天前(200)],
  ]);

const 商机表 = () =>
  表("商机.xlsx", "opportunity", ["商机ID", "客户ID", "商机名称", "商机阶段", "商机金额"], [["O1", "C1", "服务器采购", "第三步", "12万"]]);

let 张伟 = "";
let 李娜 = "";

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: "tester-id", email: "t@x", name: "测试员", title: "管理员", role: "ADMIN", password: "x" } });
  张伟 = (await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } })).id;
  李娜 = (await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("试跑", () => {
  it("出报告、存 preview 批次，不往客户表写一条", async () => {
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表(), 跟进表()], 建议器: null });

    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.followUp.count()).toBe(0);

    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批次Id } });
    expect(批).toMatchObject({ source: "excel", kind: "full", status: "preview", userId: "tester-id", total: 6, skipped: 0 });
    expect(JSON.parse(批.raw!)).toHaveLength(2);
    expect(JSON.parse(批.plan!)).toHaveLength(6);
    const m: 映射 = JSON.parse(批.mapping!);
    expect(m.列.customer).toMatchObject({ 记录ID: "id", 客户名称: "name", 手机号码: "phone", 客户负责人: "owner", 客户等级: "level" });

    expect(报告.合计).toMatchObject({ 记录: 6, 待写: 6, 跳过: 0 });
    expect(报告.按类.customer.新建).toBe(3);
    expect(报告.文件.map((f) => [f.名, f.实体, f.行数])).toEqual([
      ["客户.xlsx", "customer", 3],
      ["跟进记录.xlsx", "followup", 3],
    ]);
    // 负责人：张伟、李娜对上；不认识的落默认负责人（只有两个业务员，唯一负责人认不出 → 导入的人）并记一条提醒
    expect(报告.映射.负责人).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 写法: "张伟", 成员Id: 张伟, 成员名: "张伟" }),
        expect.objectContaining({ 写法: "李娜", 成员Id: 李娜 }),
        expect.objectContaining({ 写法: "不认识的人", 成员Id: "" }),
      ]),
    );
    expect([张伟, 李娜]).toContain(报告.映射.默认负责人.id); // 导入的人是管理员、不能当负责人：默认落到能任的人，和实际写入一致
    expect(报告.问题分类).toContainEqual({ 实体: "customer", 级别: "提醒", 类别: "负责人对不上", 数: 1 });
    // 列的报告：落到哪、谁认的、几条样例
    const 列 = 报告.映射.列.customer!;
    expect(列.find((c) => c.表头 === "主营产品")).toMatchObject({ 字段名: "拼进备注", 样例: ["服务器", "外贸"] });
    expect(列.find((c) => c.表头 === "客户名称")).toMatchObject({ 字段: "name", 说明: "规则" });
    // 样例不带原始字段和指纹
    expect(报告.样例.customer![0]).not.toHaveProperty("原始");
    expect(报告.样例.customer![0]).not.toHaveProperty("指纹");
    expect(报告.提醒).toContain("没用 AI，只按规则认");
    expect(报告.公海).toBeNull();
  });

  it("认出我们这边已有的：同号连上、对照表里有的走对照", async () => {
    const 老 = await prisma.customer.create({ data: { name: "苏州老客户（本地）", phone: "13900000009", salesOwnerId: 张伟 } });
    const 导过 = await prisma.customer.create({ data: { name: "宁波海川", phone: "13500000000", salesOwnerId: 李娜 } });
    await prisma.entExternalRef.create({
      data: { source: "excel", entity: "customer", externalId: "C2", targetId: 导过.id, fingerprint: "x", written: "{}", raw: "{}" },
    });
    // 别的来源的同一个外部 ID 不算
    await prisma.entExternalRef.create({
      data: { source: "feishu", entity: "customer", externalId: "C1", targetId: 导过.id, fingerprint: "x", written: "{}", raw: "{}" },
    });

    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表()], 建议器: null });
    const plan = JSON.parse((await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批次Id } })).plan!);
    const 看 = (id: string) => plan.find((w: { 外部ID: string }) => w.外部ID === id);
    expect(看("C1").目标).toBeUndefined();
    expect(看("C2").目标).toEqual({ 本地ID: 导过.id, 方式: "对照" });
    expect(看("C3").目标).toEqual({ 本地ID: 老.id, 方式: "同号" });
    expect(报告.问题).toContainEqual(expect.objectContaining({ 外部ID: "C3", 类别: "重名", 出处: "客户.xlsx", 行号: 4 }));
    expect(await prisma.customer.count()).toBe(2);
  });

  it("开了自动掉公海：只数新建、超过天数没跟进、状态不是已签约 / 已流失的客户", async () => {
    await saveBusiness({ ...DEFAULT_BUSINESS, poolDays: 30 });
    invalidateSettingsCache();
    // C3 连上本地同号客户，不算
    await prisma.customer.create({ data: { name: "苏州老客户", phone: "13900000009", salesOwnerId: 张伟 } });

    const { 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表(), 跟进表()], 建议器: null });
    // C1 90 天前跟进 → 会掉；C2 3 天前 → 不掉；C3 连上已有 → 不算
    expect(报告.公海).toEqual({ 天数: 30, 会掉: 1 });
    expect(报告.提醒.some((s) => s.includes("30 天没跟进放进公海") && s.includes("有 1 个"))).toBe(true);
  });

  it("已签约的客户不算会掉公海", async () => {
    await saveBusiness({ ...DEFAULT_BUSINESS, poolDays: 30 });
    invalidateSettingsCache();
    const t = 客户表();
    t.表头.push("跟进状态");
    t.行[0].push("已签约");
    const { 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [t, 跟进表()], 建议器: null });
    // 只剩 C3（200 天前）
    expect(报告.公海).toEqual({ 天数: 30, 会掉: 1 });
  });

  it("认不出类别的文件不算进来、原表照存，报告里提醒人选", async () => {
    const 不明 = 表("导出1.xlsx", null, ["姓名", "手机", "客户ID"], [["王经理", "13700000001", "C1"]]);
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表(), 不明], 建议器: null });
    expect(报告.合计.记录).toBe(3);
    expect(报告.文件).toContainEqual({ 名: "导出1.xlsx", 实体: null, 行数: 1, 提醒: [] });
    expect(报告.提醒.some((s) => s.startsWith("「导出1.xlsx」认不出"))).toBe(true);
    expect(JSON.parse((await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批次Id } })).raw!)).toHaveLength(2);
  });
});

describe("重新试跑", () => {
  it("选了类别、改了列：人改的标手动，上次 AI 认的照留，不再问 AI，覆盖同一个批次", async () => {
    const 问过: AI输入[] = [];
    const 假AI: 建议器 = async (输入) => {
      问过.push(输入);
      const 值: Record<string, Record<string, string>> = {};
      for (const [k, x] of Object.entries(输入.值)) for (const v of x.原值) (值[k] ??= {})[v] = x.可选[0];
      return { 列: {}, 值, 负责人: {} };
    };
    const 不明 = 表("导出1.xlsx", null, ["姓名", "手机", "客户ID"], [["王经理", "13700000001", "C1"]]);
    const 首次 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表(), 商机表(), 不明], 建议器: 假AI });
    expect(问过).toHaveLength(1);
    const AI认的 = 首次.报告.映射.值.find((v) => v.名 === "阶段" && v.原值 === "第三步");
    expect(AI认的?.说明).toBe("AI");

    const 再 = await 重新试跑(首次.批次Id, { 文件实体: { "导出1.xlsx": "contact" }, 列: { customer: { 主营产品: "" } } }, "tester-id");
    expect(再.批次Id).toBe(首次.批次Id);
    expect(问过).toHaveLength(1);
    expect(await prisma.entImportBatch.count()).toBe(1);

    const r = 再.报告;
    expect(r.文件.find((f) => f.名 === "导出1.xlsx")?.实体).toBe("contact");
    expect(r.按类.contact.新建).toBe(1);
    expect(r.映射.列.customer!.find((c) => c.表头 === "主营产品")).toMatchObject({ 字段: "", 字段名: "不用", 说明: "手动" });
    expect(r.映射.值.find((v) => v.名 === "阶段" && v.原值 === "第三步")).toMatchObject({ 我们的值: AI认的!.我们的值, 说明: "AI" });
    expect(r.提醒).toContain("改了映射重新试跑：人改的和上次 AI 认的都留着，这次没再问 AI");
    expect(r.提醒).not.toContain("没用 AI，只按规则认");
    // 存进库的那份报告也是改过提醒的
    const 存的 = JSON.parse((await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 首次.批次Id } })).report!);
    expect(存的.提醒).toContain("改了映射重新试跑：人改的和上次 AI 认的都留着，这次没再问 AI");
  });

  it("批次已经开始导入就不能再改；接口来的能重跑；没存原样的不行", async () => {
    const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: [客户表()], 建议器: null });
    await prisma.entImportBatch.update({ where: { id: 批次Id }, data: { status: "running" } });
    await expect(重新试跑(批次Id, {}, "tester-id")).rejects.toThrow("已经开始导入");

    const 接口批 = await 试跑({
      来源: "feishu",
      用户Id: "tester-id",
      记录: [{ 实体: "customer", 外部ID: "fs1", 字段: { 客户名称: "飞书客户", 电话: "13600000000" } }],
      建议器: null,
    });
    // 接口来的首次导入存了原始记录：能改映射重新试跑（和 Excel 一样，不再问 AI）
    const 再 = await 重新试跑(接口批.批次Id, { 默认负责人Id: "tester-id" }, "tester-id");
    expect(再.批次Id).toBe(接口批.批次Id);
    expect(再.报告.合计.记录).toBe(1);
    expect(再.报告.按类.customer.新建).toBe(1);
    // 什么都没存的（老批次）还是不行
    await prisma.entImportBatch.update({ where: { id: 接口批.批次Id }, data: { raw: null } });
    await expect(重新试跑(接口批.批次Id, {}, "tester-id")).rejects.toThrow("没存原表");
    await expect(重新试跑("nope", {}, "tester-id")).rejects.toThrow("找不到");
  });
});

describe("客户表里带联系人：导进库里的样子", () => {
  const 我 = { id: "tester-id", name: "测试员" };
  /** 库里的联系人：所属客户|姓名|电话|邮箱，排好序 */
  const 库里联系人 = async () =>
    (await prisma.contact.findMany({ select: { name: true, phone: true, email: true, customer: { select: { name: true } } } }))
      .map((c) => [c.customer.name, c.name, c.phone ?? "", c.email ?? ""].join("|"))
      .sort();

  it("只有一列「联系人」、一格里连名字带电话 / 邮箱、一格几个人：进库时名字是名字、电话是电话、几个人是几条", async () => {
    const csv = "客户名称,联系人\n甲公司,张三 13800000001\n乙公司,李四（13900000002）；王五 wangwu@x.com\n丙公司,赵六\n";
    const 表们 = 读文件们({ 名: "客户.csv", bytes: new TextEncoder().encode(csv) });
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 表们, 建议器: null });
    expect(报告.按类.contact.待写).toBe(4);
    await 写一批(批次Id, 我);
    expect(await 库里联系人()).toEqual(["丙公司|赵六||", "乙公司|李四|13900000002|", "乙公司|王五||wangwu@x.com", "甲公司|张三|13800000001|"].sort());
  });

  it("人选的类别定了才拆：猜成联系人、人改成客户就按客户拆；猜成客户、人改成线索就不拆（上传时选、试跑后改都一样）", async () => {
    const 读 = (名: string, csv: string) => 读文件们({ 名, bytes: new TextEncoder().encode(csv) });
    const 名单 = "名称,联系人姓名,联系人手机\n甲公司,张三,13800000001\n甲公司,李四,13800000002\n";
    const 文件 = (r: { 报告: { 文件: { 名: string; 实体: 实体 | null; 行数: number }[] } }) => r.报告.文件.map((f) => [f.名, f.实体, f.行数]);
    expect(读("名单.csv", 名单).map((t) => t.实体)).toEqual(["contact"]); // 按表头猜成了联系人

    // 上传时就选了客户（上传接口：读完按表单改类别，再试跑）
    const 选了 = 读("名单.csv", 名单).map((t) => ({ ...t, 实体: "customer" as const }));
    expect(文件(await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 选了, 建议器: null }))).toEqual([
      ["名单.csv", "customer", 1],
      ["名单.csv（联系人）", "contact", 2],
    ]);

    // 试跑后在报告上改成客户，重新试跑、导入
    const 首次 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 读("名单.csv", 名单), 建议器: null });
    const 再 = await 重新试跑(首次.批次Id, { 文件实体: { "名单.csv": "customer" } }, "tester-id");
    expect(文件(再)).toEqual([
      ["名单.csv", "customer", 1],
      ["名单.csv（联系人）", "contact", 2],
    ]);
    await 写一批(再.批次Id, 我);
    expect(await prisma.customer.findMany({ select: { name: true } })).toEqual([{ name: "甲公司" }]);
    expect(await 库里联系人()).toEqual(["甲公司|张三|13800000001|", "甲公司|李四|13800000002|"].sort());

    // 反过来：猜成客户、人改成线索，联系人那几列留在线索表里，不另拆
    const 客户 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 读("客户.csv", "客户名称,联系人姓名,联系人手机\n丁公司,赵六,13800000003\n"), 建议器: null });
    expect(文件(客户)).toEqual([
      ["客户.csv", "customer", 1],
      ["客户.csv（联系人）", "contact", 1],
    ]);
    expect(文件(await 重新试跑(客户.批次Id, { 文件实体: { "客户.csv": "lead" } }, "tester-id"))).toEqual([["客户.csv", "lead", 1]]);
  });

  it("客户表的编号列没当「原系统 ID」用：拆出来的联系人不拿那个编号去认客户，不会挂到以前导过、外部 ID 恰好一样的别家", async () => {
    const 读 = (名: string, csv: string) => 读文件们({ 名, bytes: new TextEncoder().encode(csv) });
    // 以前导过一家，原系统 ID 是 R1
    const 旧 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 读("旧客户.csv", "记录ID,客户名称\nR1,旧公司\n"), 建议器: null });
    await 写一批(旧.批次Id, 我);
    // 这次的表里「记录ID」是另一套编号，人在报告上改成「不用」
    const 首次 = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 读("客户.csv", "记录ID,客户名称,联系人\nR1,新公司,张三\n"), 建议器: null });
    const 再 = await 重新试跑(首次.批次Id, { 列: { customer: { 记录ID: "" } } }, "tester-id");
    expect(再.报告.提醒.join("\n")).toMatch(/所属客户ID抄自客户表的「记录ID」.*按客户名称挂/);
    await 写一批(再.批次Id, 我);
    expect(await 库里联系人()).toEqual(["新公司|张三||"]);
  });

  it("客户表带联系人、另有一张联系人表：同名、同一家客户的只导一个（按联系人表那条），另提醒", async () => {
    const 读 = (名: string, csv: string) => 读文件们({ 名, bytes: new TextEncoder().encode(csv) });
    const 表们 = [
      ...读("客户.csv", "客户ID,客户名称,联系人,联系人电话\nK1,甲公司,张三,13800000009\nK2,乙公司,张三,13800000003\n"),
      ...读("联系人.csv", "联系人姓名,所属客户ID,手机\n张三,K1,13800000001\n李四,K1,13800000002\n"),
    ].map((t) => ({ ...t, 实体: t.名 === "客户.csv" ? ("customer" as const) : ("contact" as const) }));
    const { 批次Id, 报告 } = await 试跑({ 来源: "excel", 用户Id: "tester-id", 表: 表们, 建议器: null });
    expect(报告.按类.contact.待写).toBe(3);
    expect(报告.提醒.join("\n")).toMatch(/「客户\.csv（联系人）」里有 1 个联系人单独的联系人表里也有/);
    await 写一批(批次Id, 我);
    // 乙公司的张三只在客户表里，照导
    expect(await 库里联系人()).toEqual(["甲公司|张三|13800000001|", "甲公司|李四|13800000002|", "乙公司|张三|13800000003|"].sort());
  });
});

describe("合并改动", () => {
  it("改的列、值、负责人都标手动，原映射不动", () => {
    const 原: 映射 = {
      列: { customer: { 名称: "name" } },
      负责人: { 老王: "" },
      值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} },
      默认负责人Id: "u1",
      说明: { [说明键.列("customer", "名称")]: "规则" },
    };
    const 新 = 合并改动(原, { 列: { customer: { 电话: "phone" } }, 值: { 阶段: { 谈判: "谈判审核" } }, 负责人: { 老王: "u2" }, 默认负责人Id: "u3" })!;
    expect(新.列.customer).toEqual({ 名称: "name", 电话: "phone" });
    expect(新.值.阶段).toEqual({ 谈判: "谈判审核" });
    expect(新.负责人).toEqual({ 老王: "u2" });
    expect(新.默认负责人Id).toBe("u3");
    expect(新.说明).toMatchObject({
      [说明键.列("customer", "名称")]: "规则",
      [说明键.列("customer", "电话")]: "手动",
      [说明键.值("阶段", "谈判")]: "手动",
      [说明键.人("老王")]: "手动",
    });
    expect(原.列.customer).toEqual({ 名称: "name" });
    expect(合并改动(null, {})).toBeNull();
  });
});
