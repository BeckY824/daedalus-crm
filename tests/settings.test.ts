/**
 * 系统设置：键值读写与缓存、敏感值加解密、业务配置回退、AI 配置两级读取。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSetting, setSetting, invalidateSettingsCache, encryptSecret, decryptSecret, maskSecret } from "@/lib/settings";
import { mergeBusiness, DEFAULT_BUSINESS } from "@/lib/business-config";
import { getBusiness, saveBusiness } from "@/lib/business";
import { getLlmConfig, saveLlmConfig, clearLlmConfig, describeLlmConfig, DEFAULT_BASE_URL, DEFAULT_MODEL } from "@/lib/llm";
import { buildWatchlist } from "@/lib/sentinel";

beforeEach(async () => {
  await prisma.setting.deleteMany();
  invalidateSettingsCache();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
});
afterAll(() => prisma.$disconnect());

describe("键值读写与缓存", () => {
  it("没存过的 key 返回 null；写入后能读回同一个对象", async () => {
    expect(await getSetting("nope")).toBeNull();
    await setSetting("k", { a: 1, b: ["x"] });
    expect(await getSetting("k")).toEqual({ a: 1, b: ["x"] });
  });

  it("读取走缓存：绕过 setSetting 直接改库，不失效就读到旧值，失效后读到新值", async () => {
    await setSetting("k", 1);
    expect(await getSetting("k")).toBe(1);
    await prisma.setting.update({ where: { key: "k" }, data: { value: "2" } });
    expect(await getSetting("k"), "缓存命中，仍是旧值").toBe(1);
    invalidateSettingsCache();
    expect(await getSetting("k")).toBe(2);
  });

  it("库里存了非法 JSON 时按没配处理，不抛错", async () => {
    await prisma.setting.create({ data: { key: "bad", value: "{not json" } });
    invalidateSettingsCache();
    expect(await getSetting("bad")).toBeNull();
  });
});

describe("敏感值加解密", () => {
  it("往返一致，且密文里不含明文", () => {
    const enc = encryptSecret("sk-very-secret-12345");
    expect(enc).not.toContain("very-secret");
    expect(decryptSecret(enc)).toBe("sk-very-secret-12345");
  });
  it("同一明文两次加密密文不同（随机 IV），都能解", () => {
    const a = encryptSecret("x"), b = encryptSecret("x");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("x");
    expect(decryptSecret(b)).toBe("x");
  });
  it("被篡改或不是本系统格式的串解出 null，而不是抛错", () => {
    const enc = encryptSecret("abc");
    expect(decryptSecret(enc.slice(0, -2) + "zz")).toBeNull();
    expect(decryptSecret("plain-text")).toBeNull();
  });
  it("回显只露尾 4 位", () => {
    expect(maskSecret("sk-abcdef1234")).toBe("****1234");
    expect(maskSecret("ab")).toBe("****");
  });
});

describe("业务配置", () => {
  it("没存过时全部是默认值", async () => {
    expect(await getBusiness()).toEqual(DEFAULT_BUSINESS);
  });
  it("部分缺失、空串、空数组都回退到默认，不会让页面拿到空标签", () => {
    const m = mergeBusiness({ customer: "  ", fields: { school: "公司", grade: "", major: "行业" }, grades: [] } as never);
    expect(m.customer).toBe("学员");
    expect(m.fields).toEqual({ school: "公司", grade: "年级", major: "行业" });
    expect(m.grades).toEqual(DEFAULT_BUSINESS.grades);
  });
  it("保存后读回，选项列表去掉空白项", async () => {
    await saveBusiness({ ...DEFAULT_BUSINESS, customer: "客户", grades: ["A", " ", "B "] });
    const b = await getBusiness();
    expect(b.customer).toBe("客户");
    expect(b.grades).toEqual(["A", "B"]);
  });
  it("盯盘的沉睡文案跟着术语走", () => {
    const items = buildWatchlist(
      { overduePlans: [], opportunities: [], customers: [{ id: "c", name: "甲", followStatus: "跟进中", lastFollowAt: new Date(Date.now() - 30 * 86400_000), createdAt: new Date(0), ownerName: "张三" }] },
      new Date(),
      "客户",
    );
    expect(items[0].reason).toContain("客户");
    expect(items[0].reason).not.toContain("学员");
  });
});

describe("AI 配置两级读取", () => {
  it("两处都没有 → null", async () => {
    expect(await getLlmConfig()).toBeNull();
    expect((await describeLlmConfig()).source).toBeNull();
  });
  it("只有环境变量 → 用环境变量，地址与模型有默认值", async () => {
    process.env.LLM_API_KEY = "env-key";
    const c = await getLlmConfig();
    expect(c).toEqual({ apiKey: "env-key", baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL });
    expect((await describeLlmConfig()).source).toBe("env");
  });
  it("界面配置优先于环境变量；地址末尾斜杠会被去掉", async () => {
    process.env.LLM_API_KEY = "env-key";
    await saveLlmConfig({ baseUrl: "https://x.example/v1/", model: "m1", apiKey: "ui-key" });
    expect(await getLlmConfig()).toEqual({ apiKey: "ui-key", baseUrl: "https://x.example/v1", model: "m1" });
    const d = await describeLlmConfig();
    expect(d.source).toBe("ui");
    expect(d.keyMasked).toBe("****-key");
  });
  it("key 传空只改地址与模型，沿用已存的 key", async () => {
    await saveLlmConfig({ baseUrl: "https://a.example", model: "m1", apiKey: "ui-key" });
    await saveLlmConfig({ baseUrl: "https://b.example", model: "m2", apiKey: "" });
    expect(await getLlmConfig()).toEqual({ apiKey: "ui-key", baseUrl: "https://b.example", model: "m2" });
  });
  it("库里的 key 明文不落库", async () => {
    await saveLlmConfig({ baseUrl: "https://a.example", model: "m", apiKey: "sk-plain-secret" });
    const row = await prisma.setting.findUnique({ where: { key: "llm" } });
    expect(row!.value).not.toContain("sk-plain-secret");
  });
  it("清除界面配置后回到环境变量", async () => {
    process.env.LLM_API_KEY = "env-key";
    await saveLlmConfig({ baseUrl: "https://a.example", model: "m", apiKey: "ui-key" });
    await clearLlmConfig();
    expect((await getLlmConfig())!.apiKey).toBe("env-key");
  });
});

describe("状态显示名", () => {
  it("只存合法状态值、且与原值不同的项；非法键与空串丢弃", () => {
    const m = mergeBusiness({ statusLabels: { 已试听: "已体验", 待跟进: "待跟进", 不存在的: "x", 已签约: "  " } } as never);
    expect(m.statusLabels).toEqual({ 已试听: "已体验" });
  });
  it("statusLabel 没改过就返回值本身", async () => {
    const { statusLabel } = await import("@/lib/business-config");
    expect(statusLabel({ statusLabels: { 已试听: "已体验" } }, "已试听")).toBe("已体验");
    expect(statusLabel({ statusLabels: {} }, "已试听")).toBe("已试听");
  });
  it("盯盘文案用显示名", () => {
    const items = buildWatchlist(
      { overduePlans: [], opportunities: [], customers: [{ id: "c", name: "甲", followStatus: "已试听", lastFollowAt: new Date(Date.now() - 30 * 86400_000), createdAt: new Date(0), ownerName: "张三" }] },
      new Date(),
      "学员",
      (v) => (v === "已试听" ? "已体验" : v),
    );
    expect(items[0].reason).toContain("「已体验」");
  });
});

describe("AI 用量统计", () => {
  it("按功能汇总本月 ai_use 日志，上月的不算，没用过的功能也列出为 0", async () => {
    const { recordAiUse, aiUsageThisMonth } = await import("@/lib/ai-usage");
    await prisma.auditLog.deleteMany();
    const me = { id: "u", name: "测试员" };
    await recordAiUse(me, "parse", "a");
    await recordAiUse(me, "parse", "b");
    await recordAiUse(me, "ask", "c");
    // 上月的一条
    await prisma.auditLog.create({ data: { userId: "u", userName: "x", action: "ai_use", entity: "Ai", entityId: "brief", summary: "old", at: new Date(Date.now() - 40 * 86400_000) } });
    const usage = await aiUsageThisMonth();
    const byKey = Object.fromEntries(usage.map((u) => [u.feature, u.count]));
    expect(byKey).toEqual({ parse: 2, brief: 0, ask: 1, wakeup: 0, invite: 0 });
  });
});
