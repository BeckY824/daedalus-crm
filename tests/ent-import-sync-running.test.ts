/**
 * 企业版导入 · 同步时「正在同步」和读内容超时。
 *   - 同一来源同步还没完又来一次（定时那次没完又点了立即同步、点了两下）：第二次跳过、只拉一次，不改「上次」
 *   - 拉的过程中 正在同步 报谁、什么时候开始；完了（成功、出错都算）清掉
 *   - 响应头回了、内容一直不来：读JSON 到点抛 接口出错，不一直挂着
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 换适配器, 现成适配器 } from "@/lib/enterprise-import/adapter";
import { 接口出错, 读JSON, 单个请求最长毫秒 } from "@/lib/enterprise-import/net";
import { 改同步设置, 读同步设置, 同步一次, 拉全量试跑, 正在同步 } from "@/lib/enterprise-import/sync";
import type { 原始记录 } from "@/lib/enterprise-import/types";

const 我 = { id: "tester-id", name: "测试员" };
const 一条: 原始记录 = { 实体: "customer", 外部ID: "fs-1", 字段: { 客户名称: "杭州云帆科技有限公司", 手机号码: "13800000001", 客户负责人: "测试员" } };

/** 拉变化卡在这里，测试说放才放（放 = 给记录，拒 = 原系统报错） */
let 闸: { 放: (r: 原始记录[]) => void; 拒: (e: Error) => void } | null = null;
let 全量 = true;
const 拉了 = vi.fn();

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  全量 = true;
  拉了.mockReset();
  换适配器(
    "feishu",
    new 现成适配器("feishu", () => {
      if (全量) return [一条];
      拉了();
      return new Promise<原始记录[]>((放, 拒) => (闸 = { 放, 拒 }));
    }),
  );
  const { 批次Id } = await 拉全量试跑("feishu", 我.id);
  expect((await 写一批(批次Id, 我)).完了).toBe(true);
  全量 = false;
});

afterEach(() => {
  换适配器("feishu", null);
  闸 = null;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 等到适配器真开始拉（前面还有几次查库） */
async function 等开始拉() {
  await vi.waitFor(() => expect(闸).not.toBeNull());
}

describe("正在同步", () => {
  it("同一来源还没同步完又来一次：第二次跳过、说清谁在同步，只拉一次，不改「上次」", async () => {
    const 头一次 = 同步一次("feishu", { 用户: 我 });
    await 等开始拉();
    expect(正在同步("feishu")).toMatchObject({ 谁: "测试员" });
    expect(正在同步("dingtalk")).toBeNull();

    const 第二次 = await 同步一次("feishu");
    expect(第二次.结果).toBe("跳过");
    expect(第二次.话).toMatch(/正在同步（测试员 \d\d:\d\d 开始的那次还没完）/);
    expect((await 读同步设置("feishu")).上次).toBeNull();

    闸!.放([]);
    expect(await 头一次).toMatchObject({ 结果: "没变化" });
    expect(拉了).toHaveBeenCalledTimes(1);
    expect(正在同步("feishu")).toBeNull();
    expect((await 读同步设置("feishu")).上次).toMatchObject({ 结果: "没变化" });
  });

  it("定时那次（没传用户）记成「定时同步」；拉出错了也清掉，下一次照常拉", async () => {
    await 改同步设置("feishu", { 开: true }, 我);
    const 头一次 = 同步一次("feishu");
    await 等开始拉();
    expect(正在同步("feishu")).toMatchObject({ 谁: "定时同步" });
    闸!.拒(new 接口出错("连不上飞书"));
    expect(await 头一次).toMatchObject({ 结果: "出错" });
    expect(正在同步("feishu")).toBeNull();

    闸 = null;
    const 再一次 = 同步一次("feishu", { 用户: 我 });
    await 等开始拉();
    闸!.放([]);
    expect(await 再一次).toMatchObject({ 结果: "没变化" });
    expect(拉了).toHaveBeenCalledTimes(2);
  });
});

describe("读JSON · 读内容超时", () => {
  it("单个请求最坏 93 秒：30 秒 × 3 次 + 退避 1、2 秒", () => {
    expect(单个请求最长毫秒).toBe(93_000);
  });

  it("响应头回了、内容一直不来：到点抛 接口出错，说清读谁的内容、等了多久；流被取消", async () => {
    const 取消 = vi.fn();
    const res = new Response(new ReadableStream({ start: () => {}, cancel: 取消 }));
    const 读 = 读JSON(res, "飞书", 50);
    await expect(读).rejects.toThrow(接口出错);
    await expect(读).rejects.toThrow("读飞书返回的内容时断了：等了 0.05 秒没读完");
    expect(取消).toHaveBeenCalled();
  });

  it("内容按时到：照常解析；不是 JSON 的给 null", async () => {
    expect(await 读JSON(new Response('{"code":0}'), "钉钉", 50)).toEqual({ code: 0 });
    expect(await 读JSON(new Response("<html>"), "钉钉", 50)).toBeNull();
  });
});
