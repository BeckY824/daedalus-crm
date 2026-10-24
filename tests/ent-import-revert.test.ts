/**
 * 企业版导入 · 整批撤回 / 恢复。
 * 五类全撤再恢复（同 id、对照、结单、最近跟进）、导入后改过 / 挂了外面的记录留下、同号补空改回去、本批同号并入、
 * 之后的同步挡住前一批、同步批撤回改回旧值和旧对照、冲突已撤回、本地已删、分段续撤、两边同时撤、恢复时跳过又导进来的、撤完重导。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 撤回一批, 恢复一批 } from "@/lib/enterprise-import/revert";
import type { 读出的表 } from "@/lib/enterprise-import/excel";
import type { 实体 } from "@/lib/enterprise-import/types";

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
const 商机表 = () =>
  表("商机.xlsx", "opportunity", ["商机ID", "客户ID", "商机名称", "商机阶段", "商机金额", "成交日期"], [
    ["O1", "C1", "服务器采购", "需求确认", "12万", ""],
    ["O2", "C2", "外贸样品", "赢单", "3万", "2025-03-05"],
  ]);
const 跟进表 = () =>
  表("跟进记录.xlsx", "followup", ["跟进ID", "客户ID", "商机ID", "跟进方式", "跟进内容", "跟进时间"], [
    ["F1", "C1", "O1", "电话", "聊了报价", "2025-06-01 10:00"],
    ["F2", "C1", "", "拜访", "上门看样", "2025-07-01 15:00"],
    ["F3", "C2", "", "电话", "回访", "2025-05-01 09:00"],
  ]);

const 我 = { id: "tester-id", name: "测试员" };
let 张伟 = "";

async function 导(表们: 读出的表[]) {
  const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
  const r = await 写一批(批次Id, 我);
  expect(r.完了).toBe(true);
  return 批次Id;
}
const 对照 = (entity: string, externalId: string) =>
  prisma.entExternalRef.findUnique({ where: { source_entity_externalId: { source: "excel", entity, externalId } } });
const 客户 = (name: string) => prisma.customer.findFirst({ where: { name }, include: { extra: true } });
const 数 = async () => ({
  客户: await prisma.customer.count(),
  联系人: await prisma.contact.count(),
  线索: await prisma.lead.count(),
  商机: await prisma.opportunity.count(),
  跟进: await prisma.followUp.count(),
  对照: await prisma.entExternalRef.count(),
});

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  张伟 = (await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } })).id;
  await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("撤回", () => {
  it("五类全撤：记录和对照都删掉，存进回收区；恢复照原 id 建回来；还能再撤", async () => {
    const id = await 导([客户表(), 联系人表(), 线索表(), 商机表(), 跟进表()]);
    const 之前 = {
      客户: (await prisma.customer.findMany({ orderBy: { id: "asc" } })).map((c) => c.id),
      跟进: (await prisma.followUp.findMany({ orderBy: { id: "asc" } })).map((f) => f.id),
      c1: (await 客户("杭州云帆科技有限公司"))!,
    };

    const r = await 撤回一批(id, 我);
    expect(r).toMatchObject({ 状态: "reverted", 完了: true, 删掉: 9, 还原: 0, 留下数: 0 });
    expect(await 数()).toEqual({ 客户: 0, 联系人: 0, 线索: 0, 商机: 0, 跟进: 0, 对照: 0 });
    expect(await prisma.entTrash.count({ where: { batchId: id } })).toBe(9);
    expect(await prisma.customerExtra.count()).toBe(0);
    expect(await prisma.entImportRow.count({ where: { batchId: id, undo: "撤了" } })).toBe(9);
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id } });
    expect(批.revertedAt).not.toBeNull();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "ent-revert" } })).summary).toContain("删掉 9 条");

    // 再调一次：什么都不做
    expect(await 撤回一批(id, 我)).toMatchObject({ 状态: "reverted", 完了: true, 删掉: 9 });

    const 恢 = await 恢复一批(id, 我);
    expect(恢).toMatchObject({ 状态: "done", 完了: true, 恢复: 9, 留下数: 0 });
    expect(await 数()).toEqual({ 客户: 2, 联系人: 1, 线索: 1, 商机: 2, 跟进: 3, 对照: 9 });
    expect((await prisma.customer.findMany({ orderBy: { id: "asc" } })).map((c) => c.id)).toEqual(之前.客户);
    expect((await prisma.followUp.findMany({ orderBy: { id: "asc" } })).map((f) => f.id)).toEqual(之前.跟进);
    const c1 = (await 客户("杭州云帆科技有限公司"))!;
    expect(c1).toMatchObject({ salesOwnerId: 张伟, remark: "老客户", lastFollowAt: 之前.c1.lastFollowAt });
    expect(c1.extra?.level).toBe("A");
    const o2 = await prisma.opportunity.findFirstOrThrow({ where: { name: "外贸样品" }, include: { closed: true } });
    expect(o2.closed?.closedAt).toEqual(new Date("2025-03-05T00:00:00"));
    expect((await prisma.followUp.findFirstOrThrow({ where: { content: "聊了报价" } })).opportunityId).not.toBeNull();
    expect((await 对照("customer", "C1"))?.targetId).toBe(c1.id);
    expect(await prisma.entImportRow.count({ where: { batchId: id, undo: null } })).toBe(9);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "ent-restore" } })).toBe(1);
    expect(await 恢复一批(id, 我)).toMatchObject({ 状态: "done", 完了: true, 恢复: 9 });

    // 恢复完是正常的一批，还能再撤
    expect(await 撤回一批(id, 我)).toMatchObject({ 状态: "reverted", 删掉: 9 });
    expect(await prisma.customer.count()).toBe(0);
  });

  it("导入后改过的、导入不碰的格子被填过的：留下不动，原因记下来；别的照撤", async () => {
    const id = await 导([客户表(), 线索表()]);
    await prisma.customer.updateMany({ where: { name: "宁波海川贸易" }, data: { remark: "我们补的备注" } });
    await prisma.lead.updateMany({ data: { customerId: null, convertedAt: new Date() } });

    const r = await 撤回一批(id, 我);
    expect(r).toMatchObject({ 状态: "reverted", 删掉: 1, 留下数: 2 });
    expect(r.留下).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 实体: "customer", 外部ID: "C2", 名称: "宁波海川贸易", 原因: "导入之后又改过" }),
        expect.objectContaining({ 实体: "lead", 外部ID: "L1", 原因: expect.stringContaining("转成客户") }),
      ]),
    );
    expect(await 客户("杭州云帆科技有限公司")).toBeNull();
    expect(await 客户("宁波海川贸易")).not.toBeNull();
    // 留下的对照也留着，之后同步还认得
    expect(await 对照("customer", "C2")).not.toBeNull();
    expect(await prisma.entImportRow.count({ where: { batchId: id, undo: "留下" } })).toBe(2);
  });

  it("客户名下有外面手记的跟进 / 任务：客户留下，本批的跟进照删，最近跟进按剩下的重算", async () => {
    const id = await 导([客户表(), 跟进表()]);
    const c1 = (await 客户("杭州云帆科技有限公司"))!;
    const c2 = (await 客户("宁波海川贸易"))!;
    await prisma.followUp.create({ data: { customerId: c1.id, ownerId: 张伟, type: "OTHER", title: "微信沟通", content: "我们手记的", occurredAt: new Date("2025-01-01T08:00:00") } });
    await prisma.task.create({ data: { customerId: c2.id, title: "回电话", ownerId: 张伟, dueAt: new Date() } });

    const r = await 撤回一批(id, 我);
    expect(r).toMatchObject({ 删掉: 3, 留下数: 2 });
    expect(r.留下.map((x) => x.原因)).toEqual([expect.stringContaining("名下已经有"), expect.stringContaining("名下已经有")]);
    expect(await prisma.followUp.count()).toBe(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c1.id } })).lastFollowAt).toEqual(new Date("2025-01-01T08:00:00"));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c2.id } })).lastFollowAt).toBeNull();
  });

  it("同号连上我们早有的客户：补的空格改回空，客户留着，对照删掉；恢复再补上", async () => {
    const 老 = await prisma.customer.create({ data: { name: "云帆（老档）", phone: "13800000001", salesOwnerId: 张伟, followStatus: "跟进中" } });
    const id = await 导([客户表()]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 老.id } })).remark).toBe("老客户");

    const r = await 撤回一批(id, 我);
    expect(r).toMatchObject({ 删掉: 1, 还原: 1, 留下数: 0 });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: 老.id }, include: { extra: true } });
    expect(c).toMatchObject({ name: "云帆（老档）", remark: null, followStatus: "跟进中" });
    expect(c.extra?.level ?? null).toBeNull();
    expect(await 对照("customer", "C1")).toBeNull();
    expect(await prisma.customer.count()).toBe(1);

    expect(await 恢复一批(id, 我)).toMatchObject({ 状态: "done", 恢复: 2 });
    const 又 = await prisma.customer.findUniqueOrThrow({ where: { id: 老.id }, include: { extra: true } });
    expect(又.remark).toBe("老客户");
    expect(又.extra?.level).toBe("A");
    expect((await 对照("customer", "C1"))?.targetId).toBe(老.id);
  });

  it("同一批里同号并入的：两条对照都退掉，客户删掉", async () => {
    const id = await 导([
      客户表([
        ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", ""],
        ["C9", "杭州云帆科技", "13800000001", "张伟", "", ""],
      ]),
    ]);
    expect(await prisma.customer.count()).toBe(1);
    expect(await 撤回一批(id, 我)).toMatchObject({ 删掉: 1, 留下数: 0 });
    expect(await 数()).toMatchObject({ 客户: 0, 对照: 0 });
  });

  it("我们这边已经删了的：不算留下，对照清掉", async () => {
    const id = await 导([客户表()]);
    await prisma.customer.deleteMany({ where: { name: "宁波海川贸易" } });
    expect(await 撤回一批(id, 我)).toMatchObject({ 删掉: 1, 留下数: 0 });
    expect(await prisma.entExternalRef.count()).toBe(0);
  });

  it("同来源还有一批在写：先不撤", async () => {
    const id = await 导([客户表()]);
    const { 批次Id: 别的 } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: [线索表()], 建议器: null });
    await prisma.entImportBatch.update({ where: { id: 别的 }, data: { status: "applying" } });
    await expect(撤回一批(id, 我)).rejects.toThrow("正在写入或撤回");
    await expect(撤回一批(别的, 我)).rejects.toThrow("还没导完");
    await expect(恢复一批(id, 我)).rejects.toThrow("没有撤回");
    expect((await prisma.entImportBatch.findUniqueOrThrow({ where: { id } })).status).toBe("done");
  });
});

describe("和之后的同步", () => {
  const 改过的 = () =>
    客户表([
      ["C1", "杭州云帆科技有限公司", "13800000011", "张伟", "A", "原系统改的备注"],
      ["C2", "宁波海川贸易", "13800000002", "李娜", "B", ""],
    ]);

  it("之后的同步改过的：先撤前一批挡住；撤后一批改回旧值、旧对照，冲突变已撤回；再撤前一批就删得掉", async () => {
    const 一 = await 导([客户表()]);
    const c1 = (await 客户("杭州云帆科技有限公司"))!;
    await prisma.customer.update({ where: { id: c1.id }, data: { remark: "我们改的备注" } });
    const 二 = await 导([改过的()]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c1.id } })).phone).toBe("13800000011");
    expect(await prisma.entConflict.findFirstOrThrow()).toMatchObject({ batchId: 二, status: "待定" });

    // 先撤第一批：C1 被第二批改过，留下；C2 第二批没碰，照删
    const 先 = await 撤回一批(一, 我);
    expect(先.留下).toEqual([expect.objectContaining({ 外部ID: "C1", 原因: expect.stringContaining("先撤回那一批") })]);
    expect(await 恢复一批(一, 我)).toMatchObject({ 状态: "done", 恢复: 1 });
    expect(await 客户("宁波海川贸易")).not.toBeNull();

    const 后 = await 撤回一批(二, 我);
    expect(后).toMatchObject({ 状态: "reverted", 还原: 1, 删掉: 0, 留下数: 0 });
    const 现 = await prisma.customer.findUniqueOrThrow({ where: { id: c1.id } });
    expect(现).toMatchObject({ phone: "13800000001", remark: "我们改的备注" });
    const ref = (await 对照("customer", "C1"))!;
    expect(ref.batchId).toBe(一);
    expect(JSON.parse(ref.written)).toMatchObject({ phone: "13800000001", remark: "老客户" });
    expect((await prisma.entConflict.findFirstOrThrow()).status).toBe("已撤回");

    // 再撤第一批：C1 我们改过备注，留下；C2 删掉
    const 再 = await 撤回一批(一, 我);
    expect(再).toMatchObject({ 删掉: 1, 留下数: 1 });
    expect(再.留下[0]).toMatchObject({ 外部ID: "C1", 原因: "导入之后又改过" });
  });

  it("恢复同步批：改的格子再改回去、对照回到同步后、冲突回到待定", async () => {
    await 导([客户表()]);
    const c1 = (await 客户("杭州云帆科技有限公司"))!;
    await prisma.customer.update({ where: { id: c1.id }, data: { remark: "我们改的备注" } });
    const 二 = await 导([改过的()]);
    const 同步后 = (await 对照("customer", "C1"))!;
    await 撤回一批(二, 我);

    expect(await 恢复一批(二, 我)).toMatchObject({ 状态: "done", 恢复: 1, 留下数: 0 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c1.id } })).phone).toBe("13800000011");
    const ref = (await 对照("customer", "C1"))!;
    expect(ref).toMatchObject({ batchId: 二, fingerprint: 同步后.fingerprint, written: 同步后.written });
    expect((await prisma.entConflict.findFirstOrThrow()).status).toBe("待定");
  });

  it("撤回之后又改过：恢复时跳过这一格的那条", async () => {
    await 导([客户表()]);
    const 二 = await 导([改过的()]);
    await 撤回一批(二, 我);
    await prisma.customer.updateMany({ where: { name: "杭州云帆科技有限公司" }, data: { phone: "13900000000" } });
    const r = await 恢复一批(二, 我);
    expect(r).toMatchObject({ 状态: "done", 恢复: 0, 留下数: 1 });
    expect(r.留下[0].原因).toBe("撤回之后又改过");
    expect((await 客户("杭州云帆科技有限公司"))!.phone).toBe("13900000000");
  });
});

describe("分段和并发", () => {
  const 六十 = () => 客户表(Array.from({ length: 60 }, (_, i) => [`C${i}`, `公司${i}`, `1380000${String(i).padStart(4, "0")}`, "张伟", "", ""]));

  it("分段：时间到就停，再调接着撤；恢复也一样", async () => {
    const id = await 导([六十()]);
    const 一 = await 撤回一批(id, 我, { 段长毫秒: 0 });
    expect(一).toMatchObject({ 状态: "reverting", 完了: false, 删掉: 25 });
    let r = 一;
    let 趟 = 0;
    while (!r.完了 && 趟++ < 10) r = await 撤回一批(id, 我, { 段长毫秒: 0 });
    expect(趟).toBe(2);
    expect(r).toMatchObject({ 状态: "reverted", 删掉: 60 });
    expect(await prisma.customer.count()).toBe(0);

    r = await 恢复一批(id, 我, { 段长毫秒: 0 });
    expect(r).toMatchObject({ 状态: "restoring", 完了: false, 恢复: 25 });
    while (!r.完了 && 趟++ < 20) r = await 恢复一批(id, 我, { 段长毫秒: 0 });
    expect(r).toMatchObject({ 状态: "done", 恢复: 60 });
    expect(await prisma.customer.count()).toBe(60);
  });

  it("两边同时撤同一批：只撤一份，操作日志一条", async () => {
    const id = await 导([六十()]);
    const [a, b] = await Promise.all([撤回一批(id, 我), 撤回一批(id, 我)]);
    let r = a.完了 ? a : b;
    if (!a.完了 && !b.完了) r = await 撤回一批(id, 我);
    expect(r).toMatchObject({ 状态: "reverted", 删掉: 60, 留下数: 0 });
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.entTrash.count()).toBe(60);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "ent-revert" } })).toBe(1);
  });
});

describe("撤完再导", () => {
  it("撤完重导：照新的建；之后恢复旧那批，又导进来的跳过，不会多出一份", async () => {
    const 一 = await 导([客户表()]);
    await 撤回一批(一, 我);
    const 二 = await 导([客户表()]);
    expect(await prisma.customer.count()).toBe(2);
    expect((await 对照("customer", "C1"))?.batchId).toBe(二);

    const r = await 恢复一批(一, 我);
    expect(r).toMatchObject({ 状态: "done", 恢复: 0, 留下数: 2 });
    expect(r.留下.map((x) => x.原因)).toEqual([expect.stringContaining("又导进来了"), expect.stringContaining("又导进来了")]);
    expect(await prisma.customer.count()).toBe(2);
    expect((await 对照("customer", "C1"))?.batchId).toBe(二);
  });
});
