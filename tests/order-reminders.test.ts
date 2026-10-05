/**
 * 订单节点超期提醒（2026-10-03 外贸第 3b 块）。
 *   - 算提醒：订单节点单独数（超期 = 截止日在今天之前或卡住；今天 = 今天到期），点名最久的那一单那一步
 *   - 壳：Dock 上的数 = 跟进两个数 + 订单两个数；早报带订单那半句；老的本地服务不回订单当 0
 *   - 盯盘：订单超期一类，排在逾期计划前面，点理由直达那张订单那一步
 *   - 取数：只取业务员名下的、没完成没不适用、排了日子或卡住的
 */
import { 订单节点 } from "@/lib/features";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import { 算提醒, type 订单提醒项 } from "@/lib/reminders";
import { 取订单提醒项 } from "@/lib/reminders-db";
import { buildWatchlist } from "@/lib/sentinel";
import { loadWatchlist } from "@/lib/sentinel-data";
import { createOrder, saveOrderNode } from "@/app/(app)/orders/actions";
import { dayjs } from "@/lib/utils";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const 壳 = require("../desktop/reminders.js");

const 现在 = new Date(2026, 9, 10, 9, 30);
const 日 = (d: number, h = 23) => new Date(2026, 9, 10 + d, h, 59);
const 节 = (p: Partial<订单提醒项>): 订单提醒项 => ({ orderId: "o", no: "A-1", 节点: "订舱", 时间: null, 卡住: false, ...p });

describe("算提醒：订单节点", () => {
  it("超期 = 截止日在今天之前或卡住；今天 = 今天到期；明天的不算；点名最久的", () => {
    const r = 算提醒([], 现在, [
      节({ 时间: 日(-1), 节点: "收定金", no: "A-1" }),
      节({ 时间: 日(-4), 节点: "订舱", no: "B-2" }),
      节({ 卡住: true }),
      节({ 时间: 日(0) }),
      节({ 时间: 日(1) }),
    ]);
    expect(r.订单).toEqual({ 超期: 3, 今天: 1, 最久: { no: "B-2", 节点: "订舱", 天: 4 } });
    // 跟进那两个数不受影响
    expect([r.逾期, r.今天]).toEqual([0, 0]);
  });

  it("没有订单：全是 0", () => {
    expect(算提醒([], 现在).订单).toEqual({ 超期: 0, 今天: 0, 最久: null });
  });
});

describe("壳：Dock 和早报", () => {
  const 设置 = { 角标: true, 早报: true, 早报时间: "09:00", 到点: true };
  it("Dock 上的数 = 跟进 + 订单；老本地服务不回订单当 0", () => {
    expect(壳.角标数(设置, { 逾期: 1, 今天: 2, 订单: { 超期: 3, 今天: 1 } })).toBe(7);
    expect(壳.角标数(设置, { 逾期: 1, 今天: 2 })).toBe(3);
  });

  it("只有订单要看也发早报；文案点名那一单那一步", () => {
    const 摘要 = { 逾期: 0, 今天: 0, 最久: null, 订单: { 超期: 2, 今天: 0, 最久: { no: "B-2", 节点: "订舱", 天: 4 } } };
    expect(壳.该发早报(设置, { 早报日: null }, 摘要, 现在)).toBe(true);
    expect(壳.早报文案(摘要)).toEqual({ 标题: "今天有 2 个订单节点要看", 正文: "订单节点超期 2 个，最久的是订单 B-2「订舱」，拖了 4 天" });
  });

  it("两样都有：标题都说，正文两半句；没有订单时和原来一字不差", () => {
    const 都有 = 壳.早报文案({ 逾期: 1, 今天: 0, 最久: { 客户: "王总", 天: 2 }, 订单: { 超期: 0, 今天: 1, 最久: null } });
    expect(都有).toEqual({ 标题: "今天有 1 个要跟进、1 个订单节点要看", 正文: "跟进里 1 个已经逾期，最久的是王总，已经拖了 2 天；订单节点都是今天到期的" });
    expect(壳.早报文案({ 逾期: 2, 今天: 1, 最久: { 客户: "王总", 天: 3 } })).toEqual({ 标题: "今天有 3 个要跟进", 正文: "其中 2 个已经逾期，最久的是王总，已经拖了 3 天" });
  });
});

describe("盯盘：订单超期", () => {
  const 空 = { overduePlans: [], customers: [], opportunities: [] };
  it("超期的节点进来、排在逾期计划前面；卡住的不论截止日；今天到期的不算超期", () => {
    const items = buildWatchlist(
      {
        ...空,
        overduePlans: [{ customerId: "c2", customerName: "Bolt", ownerName: "我", subject: "回电", plannedAt: 日(-5, 10) }],
        lateOrderNodes: [
          { orderId: "o1", orderNo: "A-1", idx: 9, nodeName: "订舱", dueAt: 日(-2), 卡住: false, customerId: "c1", customerName: "Acme", ownerName: "我" },
          { orderId: "o3", orderNo: "C-1", idx: 7, nodeName: "生产跟进", dueAt: null, 卡住: true, customerId: "c3", customerName: "Cato", ownerName: "我" },
          { orderId: "o4", orderNo: "D-1", idx: 5, nodeName: "收定金", dueAt: 日(0), 卡住: false, customerId: "c4", customerName: "Dune", ownerName: "我" },
        ],
      },
      现在,
    );
    expect(items.map((x) => [x.kind, x.customerName])).toEqual([
      ["order_late", "Acme"],
      ["order_late", "Cato"],
      ["overdue_plan", "Bolt"],
    ]);
    expect(items[0]).toMatchObject({ reason: "订单 A-1 第 9 步「订舱」已超期 2 天", href: "/orders/o1?node=9" });
    expect(items[1].reason).toBe("订单 C-1 卡在第 7 步「生产跟进」");
  });
});

describe("从库里取", () => {
  let 我: string;
  beforeEach(async () => {
    await resetDb();
    我 = (await 造本人()).id;
    mocks.user = { ...mocks.user, id: 我 };
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("取订单提醒项：只取我名下、没完成没不适用、排了日子或卡住的；盯盘里看得到超期那一步", async () => {
    const c = await 造客户(我, { name: "Acme" });
    const r = await createOrder({ customerId: c.id, amount: 100, currency: "USD", no: "A-1" });
    if (!r.ok) throw new Error(r.error);
    const 昨天 = dayjs().subtract(1, "day").endOf("day").toISOString();
    await saveOrderNode(r.id, 5, { dueAt: 昨天 });
    await saveOrderNode(r.id, 6, { dueAt: 昨天, status: "已完成" });
    await saveOrderNode(r.id, 7, { dueAt: 昨天, status: "不适用" });
    await saveOrderNode(r.id, 8, { status: "卡住" });
    const 项 = await 取订单提醒项(我);
    expect(项.map((x) => [x.节点, x.卡住]).sort()).toEqual([["收定金", false], ["验货 / 货好", true]]);
    expect(await 取订单提醒项("别人")).toEqual([]);
    expect(算提醒([], new Date(), 项).订单.超期).toBe(2);
    const 盯 = await loadWatchlist();
    // 订单节点这一版不上（lib/features.ts）：盯盘里不出订单
    if (订单节点) expect(盯[0]).toMatchObject({ kind: "order_late", customerName: "Acme" });
    else expect(盯.some((x) => x.kind === "order_late")).toBe(false);
  });
});
