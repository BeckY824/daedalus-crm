/**
 * 企业版组织规则的规整和合并（lib/project/org-rules.ts）：默认全关；存坏的退回默认；
 * 界面填错的报出来不偷偷改；每人上限整份替换、null 删掉单独设置。
 */
import { describe, it, expect } from "vitest";
import { 规整组织规则, 合上改动, 持有上限of, 默认组织规则 } from "@/lib/project/org-rules";

describe("规整组织规则", () => {
  it("没存过、存坏了：全是默认（上限关着）", () => {
    expect(规整组织规则(undefined)).toEqual(默认组织规则);
    expect(规整组织规则("乱")).toEqual(默认组织规则);
    expect(规整组织规则({ 公海: 3 })).toEqual(默认组织规则);
    expect(默认组织规则.公海.持有上限开).toBe(false);
  });

  it("超出范围、不是整数的退回默认或丢掉；不认识的 key 丢掉；数字字符串认", () => {
    expect(规整组织规则({
      别的: 1,
      公海: { 持有上限开: "true", 默认上限: 0, 每人上限: { a: 3, b: -1, c: 1.5, d: "7", e: 1000, "": 2 } },
    })).toEqual({ 公海: { 持有上限开: false, 默认上限: 30, 每人上限: { a: 3, d: 7 } } });
    expect(规整组织规则({ 公海: { 持有上限开: true, 默认上限: "12" } }).公海).toMatchObject({ 持有上限开: true, 默认上限: 12 });
  });
});

describe("合上改动", () => {
  it("只改传了的；开关、默认、每人分开改", () => {
    const 开了 = 合上改动(默认组织规则, { 公海: { 持有上限开: true } });
    expect(开了).toEqual({ 公海: { 持有上限开: true, 默认上限: 30, 每人上限: {} } });
    const 设了 = 合上改动(开了 as never, { 公海: { 默认上限: 10, 每人上限: { a: 0, b: 5 } } });
    expect(设了).toEqual({ 公海: { 持有上限开: true, 默认上限: 10, 每人上限: { a: 0, b: 5 } } });
  });

  it("每人上限整份替换：传 null / 空的人回到默认", () => {
    const 现在 = { 公海: { 持有上限开: true, 默认上限: 10, 每人上限: { a: 1, b: 2 } } };
    expect(合上改动(现在, { 公海: { 每人上限: { a: null, b: 3 } } })).toEqual({ 公海: { 持有上限开: true, 默认上限: 10, 每人上限: { b: 3 } } });
  });

  it("填错的报出来", () => {
    expect(合上改动(默认组织规则, { 公海: { 默认上限: 0 } })).toEqual({ error: "默认持有上限请填 1–999 的整数" });
    expect(合上改动(默认组织规则, { 公海: { 默认上限: 2.5 } })).toMatchObject({ error: expect.stringContaining("整数") });
    expect(合上改动(默认组织规则, { 公海: { 每人上限: { a: -1 } } })).toEqual({ error: "单独设的上限请填 0–999 的整数" });
    expect(合上改动(默认组织规则, { 公海: { 持有上限开: "开" as never } })).toEqual({ error: "持有上限开关只能开或关" });
    expect(合上改动(默认组织规则, null as never)).toEqual({ error: "要改什么？" });
  });
});

describe("持有上限of", () => {
  it("关着 = 不限；开着用单独设的，没设用默认；0 也算单独设了", () => {
    const 规则 = { 公海: { 持有上限开: false, 默认上限: 10, 每人上限: { a: 0 } } };
    expect(持有上限of(规则, "a")).toBeNull();
    规则.公海.持有上限开 = true;
    expect(持有上限of(规则, "a")).toBe(0);
    expect(持有上限of(规则, "b")).toBe(10);
  });
});
