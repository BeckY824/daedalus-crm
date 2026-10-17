/**
 * 设置 → AI 接入「让别的 agent 连进来」：点「生成接入令牌」后给的命令（2026-10-17）。
 * 原来只给 Claude Code 一条，Codex 一句「参数一样」——不一样：Codex 没有 --header，令牌走环境变量
 * （codex mcp add … --bearer-token-env-var）。这里核：
 *   ① Claude Code、Codex 两组命令都出现，令牌、地址填对；每行一个「复制」，复制出去的就是那一行
 *     Codex 桌面应用那段 config.toml（令牌写在 http_headers 里）也在
 *   ② Windows 上 Codex 第一行是 PowerShell 的 $env:，不是 export
 *   ③ 旧的「参数一样」那句不在了
 *
 * 做法同 tests/ai-settings-ui.test.ts：esbuild 打包真组件，在 Playwright 的 Chromium 里点；server action 换成桩。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { MCP接入命令 } from "@/lib/mcp/commands";

const 地址 = "http://127.0.0.1:3717/api/mcp";
const 令牌 = "dcrm_uitest_0123456789abcdef";

let browser: Browser;
let 包 = "";

const 桩插件: Plugin = {
  name: "mcp-commands-stubs",
  setup(b) {
    const 桩 = (filter: RegExp, contents: string) => {
      b.onResolve({ filter }, (a) => ({ path: a.path + "#" + a.importer, namespace: "stub", pluginData: contents }));
    };
    桩(/^\.\/actions$/, `
      const 好 = (回) => () => Promise.resolve(回);
      export const saveLlmSettings = 好({ ok: true });
      export const testLlmSettings = 好({ ok: true, ms: 1, reply: "ok" });
      export const clearLlmSettings = 好({ ok: true });
      export const 查MCP接入 = 好({ 可用: true, 已开: false, 地址: ${JSON.stringify(地址)}, 令牌: null });
      export const 开启MCP = 好({ ok: true, 地址: ${JSON.stringify(地址)}, 令牌: ${JSON.stringify(令牌)} });
      export const 关闭MCP = 好({ ok: true });
      export const 查自动判断 = () => new Promise(() => {});
      export const 设自动判断开关 = 好({ ok: true });
    `);
    桩(/^next\/navigation$/, `export const useRouter = () => ({ refresh() {}, push() {}, replace() {} });`);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData as string, loader: "jsx", resolveDir: process.cwd() }));
  },
};

beforeAll(async () => {
  const r = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { App } from "antd";
        import C from "@/app/(app)/settings/AiSettingsTab";
        createRoot(document.getElementById("root")).render(
          React.createElement(App, null, React.createElement(C, { llm: { source: "cloud", baseUrl: "http://cloud.test/api/gateway/v1", model: "glm-5.3-flash", keyMasked: "dk_…a9c7", options: [{ id: "glm-5.3-flash" }], account: "me@example.com", credits: { 还剩: 12, 上限: 30, 用掉: 18 } }, usage: [] }))
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

async function 开(ua?: string): Promise<Page> {
  const ctx = await browser.newContext(ua ? { userAgent: ua } : {});
  const page = await ctx.newPage();
  // 剪贴板换成记下来：无头 Chromium 里真剪贴板要授权，这里只关心复制出去的是哪一行
  await page.addInitScript(() => {
    const w = window as unknown as { __复制: string[] };
    w.__复制 = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (t: string) => { w.__复制.push(t); return Promise.resolve(); } },
    });
  });
  await page.route("http://mcp-cmd.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><div id="root"></div>` }));
  await page.goto("http://mcp-cmd.test/");
  await page.addScriptTag({ content: 包 });
  await page.getByRole("button", { name: "生成接入令牌" }).click();
  await page.locator(".mcp-cmd").first().waitFor();
  return page;
}

const 各行 = (page: Page) => page.locator(".mcp-cmd code").allInnerTexts();

describe("生成接入令牌后的命令", () => {
  it("① Claude Code 一条 + Codex 两行，令牌、地址填对，各自复制的是自己那一行", async () => {
    const page = await 开();
    const 期望 = MCP接入命令(地址, 令牌);
    expect(await 各行(page)).toEqual([
      `claude mcp add --transport http daedalus ${地址} --header "Authorization: Bearer ${令牌}"`,
      `export DAEDALUS_TOKEN="${令牌}"`,
      `codex mcp add daedalus --url ${地址} --bearer-token-env-var DAEDALUS_TOKEN`,
      `[mcp_servers.daedalus]\nurl = "${地址}"\nhttp_headers = { Authorization = "Bearer ${令牌}" }`,
    ]);
    expect(期望.codex).toEqual((await 各行(page)).slice(1, 3));
    expect(期望.codex配置).toBe((await 各行(page))[3]);
    const 全文 = await page.locator(".mcp-block").innerText();
    expect(全文).toContain("Claude Code");
    expect(全文).toContain("Codex");
    // ③ 旧说法不在
    expect(全文).not.toContain("参数一样");

    const 复制键 = page.locator(".mcp-cmd").getByRole("button", { name: /复\s*制/ });
    expect(await 复制键.count()).toBe(4);
    for (let i = 0; i < 4; i++) await 复制键.nth(i).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __复制: string[] }).__复制))
      .toEqual(await 各行(page));
    await page.context().close();
  });

  it("② Windows 上 Codex 第一行用 $env:，第二行不变；提示里说 setx", async () => {
    const page = await 开("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    const 行 = await 各行(page);
    expect(行[1]).toBe(`$env:DAEDALUS_TOKEN="${令牌}"`);
    expect(行[2]).toBe(`codex mcp add daedalus --url ${地址} --bearer-token-env-var DAEDALUS_TOKEN`);
    expect(行.join("\n")).not.toContain("export ");
    const 全文 = await page.locator(".mcp-block").innerText();
    expect(全文).toContain("setx DAEDALUS_TOKEN");
    expect(全文).toContain("%USERPROFILE%\\.codex\\config.toml");
    await page.context().close();
  });
});
