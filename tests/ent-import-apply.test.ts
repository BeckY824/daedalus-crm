/**
 * 企业版导入 · 正式写入：试跑出 preview 批次 → 写一批。
 * 新建五类、同号连上已有客户只补空、本批同号并入、重跑不重复、三方比对 / 冲突、本地已删、结单日期、负责人退回、分段续写。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import type { 读出的表 } from "@/lib/enterprise-import/excel";
import type { 实体, 待写 } from "@/lib/enterprise-import/types";

function 表(名: string, 实体: 实体, 表头: string[], 行: string[][]): 读出的表 {
  return { 名, 实体, 表头, 行, 行号: 行.map((_, i) => i + 2), 提醒: [] };
}

const 客户头 = ["记录ID", "客户名称", "手机号码", "客户负责人", "客户等级", "备注"];
const 客户表 = (行: string[][] = [
  ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", "老客户"],
  ["C2", "宁波海川贸易", "13800000002", "李娜", "B", ""],
]) => 表("客户.xlsx", "customer", 客户头, 行);

const 联系人表 = () => 表("联系人.xlsx", "contact", ["联系人ID", "客户ID", "姓名", "职位", "手机"], [["P1", "C1", "王经理", "采购", "13700000001"]]);
const 线索表 = () => 表("线索.xlsx", "lead", ["线索ID", "线索名称", "联系人", "电话", "负责人"], [["L1", "温州小厂", "陈总", "13600000001", "李娜"]]);
const 商机表 = (行: string[][] = [
  ["O1", "C1", "服务器采购", "需求确认", "12万", ""],
  ["O2", "C2", "外贸样品", "赢单", "3万", "2025-03-05"],
]) => 表("商机.xlsx", "opportunity", ["商机ID", "客户ID", "商机名称", "商机阶段", "商机金额", "成交日期"], 行);
const 跟进表 = () =>
  表("跟进记录.xlsx", "followup", ["跟进ID", "客户ID", "商机ID", "跟进方式", "跟进内容", "跟进时间"], [
    ["F1", "C1", "O1", "电话", "聊了报价", "2025-06-01 10:00"],
    ["F2", "C1", "", "拜访", "上门看样", "2025-07-01 15:00"],
    ["F3", "C2", "", "电话", "回访", "2025-05-01 09:00"],
  ]);

/** 表里只写日期 = 本地那天零点 */
const 本地日 = (d: string) => new Date(`${d}T00:00:00`);

const 我 = { id: "tester-id", name: "测试员" };
let 张伟 = "";
let 李娜 = "";

async function 跑(表们: 读出的表[]) {
  const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
  return 批次Id;
}
async function 导(表们: 读出的表[]) {
  const id = await 跑(表们);
  return { id, r: await 写一批(id, 我) };
}
const 对照 = (entity: string, externalId: string) =>
  prisma.entExternalRef.findUniqueOrThrow({ where: { source_entity_externalId: { source: "excel", entity, externalId } } });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  张伟 = (await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } })).id;
  李娜 = (await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("首次导入", () => {
  it("五类都写进去，挂对父记录、负责人；批次 done、记操作日志", async () => {
    const { id, r } = await 导([客户表(), 联系人表(), 线索表(), 商机表(), 跟进表()]);
    expect(r).toMatchObject({ 状态: "done", 完了: true, 总数: 9, 写到: 9, 新建: 9, 更新: 0, 冲突: 0, 失败: 0 });

    const c1 = await prisma.customer.findFirstOrThrow({ where: { name: "杭州云帆科技有限公司" }, include: { extra: true } });
    expect(c1).toMatchObject({ phone: "13800000001", salesOwnerId: 张伟, remark: "老客户" });
    expect(c1.extra?.level).toBe("A");
    // 最近跟进 = 原系统最新那条，不是导入这一天
    expect(c1.lastFollowAt).toEqual(new Date("2025-07-01T15:00:00"));

    const p1 = await prisma.contact.findFirstOrThrow({ where: { name: "王经理" } });
    expect(p1).toMatchObject({ customerId: c1.id, position: "采购", phone: "13700000001" });
    expect(await prisma.lead.findFirstOrThrow({ where: { name: "温州小厂" } })).toMatchObject({ ownerId: 李娜, contact: "陈总" });

    const o1 = await prisma.opportunity.findFirstOrThrow({ where: { name: "服务器采购" }, include: { closed: true } });
    expect(o1).toMatchObject({ customerId: c1.id, amount: 120000, status: "OPEN", ownerId: 张伟 });
    expect(o1.closed).toBeNull();
    const o2 = await prisma.opportunity.findFirstOrThrow({ where: { name: "外贸样品" }, include: { closed: true } });
    expect(o2).toMatchObject({ status: "WON", stage: "赢单成交" });
    expect(o2.closed?.closedAt).toEqual(本地日("2025-03-05"));

    const f1 = await prisma.followUp.findFirstOrThrow({ where: { content: "聊了报价" } });
    expect(f1).toMatchObject({ customerId: c1.id, opportunityId: o1.id, ownerId: 张伟 });
    expect(f1.occurredAt.toISOString()).toBe(new Date("2025-06-01T10:00:00").toISOString());

    expect(await prisma.entExternalRef.count()).toBe(9);
    expect(await prisma.entImportRow.count({ where: { batchId: id, kind: "create" } })).toBe(9);
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id } });
    expect(批.finishedAt).not.toBeNull();
    const 日志 = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id } });
    expect(日志).toMatchObject({ action: "ent-import", entity: "EntImportBatch" });
    expect(日志.summary).toContain("新建 9 条");
  });

  it("写完再调一次不重复写；同一批同时跑两份也只写一份", async () => {
    const id = await 跑([客户表(), 商机表(), 跟进表()]);
    const [a, b] = await Promise.all([写一批(id, 我), 写一批(id, 我)]);
    expect(a.完了 || b.完了).toBe(true);
    const 再 = await 写一批(id, 我);
    expect(再).toMatchObject({ 完了: true, 新建: 7, 失败: 0 });
    expect(await prisma.customer.count()).toBe(2);
    expect(await prisma.opportunity.count()).toBe(2);
    expect(await prisma.followUp.count()).toBe(3);
    expect(await prisma.entExternalRef.count()).toBe(7);
  });

  it("分段：每趟时间到就停，记下游标，再调接着写", async () => {
    const 行 = Array.from({ length: 60 }, (_, i) => [`C${i}`, `公司${i}`, `1380000${String(i).padStart(4, "0")}`, "张伟", "", ""]);
    const id = await 跑([客户表(行)]);
    const 一 = await 写一批(id, 我, { 段长毫秒: 0 });
    // 段长 0：也至少写一趟（25 条）
    expect(一).toMatchObject({ 状态: "applying", 完了: false, 写到: 25, 新建: 25 });
    let r = 一;
    let 趟 = 0;
    while (!r.完了 && 趟++ < 10) r = await 写一批(id, 我, { 段长毫秒: 0 });
    expect(趟).toBe(2);
    expect(r).toMatchObject({ 完了: true, 写到: 60, 新建: 60 });
    expect(await prisma.customer.count()).toBe(60);
  });

  it("负责人不在职 / 是管理员：退回默认负责人；离职的人上次是负责人也不用", async () => {
    await prisma.user.update({ where: { id: 李娜 }, data: { active: false } });
    await 导([客户表()]);
    const c2 = await prisma.customer.findFirstOrThrow({ where: { name: "宁波海川贸易" } });
    expect(c2.salesOwnerId).not.toBe(李娜);
    expect([张伟]).toContain(c2.salesOwnerId);
  });

  it("所属客户不在了：这一条记成没写进去，别的照写", async () => {
    const id = await 跑([客户表(), 联系人表()]);
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id } });
    const 计划: 待写[] = JSON.parse(批.plan!);
    const p = 计划.find((w) => w.实体 === "contact")!;
    p.父客户 = { 本地ID: "不存在的客户" };
    await prisma.entImportBatch.update({ where: { id }, data: { plan: JSON.stringify(计划) } });

    const r = await 写一批(id, 我);
    expect(r).toMatchObject({ 完了: true, 新建: 2, 失败: 1 });
    expect(await prisma.contact.count()).toBe(0);
    const note = JSON.parse((await prisma.entImportBatch.findUniqueOrThrow({ where: { id } })).note!);
    expect(note).toEqual([expect.objectContaining({ 实体: "contact", 外部ID: p.外部ID, 原因: expect.stringContaining("所属客户不在了") })]);
  });
});

describe("同号", () => {
  it("我们这边早有同号客户：连上它，只补空格，负责人和名字不动", async () => {
    const 老 = await prisma.customer.create({ data: { name: "云帆（老档）", phone: "13800000001", salesOwnerId: 李娜, followStatus: "跟进中" } });
    const { r } = await 导([客户表()]);
    expect(r).toMatchObject({ 新建: 1, 更新: 1 });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: 老.id }, include: { extra: true } });
    expect(c).toMatchObject({ name: "云帆（老档）", salesOwnerId: 李娜, followStatus: "跟进中", remark: "老客户" });
    expect(c.extra?.level).toBe("A");
    expect((await 对照("customer", "C1")).targetId).toBe(老.id);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("同一批里两条同号：后一条并进前一条，子记录挂得上", async () => {
    const { r } = await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", ""],
        ["C9", "杭州云帆科技", "13800000001", "张伟", "", ""],
      ]),
      表("联系人.xlsx", "contact", ["联系人ID", "客户ID", "姓名"], [["P9", "C9", "赵工"]]),
    ]);
    expect(r).toMatchObject({ 新建: 2, 失败: 0 });
    expect(await prisma.customer.count()).toBe(1);
    const c = await prisma.customer.findFirstOrThrow();
    expect((await 对照("customer", "C9")).targetId).toBe(c.id);
    expect((await prisma.contact.findFirstOrThrow()).customerId).toBe(c.id);
  });
});

describe("再导一次（同步）", () => {
  it("原系统没变：全跳过", async () => {
    await 导([客户表(), 商机表()]);
    const { r } = await 导([客户表(), 商机表()]);
    expect(r).toMatchObject({ 新建: 0, 更新: 0, 冲突: 0, 跳过: 4 });
  });

  it("三方比对：我们没动的格子照原系统改，两边都改了记冲突、不覆盖", async () => {
    await 导([客户表()]);
    const c1 = await prisma.customer.findFirstOrThrow({ where: { name: "杭州云帆科技有限公司" } });
    // 我们这边改了备注
    await prisma.customer.update({ where: { id: c1.id }, data: { remark: "我们改的备注" } });

    const { id, r } = await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000011", "张伟", "A", "原系统改的备注"],
        ["C2", "宁波海川贸易", "13800000002", "李娜", "B", ""],
      ]),
    ]);
    expect(r).toMatchObject({ 冲突: 1, 跳过: 1 });
    const 现 = await prisma.customer.findUniqueOrThrow({ where: { id: c1.id } });
    expect(现).toMatchObject({ phone: "13800000011", remark: "我们改的备注" });

    const 冲 = await prisma.entConflict.findFirstOrThrow();
    expect(冲).toMatchObject({ source: "excel", entity: "customer", externalId: "C1", targetId: c1.id, status: "待定", localDeleted: false, batchId: id });
    expect(JSON.parse(冲.fields)).toEqual({ remark: { 原系统: "原系统改的备注", 我们: "我们改的备注", 上次: "老客户" } });
    // 对照里手机号已经是新的，备注还是上次的（等人定）
    const ref = JSON.parse((await 对照("customer", "C1")).written);
    expect(ref).toMatchObject({ phone: "13800000011", remark: "老客户" });
    // 撤回要用：改之前的值
    const 行 = await prisma.entImportRow.findFirstOrThrow({ where: { batchId: id, externalId: "C1" } });
    expect(JSON.parse(行.before!)).toEqual({ phone: "13800000001" });
    expect(JSON.parse(行.written)).toEqual({ phone: "13800000011" });
    expect(行.refBefore).not.toBeNull();

    // 再来一次同样的：冲突不越记越多
    await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000011", "张伟", "A", "原系统又改了"],
        ["C2", "宁波海川贸易", "13800000002", "李娜", "B", ""],
      ]),
    ]);
    expect(await prisma.entConflict.count()).toBe(1);
    expect(JSON.parse((await prisma.entConflict.findFirstOrThrow()).fields).remark.原系统).toBe("原系统又改了");
  });

  it("两边改成一样的：不算冲突", async () => {
    await 导([客户表()]);
    await prisma.customer.updateMany({ where: { name: "宁波海川贸易" }, data: { remark: "一样的" } });
    const { r } = await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", "老客户"],
        ["C2", "宁波海川贸易", "13800000002", "李娜", "B", "一样的"],
      ]),
    ]);
    expect(r.冲突).toBe(0);
    expect(JSON.parse((await 对照("customer", "C2")).written).remark).toBe("一样的");
  });

  it("我们这边已经删了：记冲突（本地已删），不重建", async () => {
    await 导([客户表()]);
    await prisma.customer.deleteMany({ where: { name: "宁波海川贸易" } });
    const { r } = await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", "老客户"],
        ["C2", "宁波海川贸易", "13800000002", "李娜", "B", "改了"],
      ]),
    ]);
    expect(r).toMatchObject({ 冲突: 1, 新建: 0 });
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.entConflict.findFirstOrThrow()).toMatchObject({ externalId: "C2", localDeleted: true });
  });

  it("商机原系统改成赢单：带上结单日期；改回进行中：结单记录删掉", async () => {
    await 导([客户表(), 商机表()]);
    await 导([客户表(), 商机表([
      ["O1", "C1", "服务器采购", "赢单", "12万", "2025-08-08"],
      ["O2", "C2", "外贸样品", "赢单", "3万", "2025-03-05"],
    ])]);
    const o1 = await prisma.opportunity.findFirstOrThrow({ where: { name: "服务器采购" }, include: { closed: true } });
    expect(o1.status).toBe("WON");
    expect(o1.closed?.closedAt).toEqual(本地日("2025-08-08"));

    await 导([客户表(), 商机表([
      ["O1", "C1", "服务器采购", "需求确认", "12万", ""],
      ["O2", "C2", "外贸样品", "赢单", "3万", "2025-03-05"],
    ])]);
    const 又 = await prisma.opportunity.findFirstOrThrow({ where: { name: "服务器采购" }, include: { closed: true } });
    expect(又.status).toBe("OPEN");
    expect(又.closed).toBeNull();
  });
});
