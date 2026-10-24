/**
 * 企业版导入 · 冲突处理。
 * 采用原系统 / 保留我们（字段冲突、本地已删）、之后同步不再问、记下后又变了算已过时、定过的不重定、
 * 整批撤回冲突回待定再恢复、挡住撤同步批、建回跟进重算最近跟进、同来源在写先不定、所属客户不在了不定。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 撤回一批, 恢复一批 } from "@/lib/enterprise-import/revert";
import { 定冲突, 列冲突 } from "@/lib/enterprise-import/resolve";
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
const C1改 = (备注: string, 电话 = "13800000001") =>
  客户表([
    ["C1", "杭州云帆科技有限公司", 电话, "张伟", "A", 备注],
    ["C2", "宁波海川贸易", "13800000002", "李娜", "B", ""],
  ]);
const 联系人表 = (职位 = "采购") => 表("联系人.xlsx", "contact", ["联系人ID", "客户ID", "姓名", "职位", "手机"], [["P1", "C1", "王经理", 职位, "13700000001"]]);
const 跟进表 = (F2内容 = "上门看样") =>
  表("跟进记录.xlsx", "followup", ["跟进ID", "客户ID", "商机ID", "跟进方式", "跟进内容", "跟进时间"], [
    ["F1", "C1", "", "电话", "聊了报价", "2025-06-01 10:00"],
    ["F2", "C1", "", "拜访", F2内容, "2025-07-01 15:00"],
  ]);

const 我 = { id: "tester-id", name: "测试员" };

async function 导(表们: 读出的表[]) {
  const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
  const r = await 写一批(批次Id, 我);
  expect(r.完了).toBe(true);
  return 批次Id;
}
const 对照 = (entity: string, externalId: string) =>
  prisma.entExternalRef.findUnique({ where: { source_entity_externalId: { source: "excel", entity, externalId } } });
const 客户 = (name: string) => prisma.customer.findFirst({ where: { name } });
const c1 = async () => (await 客户("杭州云帆科技有限公司"))!;
const 写的 = async (entity: string, externalId: string) => JSON.parse((await 对照(entity, externalId))!.written);

/** 导一批，C1 备注我们改成「我们改的」，再同步原系统改的备注：记下一笔字段冲突 */
async function 备注冲突() {
  const 一 = await 导([客户表()]);
  await prisma.customer.updateMany({ where: { name: "杭州云帆科技有限公司" }, data: { remark: "我们改的" } });
  const 二 = await 导([C1改("原系统改的")]);
  const 冲 = await prisma.entConflict.findFirstOrThrow();
  expect(冲).toMatchObject({ batchId: 二, status: "待定", localDeleted: false, entity: "customer", externalId: "C1" });
  return { 一, 二, 冲 };
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } });
  await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("字段冲突", () => {
  it("采用原系统：格子照原系统改、对照记下；同样的数据再同步跳过；整批撤回改回去、冲突回待定；恢复再定回去", async () => {
    const { 二, 冲 } = await 备注冲突();
    const 列 = await 列冲突();
    expect(列.总数).toBe(1);
    expect(列.条目[0]).toMatchObject({ id: 冲.id, 实体: "customer", 外部ID: "C1", 名称: "杭州云帆科技有限公司", 本地已删: false });
    expect(列.条目[0].字段.remark).toMatchObject({ 原系统: "原系统改的", 我们: "我们改的", 上次: "老客户" });

    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r).toMatchObject({ 定了: 1, 过时: 0, 没定: [] });
    const 批 = r.批次Id!;
    expect((await c1()).remark).toBe("原系统改的");
    expect(await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).toMatchObject({ status: "采用原系统", resolvedById: 我.id, resolveBatchId: 批 });
    expect((await 对照("customer", "C1"))!.batchId).toBe(批);
    expect((await 写的("customer", "C1")).remark).toBe("原系统改的");
    expect(await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批 } })).toMatchObject({ kind: "resolve", status: "done", updated: 1 });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "ent-resolve" } })).summary).toContain("1 笔采用原系统");
    expect((await 列冲突()).总数).toBe(0);

    await 导([C1改("原系统改的")]);
    expect(await prisma.entConflict.count()).toBe(1);
    expect((await c1()).remark).toBe("原系统改的");

    const 撤 = await 撤回一批(批, 我);
    expect(撤).toMatchObject({ 状态: "reverted", 还原: 1, 留下数: 0 });
    expect((await c1()).remark).toBe("我们改的");
    expect((await 对照("customer", "C1"))!.batchId).toBe(二);
    expect((await 写的("customer", "C1")).remark).toBe("老客户");
    expect(await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).toMatchObject({ status: "待定", resolvedById: null, resolvedAt: null });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "ent-revert", entityId: 批 } })).summary).toContain("冲突处理");

    const 恢 = await 恢复一批(批, 我);
    expect(恢).toMatchObject({ 状态: "done", 恢复: 1 });
    expect((await c1()).remark).toBe("原系统改的");
    expect((await 对照("customer", "C1"))!.batchId).toBe(批);
    expect(await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).toMatchObject({ status: "采用原系统", resolvedById: 我.id, resolveBatchId: 批 });
  });

  it("保留我们：格子不动、对照记下原系统的值；之后只改电话照更新不问；原系统再改备注又问", async () => {
    const { 冲 } = await 备注冲突();
    const r = await 定冲突([冲.id], "保留我们", 我);
    expect(r.定了).toBe(1);
    expect((await c1()).remark).toBe("我们改的");
    expect((await 写的("customer", "C1")).remark).toBe("原系统改的");
    expect(await prisma.entImportBatch.findUniqueOrThrow({ where: { id: r.批次Id! } })).toMatchObject({ updated: 0, skipped: 1 });

    await 导([C1改("原系统改的", "13800000099")]);
    expect(await c1()).toMatchObject({ phone: "13800000099", remark: "我们改的" });
    expect(await prisma.entConflict.count({ where: { status: "待定" } })).toBe(0);

    await 导([C1改("原系统又改了", "13800000099")]);
    const 新 = await prisma.entConflict.findFirstOrThrow({ where: { status: "待定" } });
    expect(JSON.parse(新.fields).remark).toMatchObject({ 原系统: "原系统又改了", 我们: "我们改的", 上次: "原系统改的" });
  });

  it("记下之后原系统又变了：标成已过时，不建批次", async () => {
    const { 冲 } = await 备注冲突();
    // 原系统把备注改回去、换了电话：备注不再冲突，电话照更新，旧冲突对不上了
    await 导([C1改("老客户", "13800000077")]);
    expect((await c1()).phone).toBe("13800000077");
    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r).toMatchObject({ 批次Id: null, 定了: 0, 过时: 1 });
    expect(r.没定[0]).toMatchObject({ 冲突Id: 冲.id, 原因: "记下之后原系统这条又变了" });
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("已过时");
    expect(await prisma.entImportBatch.count({ where: { kind: "resolve" } })).toBe(0);
    expect((await c1()).remark).toBe("我们改的");
  });

  it("我们这边删了的字段冲突：已过时", async () => {
    const { 冲 } = await 备注冲突();
    await prisma.customer.deleteMany({ where: { name: "杭州云帆科技有限公司" } });
    const r = await 定冲突([冲.id], "保留我们", 我);
    expect(r).toMatchObject({ 批次Id: null, 过时: 1 });
    expect(r.没定[0].原因).toBe("我们这边这条已经删了");
  });

  it("定过的再定：报已经是什么了；找不到的也报", async () => {
    const { 冲 } = await 备注冲突();
    await 定冲突([冲.id], "采用原系统", 我);
    const r = await 定冲突([冲.id, 冲.id], "保留我们", 我);
    expect(r).toMatchObject({ 批次Id: null, 定了: 0, 没定: [expect.objectContaining({ 原因: "已经是「采用原系统」了" })] });
    expect((await c1()).remark).toBe("原系统改的");
    await expect(定冲突(["没有这个"], "保留我们", 我)).rejects.toThrow("找不到");
    await expect(定冲突([冲.id], "随便" as never, 我)).rejects.toThrow("只能选");
    await expect(定冲突([], "保留我们", 我)).rejects.toThrow("没选");
  });

  it("冲突处理之后撤同步那批：这条留下说先撤冲突处理；撤了冲突处理再撤同步就改得回去", async () => {
    const { 二, 冲 } = await 备注冲突();
    const r = await 定冲突([冲.id], "采用原系统", 我);

    const 先 = await 撤回一批(二, 我);
    expect(先.留下).toEqual([expect.objectContaining({ 外部ID: "C1", 原因: expect.stringContaining("冲突处理") })]);
    expect((await c1()).remark).toBe("原系统改的");
    await 恢复一批(二, 我);

    await 撤回一批(r.批次Id!, 我);
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("待定");
    const 再 = await 撤回一批(二, 我);
    expect(再).toMatchObject({ 状态: "reverted", 留下数: 0 });
    expect((await c1()).remark).toBe("我们改的");
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("已撤回");
    // 同步批撤了：冲突处理那批恢复不回去（冲突不是待定、对照也不是它了）
    const 恢 = await 恢复一批(r.批次Id!, 我);
    expect(恢.留下数).toBe(1);
    expect((await c1()).remark).toBe("我们改的");
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("已撤回");
  });
});

describe("本地已删", () => {
  async function 删了又同步() {
    await 导([客户表()]);
    const 旧 = (await 客户("宁波海川贸易"))!;
    await prisma.customer.delete({ where: { id: 旧.id } });
    const 二 = await 导([客户表([
      ["C1", "杭州云帆科技有限公司", "13800000001", "张伟", "A", "老客户"],
      ["C2", "宁波海川贸易", "13800000002", "李娜", "B", "原系统补的"],
    ])]);
    const 冲 = await prisma.entConflict.findFirstOrThrow();
    expect(冲).toMatchObject({ batchId: 二, localDeleted: true, externalId: "C2" });
    return { 旧, 冲 };
  }

  it("采用原系统：照原系统建回来、对照指向新的；撤回删掉、对照指回旧的；恢复再建回来", async () => {
    const { 旧, 冲 } = await 删了又同步();
    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r.定了).toBe(1);
    const 新 = (await 客户("宁波海川贸易"))!;
    expect(新).toMatchObject({ remark: "原系统补的", phone: "13800000002" });
    expect(新.id).not.toBe(旧.id);
    expect((await 对照("customer", "C2"))).toMatchObject({ targetId: 新.id, batchId: r.批次Id });
    expect(await prisma.entImportBatch.findUniqueOrThrow({ where: { id: r.批次Id! } })).toMatchObject({ created: 1 });

    expect(await 撤回一批(r.批次Id!, 我)).toMatchObject({ 状态: "reverted", 删掉: 1, 留下数: 0 });
    expect(await 客户("宁波海川贸易")).toBeNull();
    expect((await 对照("customer", "C2"))!.targetId).toBe(旧.id);
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("待定");

    expect(await 恢复一批(r.批次Id!, 我)).toMatchObject({ 状态: "done", 恢复: 1 });
    expect((await 客户("宁波海川贸易"))!.id).toBe(新.id);
    expect((await 对照("customer", "C2"))!.targetId).toBe(新.id);
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("采用原系统");
  });

  it("保留我们：只改状态，不建、不写行", async () => {
    const { 冲 } = await 删了又同步();
    const r = await 定冲突([冲.id], "保留我们", 我);
    expect(r.定了).toBe(1);
    expect(await 客户("宁波海川贸易")).toBeNull();
    expect(await prisma.entImportRow.count({ where: { batchId: r.批次Id! } })).toBe(0);
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("保留我们");
  });

  it("又建回来了（同号再导）：已过时", async () => {
    const { 冲 } = await 删了又同步();
    // 我们这边又建了同一条，对照不变但现值在了
    await prisma.customer.create({ data: { id: 冲.targetId, name: "宁波海川贸易", phone: "13800000002", salesOwnerId: 我.id, followStatus: "跟进中" } });
    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r).toMatchObject({ 过时: 1, 没定: [expect.objectContaining({ 原因: "我们这边这条又建回来了" })] });
  });

  it("建回跟进：客户最近跟进重算；撤回再算回去", async () => {
    await 导([客户表(), 跟进表()]);
    const 客 = await c1();
    expect(客.lastFollowAt).toEqual(new Date("2025-07-01T15:00:00"));
    await prisma.followUp.deleteMany({ where: { content: "上门看样" } });
    await prisma.customer.update({ where: { id: 客.id }, data: { lastFollowAt: new Date("2025-06-01T10:00:00") } });
    await 导([客户表(), 跟进表("上门看样，带了样品")]);
    const 冲 = await prisma.entConflict.findFirstOrThrow();
    expect(冲).toMatchObject({ entity: "followup", localDeleted: true });

    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r.定了).toBe(1);
    expect((await c1()).lastFollowAt).toEqual(new Date("2025-07-01T15:00:00"));
    expect(await prisma.followUp.findFirst({ where: { content: "上门看样，带了样品" } })).not.toBeNull();

    await 撤回一批(r.批次Id!, 我);
    expect((await c1()).lastFollowAt).toEqual(new Date("2025-06-01T10:00:00"));
    expect(await prisma.followUp.count()).toBe(1);
  });

  it("所属客户不在了：采用原系统不定、还是待定；保留我们照定", async () => {
    await 导([客户表(), 联系人表()]);
    await prisma.contact.deleteMany({});
    await 导([客户表(), 联系人表("采购总监")]);
    const 冲 = await prisma.entConflict.findFirstOrThrow();
    expect(冲).toMatchObject({ entity: "contact", localDeleted: true });
    await prisma.customer.deleteMany({ where: { name: "杭州云帆科技有限公司" } });

    const r = await 定冲突([冲.id], "采用原系统", 我);
    expect(r).toMatchObject({ 批次Id: null, 定了: 0, 过时: 0 });
    expect(r.没定[0].原因).toContain("所属客户不在了");
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("待定");
    expect(await prisma.entImportBatch.count({ where: { kind: "resolve" } })).toBe(0);

    expect(await 定冲突([冲.id], "保留我们", 我)).toMatchObject({ 定了: 1 });
  });
});

describe("并发", () => {
  it("同来源还有一批在写：先不定", async () => {
    const { 冲 } = await 备注冲突();
    const { 批次Id } = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: [客户表()], 建议器: null });
    await prisma.entImportBatch.update({ where: { id: 批次Id }, data: { status: "applying" } });
    await expect(定冲突([冲.id], "采用原系统", 我)).rejects.toThrow("正在写入或撤回");
    expect((await prisma.entConflict.findUniqueOrThrow({ where: { id: 冲.id } })).status).toBe("待定");
  });

  it("两个窗口同时定同一笔：只定一份", async () => {
    const { 冲 } = await 备注冲突();
    const 们 = await Promise.allSettled([定冲突([冲.id], "采用原系统", 我), 定冲突([冲.id], "保留我们", 我)]);
    const 成 = 们.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof 定冲突>>> => x.status === "fulfilled").map((x) => x.value);
    expect(成.reduce((n, x) => n + x.定了, 0)).toBe(1);
    expect(await prisma.entImportBatch.count({ where: { kind: "resolve" } })).toBe(1);
  });
});
