/**
 * 企业版「都已满额」提醒的关闭按钮（7.6 / A8）：读屏能读出按钮叫什么，点了这条消失、只关这一条
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "lead-full-notices-ui", setup(b) {
  b.onResolve({ filter: /^\.\/assign-actions$/ }, a => ({ path: a.path, namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const 关满额提醒=async(id)=>{window.__关.push(id);return {ok:true}};", loader: "js" }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import Notices from '@/app/(app)/leads/LeadFullNotices';
    window.__关=[];
    const at=new Date().toISOString();
    createRoot(document.getElementById('root')).render(<Notices 提醒={[
      {id:'n1',at,条数:2,线索:['甲线索','乙线索'],谁点的:'市场'},
      {id:'n2',at,条数:1,线索:['丙线索'],谁点的:'老板'},
    ]}/>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

it("关闭按钮有名字「关闭这条满额提醒」，点第一条只关第一条、记一次", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://notices.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://notices.test"); await page.addScriptTag({ content: bundle });
  const 关闭 = page.getByRole("button", { name: "关闭这条满额提醒" });
  await expect.poll(() => 关闭.count()).toBe(2);
  await 关闭.first().click();
  await expect.poll(() => page.getByRole("alert").count()).toBe(1);
  expect(await page.getByRole("alert").innerText()).toContain("丙线索");
  expect(await page.evaluate(() => (window as unknown as { __关: string[] }).__关)).toEqual(["n1"]);
  expect(errors).toEqual([]); await page.close();
});
