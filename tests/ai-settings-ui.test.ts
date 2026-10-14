/**
 * 设置 → AI「用你自己的 API Key」那一屏（回归核对 D-072）：桌面端登录着云端账号时
 *   ① 不把云端令牌的尾号说成「你已保存的 Key」——人会以为自己填过，留空保存
 *   ② 留空点保存：拦下，不往库里存一个空 Key（saveLlmSettings 一次都不叫）
 *   ③ 模型默认值是所选那家的第一个，不是网关那边的型号名（拿它当 DeepSeek 的模型必然调不通）
 *
 * 做法同 tests/r7-review-auth-ui.test.ts：esbuild 打包真组件，在 Playwright 的 Chromium 里点；server action、路由换成桩。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { PROVIDERS } from "@/lib/providers";

let browser: Browser;
let 包 = "";

const 桩插件: Plugin = {
  name: "ai-settings-stubs",
  setup(b) {
    const 桩 = (filter: RegExp, contents: string) => {
      b.onResolve({ filter }, (a) => ({ path: a.path + "#" + a.importer, namespace: "stub", pluginData: contents }));
    };
    桩(/^\.\/actions$/, `
      const 叫 = (名, 回) => (...参) => { (window.__调用[名] ||= []).push(参); if (window.__netFail) return Promise.reject(new Error("network")); return Promise.resolve(回); };
      export const saveLlmSettings = 叫("保存", { ok: true });
      export const testLlmSettings = 叫("测试", { ok: true, ms: 1, reply: "ok" });
      export const clearLlmSettings = 叫("清除", { ok: true });
      export const 查MCP接入 = () => new Promise(() => {});
      export const 开启MCP = 叫("开MCP", { ok: true });
      export const 关闭MCP = 叫("关MCP", { ok: true });
      export const 查自动判断 = () => new Promise(() => {});
      export const 设自动判断开关 = 叫("自动判断", { ok: true });
    `);
    桩(/^next\/navigation$/, `export const useRouter = () => ({ refresh() {}, push() {}, replace() {} });`);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData as string, loader: "jsx", resolveDir: process.cwd() }));
  },
};

const 云端那份 = {
  source: "cloud",
  baseUrl: "http://cloud.test/api/gateway/v1",
  model: "glm-5.3-flash",
  keyMasked: "dk_…a9c7",
  options: [{ id: "glm-5.3-flash" }],
  account: "me@example.com",
  credits: { 还剩: 12, 上限: 30, 用掉: 18 },
};

beforeAll(async () => {
  const r = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { App } from "antd";
        import C from "@/app/(app)/settings/AiSettingsTab";
        window.__调用 = {};
        createRoot(document.getElementById("root")).render(
          React.createElement(App, null, React.createElement(C, { llm: ${JSON.stringify(云端那份)}, usage: [] }))
        );
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [桩插件],
    logLevel: "silent",
  });
  包 = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function 开(): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://ai-settings.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><div id="root"></div>` }));
  await page.goto("http://ai-settings.test/");
  await page.addScriptTag({ content: 包 });
  await page.getByText("用你自己的 API Key").waitFor();
  return page;
}

describe("桌面端登录着云端账号，改用自己的 Key（D-072）", () => {
  it("① 不显示云端令牌的尾号；③ 模型默认是所选那家的第一个，不是网关的型号", async () => {
    const page = await 开();
    await page.getByText("用你自己的 API Key").click();
    await page.getByText("API Key", { exact: true }).waitFor();
    const 全文 = await page.locator("body").innerText();
    expect(全文).not.toContain("a9c7");
    expect(全文).not.toContain("已保存（尾号");
    expect(await page.getByPlaceholder("留空沿用已保存的 Key").count()).toBe(0);
    // 「模型」那一格的选中值（antd 6 画在 .ant-select-content 里，id=model 的输入框是它的一部分）
    const 模型 = await page.locator(".ant-select-content:has(#model)").innerText();
    expect(模型).toContain(PROVIDERS[0].models[0].id);
    expect(模型).not.toContain("glm-5.3-flash");
    await page.close();
  });

  it("② Key 留空点保存：当场说「请填写 API Key」，一次都不去存", async () => {
    const page = await 开();
    await page.getByText("用你自己的 API Key").click();
    await page.getByRole("button", { name: /保\s*存/ }).click();
    await expect.poll(() => page.locator("body").innerText()).toContain("请填写 API Key");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __调用: Record<string, unknown[]> }).__调用.保存?.length ?? 0)).toBe(0);
    await page.close();
  });
});


it("AI配置校验与连接/保存网络异常均可恢复，没有未处理拒绝", async () => {
  const page = await 开();
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.getByText("用你自己的 API Key").click();
  await page.getByRole("button", {name: /测试连接/}).click();
  await page.getByText("请填写 API Key", {exact:true}).waitFor();
  await page.locator("#apiKey").fill("qa-fake-not-real-key");
  await page.evaluate(() => Object.assign(window, {__netFail:true}));
  await page.getByRole("button", {name: /测试连接/}).click();
  await page.getByText("连接测试失败，请稍后重试", {exact:true}).waitFor();
  await page.getByRole("button", {name: /保\s*存/}).click();
  await page.getByRole("button", {name:"仍然保存"}).click();
  await page.getByText("保存失败，请刷新确认结果后重试", {exact:true}).waitFor();
  expect(await page.locator("#apiKey").inputValue()).toBe("qa-fake-not-real-key");
  await page.evaluate(() => Object.assign(window, {__netFail:false}));
  await page.getByRole("button", {name: /测试连接/}).click();
  await page.getByText(/模型回复：ok/).waitFor();
  await page.getByRole("button", {name: /保\s*存/}).click();
  await page.getByText("已保存，AI 功能已按新配置生效", {exact:true}).waitFor();
  expect(errors).toEqual([]);
  await page.close();
});
