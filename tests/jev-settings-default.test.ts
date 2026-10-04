/**
 * 「导入时让 AI 认列」那个开关默认关（2026-10-04 L-076）。
 *
 * 原来默认开、而且读完表就自动把认不出的列的前 3 行发给判断模型。现在要人点按钮才发，
 * 按钮还得管理员先在设置里打开——没存过（包括 10-04 之前从没碰过开关的老库）一律当关着。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/jev/client", () => ({ 判断可用: () => true }));

import { prisma } from "@/lib/prisma";
import { invalidateSettingsCache } from "@/lib/settings";
import { 自动判断开着, 设自动判断 } from "@/lib/jev/settings";

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: "assist" } });
  invalidateSettingsCache();
});
afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: "assist" } });
  await prisma.$disconnect();
});

describe("导入时让 AI 认列：默认关", () => {
  it("没存过：关着", async () => {
    expect(await 自动判断开着()).toBe(false);
  });

  it("存过一个没写「开」的老值：也当关着", async () => {
    await prisma.setting.create({ data: { key: "assist", value: JSON.stringify({}) } });
    invalidateSettingsCache();
    expect(await 自动判断开着()).toBe(false);
  });

  it("管理员打开了才开；再关掉就关", async () => {
    await 设自动判断(true);
    expect(await 自动判断开着()).toBe(true);
    await 设自动判断(false);
    expect(await 自动判断开着()).toBe(false);
  });
});
