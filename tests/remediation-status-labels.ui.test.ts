import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "business-form-boundaries", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "qa" }));
  b.onResolve({ filter: /\/EmptyState$/ }, () => ({ path: "demo", namespace: "qa" }));
  b.onResolve({ filter: /^\.\/actions$/ }, a => a.importer.endsWith("BusinessSettingsTab.tsx") ? ({ path: "save", namespace: "qa" }) : undefined);
  b.onLoad({ filter: /.*/, namespace: "qa" }, a => ({ resolveDir: process.cwd(), contents: a.path === "router"
    ? "export const useRouter=()=>({refresh:()=>window.__refresh++})"
    : a.path === "demo" ? "export function DemoDataSection(){return null}"
    : "export async function saveBusinessSettings(v){window.__calls.push(v);if(window.__fail)throw Error('offline');return {ok:true}}" }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
    import Form from '@/app/(app)/settings/BusinessSettingsTab';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    window.__calls=[];window.__refresh=0;window.__fail=false;
    const value=location.search.includes('legacy')?{...DEFAULT_BUSINESS,statusLabels:{待跟进:'相同名称',跟进中:'相同名称'}}:DEFAULT_BUSINESS;
    createRoot(document.getElementById('root')).render(<App><Form value={value}/></App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
async function open(legacy = false) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://labels.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://labels.test/" + (legacy ? "?legacy" : "")); await page.addScriptTag({ content: bundle });
  await page.getByLabel("待跟进", { exact: true }).waitFor(); return page;
}
it("L-061 浏览器冲突红字保留输入，修正后仅提交一次并刷新", async () => {
  const page = await open(); await page.getByLabel("待跟进", { exact: true }).fill("跟进中");
  await page.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect.poll(() => page.locator(".ant-form-item-explain-error").allTextContents()).toContain("「待跟进」不能叫「跟进中」：这个名称属于其他状态");
  expect(await page.evaluate(() => Reflect.get(window, "__calls").length)).toBe(0);
  expect(await page.getByLabel("待跟进", { exact: true }).inputValue()).toBe("跟进中");
  await page.getByLabel("待跟进", { exact: true }).fill("等待联络"); await page.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__refresh"))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "__calls").length)).toBe(1); await page.close();
});
it("L-061 旧歧义配置有明确核对提示；网络失败恢复按钮且保留修改", async () => {
  const page = await open(true); expect(await page.getByRole("alert").innerText()).toContain("已有状态显示名冲突");
  await page.getByLabel("待跟进", { exact: true }).fill("等待联络"); await page.getByLabel("跟进中", { exact: true }).fill("正在联络");
  await page.evaluate(() => Reflect.set(window, "__fail", true)); await page.getByRole("button", { name: /^保\s*存$/ }).click();
  await page.getByText("保存失败，请刷新核对后重试；当前填写内容仍保留", { exact: true }).waitFor();
  await expect.poll(() => page.getByRole("button", { name: /保\s*存/ }).getAttribute("class")).not.toContain("ant-btn-loading");
  expect(await page.getByRole("button", { name: /保\s*存/ }).isEnabled()).toBe(true);
  expect(await page.getByLabel("待跟进", { exact: true }).inputValue()).toBe("等待联络");
  expect(await page.evaluate(() => Reflect.get(window, "__refresh"))).toBe(0); await page.close();
});
