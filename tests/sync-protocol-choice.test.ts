/**
 * 选协议（lib/sync/client.ts 定协议，2026-10-14 候选 9）：老板自动迁移只看服务端开关，
 * 桌面端不用设任何环境变量（真用户双击打开，从来不设）；本机 CRM_SCOPED_SYNC=0 是显式不迁移的应急开关。
 */
import { describe, expect, it } from "vitest";
import { 定协议, 等老板迁移, type 范围状态回包 } from "@/lib/sync/client";

const 本机 = { device: "dev-a", 能管理: true };
const 状态 = (x: Partial<范围状态回包>): 范围状态回包 => ({ stage: "legacy", owner: false, enabled: false, device: null, ...x });

describe("定协议", () => {
  it("服务端开关关着：老板、业务员都走旧协议", () => {
    expect(定协议(状态({ owner: true }), 本机, undefined)).toEqual({ 走: "legacy" });
    expect(定协议(状态({ owner: false }), 本机, undefined)).toEqual({ 走: "legacy" });
    // 本机设了 1 也不能越过服务端：服务端没开就没有新协议可走
    expect(定协议(状态({ owner: true }), 本机, "1")).toEqual({ 走: "legacy" });
  });

  it("服务端开关开、团队还没迁移：建团队那台的老板不设环境变量也自动迁移", () => {
    for (const env of [undefined, "", "1", " "]) expect(定协议(状态({ owner: true, enabled: true }), 本机, env)).toEqual({ 走: "migrate" });
  });

  it("新建的团队（服务端开着、还没有 SyncPrivacy）同样由老板那台第一轮直接开始范围同步", () => {
    // 新团队在服务端也是 stage=legacy、enabled=true：和老团队同一条路（备份 → 冻结 → 起点 → commit），不需要单独入口
    expect(定协议(状态({ owner: true, enabled: true }), { device: "new-dev", 能管理: true })).toEqual({ 走: "migrate" });
  });

  it("本机 CRM_SCOPED_SYNC=0：不开始迁移，走旧协议", () => {
    expect(定协议(状态({ owner: true, enabled: true }), 本机, "0")).toEqual({ 走: "legacy" });
    expect(定协议(状态({ owner: false, enabled: true }), 本机, "0")).toEqual({ 走: "legacy" });
  });

  it("应急开关只管开始：已经 building / ready 的照旧走新协议（旧流已冻结，退不回去）", () => {
    expect(定协议(状态({ owner: true, enabled: true, stage: "building", device: "dev-a" }), 本机, "0")).toEqual({ 走: "migrate" });
    expect(定协议(状态({ owner: false, enabled: true, stage: "ready" }), 本机, "0")).toEqual({ 走: "scoped" });
  });

  it("老板的其它电脑（没有签名钥匙，不能管理团队）：不发起迁移，先用旧协议，等建团队那台", () => {
    expect(定协议(状态({ owner: true, enabled: true }), { device: "dev-b", 能管理: false })).toEqual({ 走: "legacy" });
  });

  it("业务员：服务端开着、老板还没迁移 → 不去碰必然 409 的旧接口，说清楚要老板打开新版本", () => {
    const d = 定协议(状态({ owner: false, enabled: true }), 本机);
    expect(d).toEqual({ 走: "等", error: 等老板迁移 });
    expect(等老板迁移).toMatch(/老板/);
    expect(等老板迁移).toMatch(/最新版/);
  });

  it("building：只有开始迁移的那台老板设备继续（断点续做），老板别的电脑和业务员等待", () => {
    expect(定协议(状态({ owner: true, enabled: true, stage: "building", device: "dev-a" }), 本机)).toEqual({ 走: "migrate" });
    const 别台 = 定协议(状态({ owner: true, enabled: true, stage: "building", device: "dev-a" }), { device: "dev-b", 能管理: true });
    expect(别台).toMatchObject({ 走: "等" });
    expect((别台 as { error: string }).error).toMatch(/另一台/);
    expect(定协议(状态({ owner: false, enabled: true, stage: "building", device: null }), 本机)).toMatchObject({ 走: "等" });
  });

  it("ready：老板、业务员都走范围同步；服务端开关后来关了（enabled 仍为真）也不退回", () => {
    expect(定协议(状态({ owner: true, enabled: true, stage: "ready" }), 本机)).toEqual({ 走: "scoped" });
    expect(定协议(状态({ owner: false, enabled: true, stage: "ready" }), 本机)).toEqual({ 走: "scoped" });
  });
});
