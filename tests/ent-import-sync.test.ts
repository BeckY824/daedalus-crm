/**
 * 企业版导入 · 增量同步。
 * 开同步要先正式导入过、Excel 不能开、切换后不能再开；接口没接说「没接」、拉出错不挪起点；
 * 照已认的映射写（新建 / 更新 / 跳过 / 冲突不覆盖），全没变的不留批次；接着写完半截的；同来源在撤先不拉；
 * 开的人停用了报错；同步批能整批撤回；到点规则（每小时 / 每晚补跑）；定时只在企业版开着时扫。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 撤回一批 } from "@/lib/enterprise-import/revert";
import { 换适配器, 现成适配器 } from "@/lib/enterprise-import/adapter";
import { 改同步设置, 读同步设置, 同步一次, 到点了, 定时扫一遍, 拉全量试跑, 已认映射, type 同步设置 } from "@/lib/enterprise-import/sync";
import type { 原始记录 } from "@/lib/enterprise-import/types";

const 我 = { id: "tester-id", name: "测试员" };

const 客户 = (id: string, 名称: string, 电话: string, 负责人: string, 备注 = ""): 原始记录 => ({
  实体: "customer",
  外部ID: id,
  字段: { 客户名称: 名称, 手机号码: 电话, 客户负责人: 负责人, 备注 },
});
const 起始 = () => [客户("fs-1", "杭州云帆科技有限公司", "13800000001", "张伟", "老客户"), 客户("fs-2", "宁波海川贸易", "13800000002", "李娜")];

/** 飞书那边现在的数据：测试里改它就等于原系统改了 */
let 飞书: 原始记录[] = [];
const 拉了 = vi.fn();

async function 首次导入() {
  const { 批次Id } = await 拉全量试跑("feishu", 我.id);
  const r = await 写一批(批次Id, 我);
  expect(r.完了).toBe(true);
  return 批次Id;
}
const 云帆 = () => prisma.customer.findFirstOrThrow({ where: { name: "杭州云帆科技有限公司" } });

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } });
  await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } });
  飞书 = 起始();
  拉了.mockReset();
  换适配器(
    "feishu",
    new 现成适配器("feishu", () => {
      拉了();
      return 飞书.map((r) => ({ ...r, 字段: { ...r.字段 } }));
    }),
  );
});

afterEach(() => {
  换适配器("feishu", null);
  delete process.env.CRM_ENTERPRISE;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("开同步", () => {
  it("Excel 不能开；没正式导入过不能开；频率、钟点要对；导过之后能开，记下开的人", async () => {
    await expect(改同步设置("excel", { 开: true }, 我)).rejects.toThrow("Excel 没有自动同步");
    await expect(改同步设置("feishu", { 开: true }, 我)).rejects.toThrow("先从飞书做一次首次导入");
    await expect(改同步设置("feishu", { 频率: "每天" as never }, 我)).rejects.toThrow("频率");
    await expect(改同步设置("feishu", { 几点: 24 }, 我)).rejects.toThrow("0 到 23");

    // 只试跑没正式导入：映射还没人认
    await 拉全量试跑("feishu", 我.id);
    expect(await 已认映射("feishu")).toBeNull();
    await expect(改同步设置("feishu", { 开: true }, 我)).rejects.toThrow("先从飞书做一次首次导入");

    await prisma.entImportBatch.deleteMany();
    await 首次导入();
    expect(await 已认映射("feishu")).not.toBeNull();
    const s = await 改同步设置("feishu", { 开: true, 频率: "每小时" }, 我);
    expect(s).toMatchObject({ 开: true, 频率: "每小时", 几点: 2, 开的人Id: 我.id, 切换: null });
    expect(await 读同步设置("feishu")).toEqual(s);

    const 关 = await 改同步设置("feishu", { 开: false }, 我);
    expect(关).toMatchObject({ 开: false, 频率: "每小时", 开的人Id: 我.id });
  });

  it("切换过之后不能再开", async () => {
    await 首次导入();
    await 改同步设置("feishu", { 开: true }, 我);
    拉了.mockReset();
    const 现 = await 读同步设置("feishu");
    await prisma.setting.upsert({
      where: { key: "entSync.feishu" },
      create: { key: "entSync.feishu", value: JSON.stringify({ ...现, 开: false, 切换: { 时间: "2026-10-30T10:00:00.000Z", 快照Id: "s", 人Id: 我.id } }) },
      update: { value: JSON.stringify({ ...现, 开: false, 切换: { 时间: "2026-10-30T10:00:00.000Z", 快照Id: "s", 人Id: 我.id } }) },
    });
    invalidateSettingsCache();
    await expect(改同步设置("feishu", { 开: true }, 我)).rejects.toThrow("2026-10-30 切换过了");
    expect(await 同步一次("feishu", { 用户: 我 })).toMatchObject({ 结果: "跳过", 话: "已经切换，不再同步" });
    expect(拉了).not.toHaveBeenCalled();
  });
});

describe("同步一次", () => {
  it("钉钉接口没接：结果「没接」，起点不挪，上次记下", async () => {
    await prisma.entImportBatch.create({ data: { source: "dingtalk", kind: "full", status: "done", userId: 我.id, mapping: JSON.stringify({ 默认负责人Id: 我.id, 列: {}, 值: {} }), finishedAt: new Date() } });
    const r = await 同步一次("dingtalk", { 用户: 我 });
    expect(r.结果).toBe("没接");
    expect(r.话).toContain("钉钉接口还没接");
    const s = await 读同步设置("dingtalk");
    expect(s.拉到).toBeNull();
    expect(s.上次).toMatchObject({ 结果: "没接" });
  });

  it("没正式导入过：跳过，不拉", async () => {
    expect(await 同步一次("feishu", { 用户: 我 })).toMatchObject({ 结果: "跳过" });
    expect(拉了).not.toHaveBeenCalled();
  });

  it("原系统改一条、加一条：存成同步批写进去，按原系统 ID 更新，没变的跳过；操作日志记「同步」；起点挪到这次开始", async () => {
    await 首次导入();
    expect(await prisma.customer.count()).toBe(2);
    const 原备注 = (await prisma.customer.findFirstOrThrow({ where: { name: "宁波海川贸易" } })).remark;
    飞书[1] = 客户("fs-2", "宁波海川贸易", "13800000002", "李娜", "原系统补的备注");
    飞书.push(客户("fs-3", "温州小厂", "13600000001", "张伟"));

    const 现在 = new Date("2026-10-25T03:00:00.000Z");
    const r = await 同步一次("feishu", { 用户: 我, 现在 });
    expect(r.结果).toBe("成功");
    expect(r.话).toContain("新建 1，更新 1，跳过 1");
    expect(await prisma.customer.count()).toBe(3);
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "宁波海川贸易" } })).remark).toBe("原系统补的备注");
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id: r.批次Id! } });
    expect(批).toMatchObject({ source: "feishu", kind: "sync", status: "done", created: 1, updated: 1, skipped: 1 });
    expect(await prisma.auditLog.count({ where: { entityId: 批.id, action: "ent-sync" } })).toBe(1);
    const s = await 读同步设置("feishu");
    expect(s.拉到).toBe(现在.toISOString());
    expect(s.上次).toMatchObject({ 时间: 现在.toISOString(), 结果: "成功", 批次Id: 批.id });

    // 同步批也能整批撤回：新建的删掉、改的改回去
    expect(await 撤回一批(批.id, 我)).toMatchObject({ 完了: true });
    expect(await prisma.customer.count()).toBe(2);
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "宁波海川贸易" } })).remark).toBe(原备注);
  });

  it("全没变：结果「没变化」，不留空批次；拉到零条也一样", async () => {
    await 首次导入();
    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r).toMatchObject({ 结果: "没变化" });
    expect(await prisma.entImportBatch.count({ where: { kind: "sync" } })).toBe(0);

    飞书 = [];
    expect(await 同步一次("feishu", { 用户: 我 })).toMatchObject({ 结果: "没变化", 话: "原系统没有新改动" });
    expect((await 读同步设置("feishu")).拉到).not.toBeNull();
  });

  it("我们这边改过、原系统也改了：不覆盖，记一笔冲突", async () => {
    await 首次导入();
    await prisma.customer.updateMany({ where: { name: "杭州云帆科技有限公司" }, data: { remark: "我们改的" } });
    飞书[0] = 客户("fs-1", "杭州云帆科技有限公司", "13800000001", "张伟", "原系统改的");

    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r.结果).toBe("成功");
    expect(r.话).toContain("1 条冲突待定");
    expect((await 云帆()).remark).toBe("我们改的");
    expect(await prisma.entConflict.findFirstOrThrow()).toMatchObject({ source: "feishu", externalId: "fs-1", status: "待定", batchId: r.批次Id });
  });

  it("新冒出来的负责人照规则认，不问 AI", async () => {
    await 首次导入();
    await prisma.user.create({ data: { email: "ww@x", name: "王五", title: "销售", role: "SALES", password: "x" } });
    飞书.push(客户("fs-4", "台州新客户", "13900000004", "王五"));
    expect((await 同步一次("feishu", { 用户: 我 })).结果).toBe("成功");
    const 新 = await prisma.customer.findFirstOrThrow({ where: { name: "台州新客户" }, include: { salesOwner: true } });
    expect(新.salesOwner?.name).toBe("王五");
  });

  it("拉的时候出错：结果「出错」，起点不挪", async () => {
    await 首次导入();
    换适配器(
      "feishu",
      new 现成适配器("feishu", () => {
        throw new Error("飞书 429：请求太频繁\n  at fetch");
      }),
    );
    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r).toMatchObject({ 结果: "出错", 话: "从飞书拉数据没成功：at fetch" });
    expect((await 读同步设置("feishu")).拉到).toBeNull();
  });

  it("上次同步写到一半：这次先接着写完那一批，不再拉", async () => {
    await 首次导入();
    飞书[1] = 客户("fs-2", "宁波海川贸易", "13800000002", "李娜", "半截");
    const m = await 已认映射("feishu");
    const { 批次Id } = await 试跑({ 来源: "feishu", 用户Id: 我.id, 记录: 飞书, 建议器: null, 已有映射: m, 留AI: true, 类型: "sync" });
    await prisma.entImportBatch.update({ where: { id: 批次Id }, data: { status: "applying" } });
    拉了.mockReset();

    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r).toMatchObject({ 结果: "成功", 批次Id });
    expect(r.话).toContain("接着写完上次没写完的同步");
    expect(拉了).not.toHaveBeenCalled();
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "宁波海川贸易" } })).remark).toBe("半截");
  });

  it("同一来源有一批正在撤回：这次跳过，不拉", async () => {
    const id = await 首次导入();
    await prisma.entImportBatch.update({ where: { id }, data: { status: "reverting" } });
    拉了.mockReset();
    expect(await 同步一次("feishu", { 用户: 我 })).toMatchObject({ 结果: "跳过" });
    expect(拉了).not.toHaveBeenCalled();
  });

  it("定时同步记在开的人名下；开的人停用了报错、不拉", async () => {
    await 首次导入();
    const 张伟 = await prisma.user.findFirstOrThrow({ where: { name: "张伟" } });
    await 改同步设置("feishu", { 开: true }, { id: 张伟.id, name: 张伟.name });
    飞书.push(客户("fs-3", "温州小厂", "13600000001", "张伟"));
    const r = await 同步一次("feishu");
    expect(r.结果).toBe("成功");
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: r.批次Id, action: "ent-sync" } })).userId).toBe(张伟.id);

    await prisma.user.update({ where: { id: 张伟.id }, data: { active: false } });
    拉了.mockReset();
    expect(await 同步一次("feishu")).toMatchObject({ 结果: "出错", 话: expect.stringContaining("开同步的人找不到了") });
    expect(拉了).not.toHaveBeenCalled();
  });
});

describe("定时", () => {
  const 设 = (改: Partial<同步设置>): 同步设置 => ({ 开: true, 频率: "每晚", 几点: 2, 开的人Id: 我.id, 拉到: null, 上次: null, 切换: null, ...改 });
  const 上次 = (时间: string) => ({ 时间: new Date(时间).toISOString(), 结果: "成功" as const, 话: "" });

  it("关着、切换过的不到点", () => {
    const 现在 = new Date("2026-10-25T12:00:00");
    expect(到点了(设({ 开: false }), 现在)).toBe(false);
    expect(到点了(设({ 切换: { 时间: "x", 快照Id: "s", 人Id: 我.id } }), 现在)).toBe(false);
  });

  it("每小时：没拉过就拉；离上次满 55 分钟才拉", () => {
    const 现在 = new Date("2026-10-25T12:00:00");
    expect(到点了(设({ 频率: "每小时" }), 现在)).toBe(true);
    expect(到点了(设({ 频率: "每小时", 上次: 上次("2026-10-25T11:10:00") }), 现在)).toBe(false);
    expect(到点了(设({ 频率: "每小时", 上次: 上次("2026-10-25T11:05:00") }), 现在)).toBe(true);
  });

  it("每晚：过了钟点、今天那个钟点之后还没拉过才拉；错过了开机补跑", () => {
    expect(到点了(设({}), new Date("2026-10-25T01:59:00"))).toBe(false);
    expect(到点了(设({}), new Date("2026-10-25T02:00:00"))).toBe(true);
    expect(到点了(设({ 上次: 上次("2026-10-25T02:05:00") }), new Date("2026-10-25T08:00:00"))).toBe(false);
    // 昨晚拉过，今晚两点服务器关着，早上九点开机：补一次
    expect(到点了(设({ 上次: 上次("2026-10-24T02:05:00") }), new Date("2026-10-25T09:00:00"))).toBe(true);
    // 昨晚的还没到今天的钟点：不拉
    expect(到点了(设({ 上次: 上次("2026-10-24T02:05:00") }), new Date("2026-10-25T01:00:00"))).toBe(false);
    expect(到点了(设({ 几点: 23, 上次: 上次("2026-10-24T23:10:00") }), new Date("2026-10-25T23:30:00"))).toBe(true);
  });

  it("企业版没开不扫；开着就把到点的同步一次", async () => {
    await 首次导入();
    await 改同步设置("feishu", { 开: true, 频率: "每小时" }, 我);
    飞书.push(客户("fs-3", "温州小厂", "13600000001", "张伟"));
    拉了.mockReset();

    await 定时扫一遍();
    expect(拉了).not.toHaveBeenCalled();

    process.env.CRM_ENTERPRISE = "1";
    await 定时扫一遍();
    expect(拉了).toHaveBeenCalledTimes(1);
    expect(await prisma.customer.count()).toBe(3);
    expect((await 读同步设置("feishu")).上次).toMatchObject({ 结果: "成功" });

    // 刚拉过：不到点
    await 定时扫一遍();
    expect(拉了).toHaveBeenCalledTimes(1);
  });
});
