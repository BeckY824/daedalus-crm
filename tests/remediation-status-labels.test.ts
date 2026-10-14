import { afterAll, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa-labels", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async original => ({ ...(await original<object>()), requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { getBusiness } from "@/lib/business";
import { BUSINESS_PRESETS, DEFAULT_BUSINESS, 状态名问题, statusLabel } from "@/lib/business-config";
import { saveBusinessSettings } from "@/app/(app)/settings/actions";
beforeEach(async () => { await resetDb(); invalidateSettingsCache(); state.user.id = (await prisma.user.create({ data: { email: state.user.email, name: "QA", role: "ADMIN", password: "qa" } })).id; });
afterAll(async () => { await prisma.$disconnect(); });

const conflictCases: Record<string, string>[] = [
  { 待跟进: "联系中", 跟进中: "联系中" },
  { 待跟进: "跟 进 中" },
  { 待跟进: "已签约", 已签约: "成功成交" },
  { 待跟进: "已下单" },
  { 待跟进: "跟进\u200b中" },
  { 待跟进: "\u200b\u2060" },
];
it.each(conflictCases)("L-061 直接服务入口拒绝歧义状态%j，不改配置/业务/审计", async statusLabels => {
  await setSetting("business", DEFAULT_BUSINESS);
  const before = await prisma.setting.findUniqueOrThrow({ where: { key: "business" } });
  expect(await saveBusinessSettings({ ...DEFAULT_BUSINESS, statusLabels })).toMatchObject({ ok: false, error: expect.any(String) });
  expect(await prisma.setting.findUniqueOrThrow({ where: { key: "business" } })).toEqual(before);
  expect(await prisma.auditLog.count()).toBe(0);
});
it.each(Object.entries(BUSINESS_PRESETS))("L-061 %s预设保持可保存，合法改名不改变内部ID", async (_name, preset) => {
  expect(状态名问题(preset)).toEqual({});
  expect((await saveBusinessSettings(preset)).ok).toBe(true);
  expect((await getBusiness()).statusLabels).toEqual(preset.statusLabels);
});
it("L-061 自定义名去首尾空格；留空回原名；旧冲突读取不改数据且附原状态", async () => {
  expect((await saveBusinessSettings({ ...DEFAULT_BUSINESS, statusLabels: { 待跟进: "  等待联系  ", 跟进中: "" } })).ok).toBe(true);
  expect((await getBusiness()).statusLabels).toEqual({ 待跟进: "等待联系" });
  await setSetting("business", { ...DEFAULT_BUSINESS, statusLabels: { 待跟进: "相同名称", 跟进中: "相同名称" } });
  const before = await prisma.setting.findUniqueOrThrow({ where: { key: "business" } });
  const old = await getBusiness();
  expect(statusLabel(old, "待跟进")).toBe("相同名称（原状态：待跟进）");
  expect(statusLabel(old, "跟进中")).toBe("相同名称（原状态：跟进中）");
  expect(statusLabel(old, "已签约")).toBe("已签约");
  expect(await prisma.setting.findUniqueOrThrow({ where: { key: "business" } })).toEqual(before);
});
