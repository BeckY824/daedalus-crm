/**
 * 第六轮对抗复查：OtpInput（桌面端注册 / 找回密码的 6 格验证码）在真 Chromium 里的粘贴。
 *
 * 桌面端是 Electron = Chromium，所以这里把真组件用 esbuild 打包，塞进 Playwright 的 Chromium 里点。
 * 浏览器的 maxLength 会在 onChange 之前就把粘贴进来的文字截到 6 个字符——
 * 组件里那句 replace(/\D/g, "") 根本看不到后面的数字。
 *
 * 红的保持红。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let bundle = "";

beforeAll(async () => {
  const r = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import OtpInput from "@/components/OtpInput";
        window.__done = [];
        createRoot(document.getElementById("root")).render(
          React.createElement(OtpInput, { onDone: (c) => window.__done.push(c) })
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
    logLevel: "silent",
  });
  bundle = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function 开(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("input.otp-real");
  await page.focus("input.otp-real");
  return page;
}

/** 模拟 ⌘V：Chromium 里 insertText 走的就是粘贴那条路（受 maxLength 限制） */
async function 粘贴(page: Page, text: string) {
  await page.keyboard.insertText(text);
  return page.evaluate(() => (window as unknown as { __done: string[] }).__done);
}

describe("R6-5 OtpInput 粘贴带空格 / 带字的验证码", () => {
  it("对照：纯 6 位数字粘贴进去能填满", async () => {
    const page = await 开();
    expect(await 粘贴(page, "123456")).toEqual(["123456"]);
    await page.close();
  });

  it("从邮件里复制时带了前导空格「 123456」：应该填满，实际只进 5 位", async () => {
    const page = await 开();
    expect(await 粘贴(page, " 123456")).toEqual(["123456"]);
    await page.close();
  });

  it("分组写法「123 456」：应该填满，实际只进 5 位", async () => {
    const page = await 开();
    expect(await 粘贴(page, "123 456")).toEqual(["123456"]);
    await page.close();
  });

  it("连字带码一起复制「验证码：123456」：应该认出 6 位，实际一位都没进", async () => {
    const page = await 开();
    expect(await 粘贴(page, "验证码：123456")).toEqual(["123456"]);
    await page.close();
  });
});
