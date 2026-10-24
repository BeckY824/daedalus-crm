/**
 * 优化 #11（2026-10-22）：个人版、还没进团队的电脑不挂手机授权框，前台时就不再每 15 秒问一次「有没有手机在等」。
 * 进了团队（.team.json 齐了）才挂；建团队、加入、连上都会 revalidatePath("/", "layout")，进了马上挂上。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { 要问待授权手机 } from "@/lib/sync/mobile-desktop";

const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-mobile-prompt-gate-"));
const 原来 = process.env.CRM_DATA_DIR;
const 团队文件 = path.join(目录, ".team.json");

beforeEach(() => {
  process.env.CRM_DATA_DIR = 目录;
  fs.rmSync(团队文件, { force: true });
});
afterAll(() => {
  if (原来 === undefined) delete process.env.CRM_DATA_DIR; else process.env.CRM_DATA_DIR = 原来;
  fs.rmSync(目录, { recursive: true, force: true });
});

describe("手机授权框只在进了团队的电脑上挂", () => {
  it("个人版（没有 .team.json）：不挂", () => {
    expect(要问待授权手机()).toBe(false);
  });

  it(".team.json 坏了或缺钥匙：不挂（和 读团队 一样算没进团队）", () => {
    fs.writeFileSync(团队文件, "{坏");
    expect(要问待授权手机()).toBe(false);
    fs.writeFileSync(团队文件, JSON.stringify({ teamId: "t1", device: "d1" }));
    expect(要问待授权手机()).toBe(false);
  });

  it("进了团队：挂", () => {
    fs.writeFileSync(团队文件, JSON.stringify({ teamId: "t1", teamName: "团", key: "A".repeat(43), device: "d1", joinSecret: "s", pulled: 0 }));
    expect(要问待授权手机()).toBe(true);
  });

  it("layout 用它挡住授权框（前台每 15 秒问一次的就是这个组件）", () => {
    const layout = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain("{本地模式() && 要问待授权手机() && <MobileAuthPrompt />}");
    const 框 = fs.readFileSync(path.resolve(__dirname, "../src/components/MobileAuthPrompt.tsx"), "utf8");
    expect(框).toContain("setInterval(() => void 问(), 15_000)");
  });
});
