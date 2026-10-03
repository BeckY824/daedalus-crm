/**
 * 第七轮对抗复查：桌面端登录门 DesktopAuth / 找回密码 DesktopForgot 的真组件，在真 Chromium 里走流程。
 *
 * 做法同 tests/r6-review-otp.test.ts：esbuild 打包真组件，Playwright 的 Chromium 里点。
 * server action（./actions）、登录之后、左边那块 AuthSide、next/link 换成桩——
 * 桩的返回值由 window.__桩 控制，调用次数记在 window.__调用。时间用 page.clock 快进。
 *
 * 绿的是「查过、修法成立」，红的是确认的问题，保持红。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
const 包: Record<string, string> = {};

/** 把几个跟服务端 / Next 路由绑着的模块换成桩 */
const 桩插件: Plugin = {
  name: "r7-stubs",
  setup(b) {
    const 桩 = (filter: RegExp, contents: string) => {
      b.onResolve({ filter }, (a) => ({ path: a.path + "#" + a.importer, namespace: "stub", pluginData: contents }));
    };
    桩(/^\.\/actions$/, `
      const 叫 = (名, ...参) => { (window.__调用[名] ||= []).push(参); const f = window.__桩[名]; return f ? f(...参) : new Promise(() => {}); };
      export const 桌面端登录 = (...a) => 叫("登录", ...a);
      export const 桌面端下一步 = (...a) => 叫("下一步", ...a);
      export const 桌面端注册 = (...a) => 叫("注册", ...a);
      export const 发送重置码 = (...a) => 叫("发码", ...a);
      export const 重置密码 = (...a) => 叫("重置", ...a);
      // 10-03 起输码填满先核对：没给桩就当对，流程照旧往下走（和云端没有这个接口时一样）
      export const 桌面端核对码 = (...a) => (window.__桩.核对 ? 叫("核对", ...a) : Promise.resolve({ 对: true }));
      export const 核对重置码 = (...a) => (window.__桩.核对 ? 叫("核对", ...a) : Promise.resolve({ 对: true }));
    `);
    桩(/^\.\/after-login$/, `export async function 登录之后(res) { window.__进去了 = res; }`);
    桩(/AuthSide$/, `export default function AuthSide() { return null; }`);
    桩(/^next\/link$/, `
      import React from "react";
      export default function Link({ href, children, ...p }) { return React.createElement("a", { href, ...p }, children); }
    `);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData as string, loader: "jsx", resolveDir: process.cwd() }));
  },
};

async function 打包(组件: string, props: string) {
  const r = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import C from "${组件}";
        window.__调用 = {};
        window.__桩 = window.__桩 || {};
        createRoot(document.getElementById("root")).render(React.createElement(C, ${props}));
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
  return r.outputFiles[0].text;
}

beforeAll(async () => {
  包.登录 = await 打包("@/app/login/DesktopAuth", `{ 可找回密码: true, 可注册: true, 应用内注册: true, 注册地址: "https://x/signup" }`);
  包.找回 = await 打包("@/app/forgot/DesktopForgot", `{ 可用: true }`);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

/** 打开页面；桩用一段脚本在组件挂上之前装好 */
async function 开(哪个: "登录" | "找回", 桩: string): Promise<Page> {
  const page = await browser.newPage();
  // 减弱动态：motion 的过场时长归零。不然 opacity 走 WAAPI、不受假时钟管，退场动画在假时钟下停在半路
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  // 走一个真网址（about:blank 读不了 localStorage）
  await page.route("http://r7.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><div id="root"></div>` }));
  await page.goto("http://r7.test/");
  await page.addScriptTag({ content: `window.__桩 = ${桩};` });
  await page.addScriptTag({ content: 包[哪个] });
  return page;
}

const 标题 = (page: Page) => page.locator("h1").first().textContent();
/** AnimatePresence 退场 + 进场：快进一点让新的一步挂上 */
const 过场 = async (page: Page) => {
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(30);
    await page.clock.runFor(200);
  }
  await page.waitForTimeout(30);
};

/**
 * 退回输码后格子有没有红过。只红 900ms，过场又要几百 ms，两页的过场长短不一样——
 * 一口气快进完再看，找回密码那页已经收回去了（主会话 10-03 改 进来先抖 时撞到的假红）。所以每 100ms 看一眼
 */
const 红过 = async (page: Page) => {
  for (let i = 0; i < 14; i++) {
    if ((await page.locator(".otp.otp-err").count()) > 0) return true;
    await page.waitForTimeout(20);
    await page.clock.runFor(100);
  }
  return false;
};

/** 登录门：填邮箱 → 继续 → 输码 → 设密码 → 勾同意 → 注册并进入 */
async function 走到注册(page: Page, 密码 = "Secret12345", 最后过场 = true) {
  await page.fill("#auth-email", "new@example.com");
  await page.click("button[type=submit]");
  await 过场(page);
  await page.waitForSelector("input.otp-real");
  await page.focus("input.otp-real");
  await page.keyboard.insertText("123456");
  await 过场(page);
  await page.waitForSelector("#auth-newpw");
  await page.fill("#auth-newpw", 密码);
  await page.click(".auth-agree input[type=checkbox]");
  await page.click("button[type=submit]");
  if (最后过场) await 过场(page);
}

describe("输码填满先核对（2026-10-03 走查：错码要设完密码才说）", () => {
  it("注册：码不对当场在输码这一步抖、说，不进「设个密码」", async () => {
    const page = await 开("登录", `{
      下一步: async () => ({ ok: true, data: { 去: "验证码" } }),
      核对: async () => ({ 对: false, error: "验证码不对" }),
    }`);
    await page.fill("#auth-email", "new@example.com");
    await page.click("button[type=submit]");
    await 过场(page);
    await page.waitForSelector("input.otp-real");
    await page.focus("input.otp-real");
    await page.keyboard.insertText("000000");
    expect(await 红过(page)).toBe(true);
    expect(await 标题(page)).toBe("看一下邮箱");
    expect(await page.locator("#auth-newpw").count(), "码不对不该进设密码").toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __调用: Record<string, unknown[]> }).__调用.核对?.length)).toBe(1);
    await page.close();
  });

  it("找回密码：同样当场说；码对了才进设新密码", async () => {
    const page = await 开("找回", `{
      发码: async () => ({ ok: true }),
      核对: async (t, c) => (c === "123456" ? { 对: true } : { 对: false, error: "验证码不对" }),
    }`);
    await page.fill("input", "a@example.com");
    await page.click("button[type=submit]");
    await 过场(page);
    await page.waitForSelector("input.otp-real");
    await page.focus("input.otp-real");
    await page.keyboard.insertText("000000");
    expect(await 红过(page)).toBe(true);
    expect(await page.locator("#forgot-newpw").count()).toBe(0);
    await page.focus("input.otp-real");
    await page.keyboard.insertText("123456");
    await 过场(page);
    await page.waitForSelector("#forgot-newpw");
    await page.close();
  });
});

describe("R7-4 注册后登录失败带去输密码（dcb680f 修 C6）", () => {
  it("已开号：带到「输入密码」，刚设的密码还在框里；密码不进 localStorage / sessionStorage / 网址 / cookie", async () => {
    const page = await 开("登录", `{
      下一步: async () => ({ ok: true, data: { 去: "验证码" } }),
      注册: async () => ({ ok: false, error: "账号已经开好了，这一下没登进去（网络）。用刚设的密码再登录一次就行。", 已开号: true }),
    }`);
    await 走到注册(page, "Secret12345");
    expect(await 标题(page)).toBe("输入密码");
    expect(await page.inputValue("#auth-pw")).toBe("Secret12345");
    const 痕迹 = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, u: location.href, c: document.cookie }));
    expect(痕迹).not.toContain("Secret12345");
    await page.close();
  });

  it("等云端回话的时候连点「注册并进入」：只发一次注册", async () => {
    const page = await 开("登录", `{ 下一步: async () => ({ ok: true, data: { 去: "验证码" } }) }`); // 注册不回话
    await 走到注册(page);
    await page.click("button[type=submit]", { force: true }).catch(() => {});
    await page.click("button[type=submit]", { force: true }).catch(() => {});
    expect(await page.evaluate(() => (window as unknown as { __调用: Record<string, unknown[]> }).__调用.注册.length)).toBe(1);
    await page.close();
  });

  // 【下一版】第七轮 C1：0.46.15 不修（A0 B0，C 级排下一版，用户定的放行条件）
  it.skip("【C】客户端超时（或云端那趟超时）之后号其实开好了：再点注册 →「请先获取验证码」被退回输码 → 点「重发」云端说已注册，界面应带去输密码，实际原地不动、也不说话", async () => {
    const page = await 开("登录", `{
      下一步: async () => (window.__第几次 = (window.__第几次 || 0) + 1) === 1 ? { ok: true, data: { 去: "验证码" } } : { ok: true, data: { 去: "密码" } },
      注册: async () => ({ ok: false, error: "请先获取验证码" }),
    }`);
    await 走到注册(page);
    expect(await 标题(page)).toBe("看一下邮箱");
    // 等重发冷却走完
    for (let i = 0; i < 64; i++) {
      await page.clock.runFor(1000);
      await page.waitForTimeout(10);
    }
    await page.getByText("重发验证码").click();
    await 过场(page);
    // 前提：重发真的问了云端，云端说的是「去输密码」（注册过了）
    expect(await page.evaluate(() => (window as unknown as { __调用: Record<string, unknown[]> }).__调用.下一步.length)).toBe(2);
    // 实际：标题还是「看一下邮箱」，错误条也被清了，人对着空格子
    expect(await 标题(page)).toBe("输入密码");
    await page.close();
  }, 60_000);
});

describe("R7-5 验证码格子出错只红一下（dcb680f 修 C4）——修过头：退回输码那一步时一下都不红、不抖了", () => {
  it("【C】登录门：设密码那一步提交后云端说「验证码不对」→ 退回输码，格子应当红一下抖一下（.otp-err），实际没有", async () => {
    const page = await 开("登录", `{
      下一步: async () => ({ ok: true, data: { 去: "验证码" } }),
      注册: async () => ({ ok: false, error: "验证码不对" }),
    }`);
    await 走到注册(page, undefined, false);
    // 退回来那一刻（900ms 之内）格子该是红的
    expect(await 红过(page)).toBe(true);
    expect(await 标题(page)).toBe("看一下邮箱");
    await page.close();
  });

  it("【C】找回密码：同样的路，退回输码时格子不红不抖", async () => {
    const page = await 开("找回", `{
      发码: async () => ({ ok: true }),
      重置: async () => ({ ok: false, error: "验证码不对" }),
    }`);
    await page.fill("input", "a@example.com");
    await page.click("button[type=submit]");
    await 过场(page);
    await page.waitForSelector("input.otp-real");
    await page.focus("input.otp-real");
    await page.keyboard.insertText("123456");
    await 过场(page);
    await page.waitForSelector("#forgot-newpw");
    await page.fill("#forgot-newpw", "Newpass12345");
    await page.click("button[type=submit]");
    expect(await 红过(page)).toBe(true);
    await page.close();
  });
});
