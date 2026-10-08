import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const r = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Picker from '@/app/workspaces/WorkspacePicker'; createRoot(document.getElementById('root')).render(<Picker current="one" list={[{id:'one',name:'甲空间',role:'OWNER',writable:true},{id:'two',name:'乙空间',role:'MEMBER',writable:false}]} />);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "actions", setup(b) {
    b.onResolve({ filter: /^\.\/actions$/ }, () => ({ path: "actions", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const 切换工作区 = id => { window.__calls.push(id); return window.__switch(id); };" }));
  } }], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
async function open(stub: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://workspace.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://workspace.test/workspaces");
  await page.addScriptTag({ content: `window.__calls=[]; window.__switch=${stub}; window.__oldAiThread='旧库对话';` });
  await page.addScriptTag({ content: bundle });
  return page;
}
it("显示当前空间与只读状态，失败保留选择并允许重试", async () => {
  const page = await open(`async () => ({ok:false,error:'无法进入这个工作区'})`);
  expect(await page.getByRole("button", { name: /甲空间/ }).textContent()).toContain("当前");
  expect(await page.getByRole("button", { name: /乙空间/ }).textContent()).toContain("只读");
  await page.getByRole("button", { name: /乙空间/ }).click();
  expect(await page.getByRole("alert").textContent()).toContain("无法进入");
  expect(await page.getByRole("button", { name: /乙空间/ }).isEnabled()).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/workspaces"); await page.close();
});
it("成功整页跳转，旧AI内存销毁；等待期间双击不重复提交", async () => {
  const page = await open(`() => new Promise(resolve => window.__finish=resolve)`);
  await page.getByRole("button", { name: /乙空间/ }).click();
  expect(await page.getByRole("button", { name: /甲空间/ }).isDisabled()).toBe(true);
  await page.getByRole("button", { name: /乙空间/ }).click({ force: true });
  expect(await page.evaluate(() => (window as any).__calls)).toEqual(["two"]);
  await page.evaluate(() => (window as any).__finish({ok:true}));
  await page.waitForURL("http://workspace.test/start");
  expect(await page.evaluate(() => (window as any).__oldAiThread)).toBeUndefined(); await page.close();
});
it("网络异常显示中文并恢复按钮", async () => {
  const page = await open(`async () => {throw new Error('Failed to fetch')}`);
  await page.getByRole("button", { name: /乙空间/ }).click();
  expect(await page.getByRole("alert").textContent()).toContain("检查网络");
  expect(await page.getByRole("button", { name: /乙空间/ }).isEnabled()).toBe(true); await page.close();
});
it("切换服务无响应20秒后恢复，不会一直转圈", async () => {
  const page = await open(`() => new Promise(() => {})`);
  await page.clock.install();
  await page.getByRole("button", { name: /乙空间/ }).click();
  await page.clock.runFor(20_001);
  expect(await page.getByRole("alert").textContent()).toContain("检查网络");
  expect(await page.getByRole("button", { name: /乙空间/ }).isEnabled()).toBe(true); await page.close();
});
