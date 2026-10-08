/**
 * r2-ai · 五、桌面端特有：本机那份 .cloud.json 不对劲时，AI 按钮怎么表现。
 *
 * .cloud.json 存在数据目录里（令牌、网关地址、模型列表），壳和本地服务都读它。
 * 它会缺字段（老版本写的）、会坏（写到一半断电、手改）、模型列表会过时或拉不到、令牌会被吊销、机器会断网。
 * 这里不验壳（Electron 那一侧），只验本地服务这一侧：AI 入口给不给、点了说什么、会不会把页面整个弄崩。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeTestDatabases } from "./close-databases";
import { resetDb } from "./reset";
import {
  建控制库, 网关环境, 建账号带令牌, 用掉, 装桌面端, 拆桌面端, 标准凭据, 接线, 是人话, 等一下, 回文本, 云,
} from "./r2-ai-harness";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const 根 = path.join(os.tmpdir(), `r2-ai-desk-${process.pid}`);
let 目录 = "";
let 客户 = "";
let 账号: Awaited<ReturnType<typeof 建账号带令牌>>;

beforeAll(() => 建控制库(根));
afterAll(async () => {
  await closeTestDatabases(根);
  fs.rmSync(根, { recursive: true, force: true });
});

beforeEach(async () => {
  网关环境();
  (await import("@/lib/ai-quota")).resetAiQuota();
  (await import("@/lib/rate-limit")).重置限流();
  await resetDb();
  const { prisma } = await import("@/lib/prisma");
  await prisma.user.create({ data: { id: "tester-id", email: "t@t", name: "测试员", role: "ADMIN", password: "x" } });
  客户 = (await prisma.customer.create({ data: { name: "王同学", phone: "13800000001", salesOwnerId: "tester-id" } })).id;
  账号 = await 建账号带令牌();
});
afterEach(() => {
  vi.unstubAllGlobals();
  拆桌面端(目录);
});

const 起草 = async () => (await import("@/app/(app)/dashboard/ai")).draftWakeup({ customerId: 客户, reason: "沉睡 20 天" });
const 错误 = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));
const 读凭据 = () => JSON.parse(fs.readFileSync(path.join(目录, ".cloud.json"), "utf8")) as { models: string[] };
const 正常上游 = () => 回文本('{"message":"王同学你好"}');

describe(".cloud.json 的几种样子", () => {
  it("0.39.2 之前的老格式（没有 accountId）：AI 照常能用", async () => {
    const { accountId: _, ...老 } = 标准凭据(账号.token);
    void _;
    目录 = 装桌面端(老);
    接线({ 上游: 正常上游 });
    expect((await 起草()).ok).toBe(true);
  });

  it("models 为空（登录那一下拉模型失败了）：默认 deepseek-chat 不在白名单，网关换成默认模型，照常能用", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: [] }));
    const 线 = 接线({ 上游: 正常上游 });
    expect((await 起草()).ok).toBe(true);
    expect(线.上游[0].body.model).toBe("deepseek-v4.1-flash");
  });

  it("models 里全是已下线的模型：网关换成默认，照常能用；选单里也不会让人选到下线的以外的东西", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: ["glm-5.3-flash|限时免费"] }));
    const 线 = 接线({ 上游: 正常上游 });
    expect((await 起草()).ok).toBe(true);
    expect(线.上游[0].body.model).toBe("deepseek-v4.1-flash");
    // 浏览器存着的旧选择（localStorage）报上来也只会落到白名单里
    const { resolveModel } = await import("@/lib/llm");
    expect(await resolveModel("gpt-4o")).toBeUndefined();
  });

  it("models 是 null：当成空，不崩", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: null }));
    接线({ 上游: 正常上游 });
    const { listModelOptions } = await import("@/lib/llm");
    await expect(listModelOptions()).resolves.toBeDefined();
    expect((await 起草()).ok).toBe(true);
  });

  it("【坏】models 里混进了对象（手改 / 别的版本写的 {id, note}）：读配置就抛 TypeError，所有页面的布局都跟着崩", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: [{ id: "deepseek-v4.1-flash", note: "默认" }] }));
    接线({ 上游: 正常上游 });
    const { listModelOptions, llmEnabled } = await import("@/lib/llm");
    // (app)/layout.tsx 每次整页加载都调这两个
    await expect(llmEnabled(), "布局里调的 llmEnabled 不该抛").resolves.toBe(true);
    await expect(listModelOptions(), "布局里调的 listModelOptions 不该抛").resolves.toBeDefined();
  });

  it("【坏】缺 baseUrl（文件被截掉一部分但还是合法 JSON）：点 AI 说「检查网络」，其实该重新登录", async () => {
    const { baseUrl: _, ...缺 } = 标准凭据(账号.token);
    void _;
    目录 = 装桌面端(缺);
    接线({ 上游: 正常上游 });
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(是人话(错误(r)), 错误(r)).toBe(true);
    expect(错误(r), `界面上会显示：${错误(r)}`).toMatch(/登录/);
  });

  it("【坏】文件坏了（不是合法 JSON）：AI 入口整个消失；点到的那一下说「请管理员到设置管理…填 API Key」，桌面端没有管理员", async () => {
    目录 = 装桌面端('{"baseUrl":"http://cloud.test","token":"dk_');
    接线({ 上游: 正常上游 });
    const { llmEnabled } = await import("@/lib/llm");
    expect(await llmEnabled()).toBe(false);
    const r = await 起草();
    expect(r.ok).toBe(false);
    expect(错误(r), `界面上会显示：${错误(r)}`).not.toContain("管理员");
  });

  it("空文件 / 没有 token：当没登录，不崩", async () => {
    // 本机开发目录里的 .env 可能带着 LLM_*，那是自部署的配置，和桌面端无关
    for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) delete process.env[k];
    目录 = 装桌面端("");
    const { llmEnabled, listModelOptions } = await import("@/lib/llm");
    expect(await llmEnabled()).toBe(false);
    expect(await listModelOptions()).toEqual([]);
  });
});

describe("模型列表刷新（每 6 小时后台拉一次）", () => {
  // 「上次拉模型」是模块级的：每条用例换一份新模块，才会真去拉
  beforeEach(() => vi.resetModules());

  it("刷新失败短暂退避，30秒后重试；成功后才等6小时，切账户独立刷新", async () => {
    let now = Date.now(); const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let 次数 = 0;
    try {
      目录 = 装桌面端(标准凭据(账号.token, { models: ["old-model"] }));
      接线({ 上游: 正常上游, 云端回: (url) => url.endsWith("/models") ?
        (++次数 === 1 ? new Response("oops", { status: 500 }) : new Response(JSON.stringify({ data: [{ id: "new-model" }] }))) : null });
      const { 模型配置 } = await import("@/lib/desktop/cloud");
      模型配置(); 模型配置();
      await 等一下(100);
      expect(次数).toBe(1);
      now += 31_000;
      模型配置(); await 等一下(100);
      expect(次数).toBe(2);
      expect(读凭据().models).toEqual(["new-model"]);
      now += 60_000;
      模型配置(); await 等一下(100);
      expect(次数).toBe(2);
      fs.writeFileSync(path.join(目录, ".cloud.json"), JSON.stringify(标准凭据("dk_another-test-account")));
      模型配置(); await 等一下(100);
      expect(次数).toBe(3);
    } finally { spy.mockRestore(); }
  });

  it("拉到新列表：写回 .cloud.json，不挡这一次调用", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: ["glm-5.3-flash|限时免费"] }));
    接线({ 上游: 正常上游 });
    expect((await 起草()).ok).toBe(true);
    await 等一下(200);
    expect(读凭据().models).toEqual(["deepseek-v4.1-flash"]);
  });

  it("拉的时候云端 500：留着旧的，AI 照常（网关会换默认）", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: ["glm-5.3-flash"] }));
    接线({ 上游: 正常上游, 云端回: (url) => (url.endsWith("/models") ? new Response("oops", { status: 500 }) : null) });
    expect((await 起草()).ok).toBe(true);
    await 等一下(200);
    expect(读凭据().models).toEqual(["glm-5.3-flash"]);
  });

  it("拉的时候断网：留着旧的，不抛到界面", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: ["glm-5.3-flash"] }));
    接线({ 上游: 正常上游, 云断网: () => true });
    const r = await 起草();
    expect(错误(r)).toContain("连不上");
    await 等一下(200);
    expect(读凭据().models).toEqual(["glm-5.3-flash"]);
  });

  it("拉的时候网关说空列表：不把选单清空", async () => {
    目录 = 装桌面端(标准凭据(账号.token, { models: ["deepseek-v4.1-flash"] }));
    接线({ 上游: 正常上游, 云端回: (url) => (url.endsWith("/models") ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : null) });
    await 起草();
    await 等一下(200);
    expect(读凭据().models).toEqual(["deepseek-v4.1-flash"]);
  });
});

describe("离线 / 令牌被吊销", () => {
  it("离线：AI 入口照样显示（读的是本地文件），点了说「连不上」，不卡、不扣；设置页余额是「查不到」", async () => {
    目录 = 装桌面端(标准凭据(账号.token));
    接线({ 上游: 正常上游, 云断网: () => true });
    const { llmEnabled, describeLlmConfig } = await import("@/lib/llm");
    expect(await llmEnabled()).toBe(true);
    const t0 = Date.now();
    const r = await 起草();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(错误(r)).toContain("连不上");
    expect(是人话(错误(r))).toBe(true);
    expect((await describeLlmConfig()).credits).toBeNull();
    expect(await 用掉(账号.acc.id)).toBe(0);
  });

  it("令牌被吊销（在网页端「已登录的机器」里踢掉了这台）：点 AI 说「重新登录」；余额查不到；模型列表不被清掉", async () => {
    目录 = 装桌面端(标准凭据(账号.token));
    const { 吊销 } = await import("@/lib/tenant/device-token");
    await 吊销(账号.tokenId, 账号.acc.id);
    vi.resetModules();
    接线({ 上游: 正常上游 });
    const r = await 起草();
    expect(错误(r)).toContain("重新登录");
    const { 余额 } = await import("@/lib/desktop/cloud");
    expect(await 余额()).toBeNull();
    await 等一下(200);
    expect(读凭据().models).toEqual(["deepseek-v4.1-flash"]);
  });
});

void 云;
