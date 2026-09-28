/**
 * 「1 次」角标和「免费次数还剩 N 次」对谁显示（lib/ai-meter.ts + components/AiCost.tsx，交互审查 M5）。
 *
 * 规矩：按钮旁边写明它要花掉几次——但只对真会花的人写。自己的 Key、付费、自部署一次都不扣，
 * 对他们写「1 次」是一句在他那儿不成立的话。钉两件事：
 *   1. 计不计次，和真正扣次数的地方一一对应
 *   2. 清单上那些会调模型的按钮都挂着 <AiCost />
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 状态 = vi.hoisted(() => ({
  多租户: false,
  来源: null as "ui" | "cloud" | "env" | null,
  余额: null as { 还剩: number; 上限: number } | null,
  受限: true,
}));

vi.mock("@/lib/tenant/context", () => ({ multiTenant: () => 状态.多租户 }));
vi.mock("@/lib/tenant/resolve", () => ({ resolveCurrentTenant: async () => ({ workspaceId: "ws1" }) }));
vi.mock("@/lib/tenant/ai-allowance", () => ({
  查额度: async () => ({ 上限: 30, 用掉: 3, 还剩: 27, 受限: 状态.受限 }),
  自带Key: async () => 状态.来源 === "ui",
}));
vi.mock("@/lib/llm-config", () => ({
  模型来源: async () => 状态.来源,
  describeLlmConfig: async () => ({ source: 状态.来源, credits: 状态.余额 ? { ...状态.余额, 用掉: 0 } : null }),
}));

import { 读AI计次 } from "@/lib/ai-meter";

beforeEach(() => {
  状态.多租户 = false;
  状态.来源 = null;
  状态.余额 = null;
  状态.受限 = true;
});

describe("谁计次", () => {
  it("桌面端登录了云端账号：计次；布局那次不联网，数由浏览器随后问", async () => {
    状态.来源 = "cloud";
    状态.余额 = { 还剩: 26, 上限: 30 };
    expect(await 读AI计次({ 问余额: false })).toEqual({ 计次: true, 还剩: null, 上限: null });
    expect(await 读AI计次({ 问余额: true })).toEqual({ 计次: true, 还剩: 26, 上限: 30 });
  });

  it("云端余额问不到（断网）：照样计次，只是不报数", async () => {
    状态.来源 = "cloud";
    expect(await 读AI计次({ 问余额: true })).toEqual({ 计次: true, 还剩: null, 上限: null });
  });

  it("填了自己的 Key：不计次，角标和那行字都不显示", async () => {
    状态.来源 = "ui";
    expect((await 读AI计次({ 问余额: true })).计次).toBe(false);
  });

  it("自部署（.env 里的 Key）：不计次", async () => {
    状态.来源 = "env";
    expect((await 读AI计次({ 问余额: true })).计次).toBe(false);
  });

  it("托管版：试用中计次，数从控制面库直接查；付费工作区不计", async () => {
    状态.多租户 = true;
    状态.来源 = "env";
    expect(await 读AI计次({ 问余额: false })).toEqual({ 计次: true, 还剩: 27, 上限: 30 });
    状态.受限 = false;
    expect((await 读AI计次({ 问余额: false })).计次).toBe(false);
  });

  it("托管版：工作区在设置里填了自己的 Key——花他自己的钱，不计次", async () => {
    状态.多租户 = true;
    状态.来源 = "ui";
    expect((await 读AI计次({ 问余额: false })).计次).toBe(false);
  });
});

describe("会调模型的按钮都挂着「1 次」", () => {
  const 读 = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../src", rel), "utf8");
  const 按钮后面跟着角标 = (s: string, 字: string) => new RegExp(`${字}[^<]*\\s*(\\{[^}]*\\}\\s*)?<AiCost />`).test(s) || new RegExp(`${字}"\\}\\s*\\{[^}]*<AiCost />`).test(s);

  it.each([
    ["app/(app)/customers/[id]/AiPanel.tsx", ["起草跟进话术", "起草转介绍邀请", "简报"]],
    ["app/(app)/customers/[id]/FollowUpForm.tsx", ["AI 解析填表"]],
    ["app/(app)/customers/[id]/RecordView.tsx", ["AI 解析"]],
    ["app/(app)/dashboard/SentinelCard.tsx", ["AI 解读", "起草跟进"]],
    ["app/(app)/channels/ReferralRadar.tsx", ["起草邀请"]],
    ["app/(app)/dashboard/TurnView.tsx", ["起草跟进话术", "起草转介绍邀请"]],
  ] as const)("%s", (文件, 字们) => {
    const s = 读(文件);
    for (const 字 of 字们) expect(按钮后面跟着角标(s, 字), `${文件} 的「${字}」没挂 <AiCost />`).toBe(true);
  });

  it("「↻ 重新回答」也挂着", () => {
    expect(读("app/(app)/dashboard/TurnView.tsx")).toMatch(/aria-label="重新回答"[^>]*>\s*<ReloadOutlined \/>\s*<AiCost \/>/);
  });

  it("首页和 ⌘J 面板（同一个 HomeChat）输入框下那行字", () => {
    expect(读("app/(app)/dashboard/HomeChat.tsx")).toMatch(/<AiRemaining \/>/);
  });
});
