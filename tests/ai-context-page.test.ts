/**
 * 全局 AI 面板带的那句上下文。
 *
 * 钉两头：该带的带上（列表页的筛选条件是问题的一部分——在筛着"已签约"的客户列表上问
 * "这些人谁快签了"，不带筛选就是另一个问题），不该带的不带（首页、设置页没有"范围"这回事，
 * 硬造一句只会让模型多想一轮）。
 *
 * 这是第五份「必须和别处一致的清单」：每条一级路由都要有说法，
 * 漏了的话那一页的面板会安静地失去上下文——不报错，只是答得不对题。
 */
import { describe, it, expect } from "vitest";
import { 认页面 } from "@/lib/ai-context-page";

const 参数 = (s: string) => new URLSearchParams(s);

describe("认页面", () => {
  it("列表页：带页面名", () => {
    expect(认页面("/customers", null)?.标签).toBe("客户");
    expect(认页面("/channels", null)?.提示).toContain("渠道列表");
  });

  it("列表页带筛选：筛选条件是问题的一部分", () => {
    const r = 认页面("/customers", 参数("followStatus=已签约"));
    expect(r?.标签).toBe("客户，筛了跟进状态 已签约");
    expect(r?.提示).toContain("已签约");
    expect(r?.提示).toContain("范围");
  });

  it("多个筛选一起带", () => {
    const r = 认页面("/opportunities", 参数("stage=方案报价&owner=李四"));
    expect(r?.标签).toContain("阶段 方案报价");
    expect(r?.标签).toContain("负责人 李四");
  });

  it("客户详情：解得开「他」", () => {
    const r = 认页面("/customers/abc123", null, "张三");
    expect(r?.标签).toBe("客户 · 张三");
    expect(r?.提示).toContain("「他」");
    expect(r?.提示).toContain("张三");
  });

  it("详情页没拿到名字就不瞎编", () => {
    expect(认页面("/customers/abc123", null)).toBeNull();
  });

  it("首页和设置没有「范围」这回事，不硬造", () => {
    expect(认页面("/dashboard", null)).toBeNull();
    expect(认页面("/settings", null)).toBeNull();
    expect(认页面("/billing", null)).toBeNull();
  });

  it("首页带了筛选参数也不算——?c= 是对话 id，不是筛选", () => {
    expect(认页面("/dashboard", 参数("c=xyz"))).toBeNull();
  });

  it("认不出来的路径返回 null，不抛", () => {
    expect(认页面("/whatever", null)).toBeNull();
    expect(认页面("/", null)).toBeNull();
  });

  /**
   * 左栏里有的路由，这张表里必须都有——漏一条的后果是那一页的面板安静地失去上下文：
   * 不报错，只是答得不对题。和打包白名单、工具 schema 是同一类洞。
   */
  it("左栏每一项都有说法", async () => {
    const shell = (await import("node:fs")).readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
    const 路径 = [...new Set([...shell.matchAll(/key: "(\/[a-z-]+)", icon:/g)].map((m) => m[1]))];
    expect(路径.length).toBeGreaterThanOrEqual(8);
    const 漏了 = 路径.filter((p) => !认页面(p, 参数("followStatus=x")) && !认页面(p, null));
    expect(漏了, `这些页面没有上下文说法：${漏了.join("、")}`).toEqual([]);
  });
});
