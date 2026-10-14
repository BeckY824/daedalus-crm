import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
beforeAll(async () => {
  bundle = (await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import WhatsNew from '@/components/WhatsNew';
      window.desktopShell={version:async()=>{if(window.__failVersion)throw Error('IPC');return window.__version||'0.46.15'}};
      createRoot(document.getElementById('root')).render(<WhatsNew/>);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    plugins: [{ name: "server-actions", setup(b) {
      b.onLoad({ filter: /whats-new-actions\.ts$/ }, () => ({ loader: "js", contents: `
        export async function 有没有新内容(){return null}export async function 看过了(){}
        export async function 全部更新记录(){return {现在:window.__serverVersion||'0.46.15',段:[{版本:'0.46.15',正文:'这一版的说明',日期:null},{版本:'0.46.14',正文:'上一版的说明',日期:null}]}}` }));
    } }],
  })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120000);
afterAll(() => browser?.close());
async function open(config = {}) {
  const p = await browser.newPage();
  p.setDefaultTimeout(5000);
  await p.route("http://notes.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await p.goto("http://notes.test");
  await p.evaluate(c => Object.assign(window, c), config);
  await p.addScriptTag({ content: bundle });
  await p.locator("button.rail-wn").click();
  await p.locator(".ant-modal-title").filter({ hasText: "现在是" }).waitFor();
  return p;
}
it("一版一段原样显示，「现在是」就是这台桌面的版本号", async () => {
  const p = await open();
  try {
    const text = await p.getByRole("dialog").innerText();
    expect(text).toContain("现在是 0.46.15");
    expect(text).toContain("这一版的说明"); expect(text).toContain("上一版的说明");
    expect(await p.locator(".wn-ver").count()).toBe(2);
  } finally { await p.close(); }
});
it("连着的服务器是别的版本时，「现在是」仍是这台桌面装的版本", async () => {
  const p = await open({ __serverVersion: "0.47.0", __version: "0.46.15" });
  try { expect(await p.locator(".ant-modal-title").innerText()).toContain("现在是 0.46.15"); }
  finally { await p.close(); }
});
it("桌面版本 IPC 暂不可用时退回服务端给的版本", async () => {
  const p = await open({ __failVersion: true, __serverVersion: "0.46.14" });
  try { expect(await p.locator(".ant-modal-title").innerText()).toContain("现在是 0.46.14"); }
  finally { await p.close(); }
});
