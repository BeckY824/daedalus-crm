/**
 * 企业版导入 · 切换日。
 * 切换 = 快照留档那一刻这个来源所有对照（原系统 ID ↔ 我们的记录 + 原始记录）+ 同步关掉不能再开 + 记操作日志；
 * 切换后待定的冲突照样能定、批次照样能撤；只切这个来源；同来源在写时不切；切过不能再切；快照能列、能导出。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 撤回一批 } from "@/lib/enterprise-import/revert";
import { 定冲突 } from "@/lib/enterprise-import/resolve";
import { 换适配器, 现成适配器 } from "@/lib/enterprise-import/adapter";
import { 改同步设置, 读同步设置, 同步一次, 拉全量试跑 } from "@/lib/enterprise-import/sync";
import { 切换, 列快照, 导出快照 } from "@/lib/enterprise-import/cutover";
import type { 原始记录 } from "@/lib/enterprise-import/types";

const 我 = { id: "tester-id", name: "测试员" };

const 客户 = (id: string, 名称: string, 电话: string, 负责人: string, 备注 = ""): 原始记录 => ({
  实体: "customer",
  外部ID: id,
  字段: { 客户名称: 名称, 手机号码: 电话, 客户负责人: 负责人, 备注 },
});

let 飞书: 原始记录[] = [];
const 拉了 = vi.fn();

async function 首次导入() {
  const { 批次Id } = await 拉全量试跑("feishu", 我.id);
  const r = await 写一批(批次Id, 我);
  expect(r.完了).toBe(true);
  return 批次Id;
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } });
  飞书 = [客户("fs-1", "杭州云帆科技有限公司", "13800000001", "张伟", "老客户"), 客户("fs-2", "宁波海川贸易", "13800000002", "张伟")];
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("切换", () => {
  it("快照留档全部对照，同步关掉、不能再开、不再拉；记操作日志；带出待定冲突数", async () => {
    const 首批 = await 首次导入();
    await 改同步设置("feishu", { 开: true, 频率: "每小时" }, 我);
    // 造一笔冲突：我们改过、原系统也改了
    await prisma.customer.updateMany({ where: { name: "杭州云帆科技有限公司" }, data: { remark: "我们改的" } });
    飞书[0] = 客户("fs-1", "杭州云帆科技有限公司", "13800000001", "张伟", "原系统改的");
    expect((await 同步一次("feishu", { 用户: 我 })).话).toContain("1 条冲突待定");

    const 对照数 = await prisma.entExternalRef.count({ where: { source: "feishu" } });
    expect(对照数).toBeGreaterThanOrEqual(2);
    const r = await 切换("feishu", 我);
    expect(r).toMatchObject({ 条数: 对照数, 待定冲突: 1 });

    const 快照 = await prisma.entSnapshot.findUniqueOrThrow({ where: { id: r.快照Id } });
    expect(快照).toMatchObject({ source: "feishu", userId: 我.id, count: 对照数 });
    const data = JSON.parse(快照.data) as { entity: string; externalId: string; targetId: string; raw: { 字段: Record<string, string> } }[];
    const 云帆 = await prisma.customer.findFirstOrThrow({ where: { name: "杭州云帆科技有限公司" } });
    const 一 = data.find((d) => d.externalId === "fs-1" && d.entity === "customer");
    expect(一).toMatchObject({ targetId: 云帆.id });
    expect(JSON.stringify(一!.raw)).toContain("杭州云帆科技有限公司");

    const s = await 读同步设置("feishu");
    expect(s).toMatchObject({ 开: false, 切换: { 快照Id: r.快照Id, 人Id: 我.id } });
    expect(await prisma.auditLog.count({ where: { action: "ent-cutover", entityId: r.快照Id } })).toBe(1);

    拉了.mockReset();
    expect(await 同步一次("feishu", { 用户: 我 })).toMatchObject({ 结果: "跳过" });
    expect(拉了).not.toHaveBeenCalled();
    await expect(改同步设置("feishu", { 开: true }, 我)).rejects.toThrow("切换过了");
    await expect(切换("feishu", 我)).rejects.toThrow("切换过了");
    expect(await prisma.entSnapshot.count()).toBe(1);

    // 切换后冲突照样能定，批次照样能撤
    const 冲 = await prisma.entConflict.findFirstOrThrow({ where: { status: "待定" } });
    await 定冲突([冲.id], "采用原系统", 我);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: 云帆.id } })).remark).toBe("原系统改的");
    expect((await 撤回一批(首批, 我)).完了).toBe(true);
  });

  it("同一来源有一批正在写入时不切；别的来源不受影响", async () => {
    const 首批 = await 首次导入();
    await prisma.entImportBatch.update({ where: { id: 首批 }, data: { status: "applying" } });
    await expect(切换("feishu", 我)).rejects.toThrow("正在写入");
    expect(await prisma.entSnapshot.count()).toBe(0);
    expect((await 读同步设置("feishu")).切换).toBeNull();

    // 钉钉没导过也能切（空快照），飞书照旧
    const r = await 切换("dingtalk", 我);
    expect(r).toMatchObject({ 条数: 0, 待定冲突: 0 });
    expect((await 读同步设置("feishu")).切换).toBeNull();
  });

  it("快照能列、能导出成 JSON；不存在的返回空", async () => {
    await 首次导入();
    const r = await 切换("feishu", 我);
    const 们 = await 列快照();
    expect(们).toHaveLength(1);
    expect(们[0]).toMatchObject({ id: r.快照Id, 来源: "feishu", 条数: r.条数, 人Id: 我.id });
    expect(await 列快照("dingtalk")).toHaveLength(0);

    const 出 = await 导出快照(r.快照Id);
    expect(出!.文件名).toMatch(/^飞书-切换快照-\d{4}-\d{2}-\d{2}\.json$/);
    const 内 = JSON.parse(出!.内容);
    expect(内).toMatchObject({ 来源: "feishu", 来源名: "飞书", 条数: r.条数 });
    expect(内.对照).toHaveLength(r.条数);
    expect(await 导出快照("没有这个")).toBeNull();
  });
});
