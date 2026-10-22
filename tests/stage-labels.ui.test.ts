import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "stage-labels-form", setup(b) {
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
    const value=DEFAULT_BUSINESS;
    createRoot(document.getElementById('root')).render(<App><Form value={value}/></App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
async function open() {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://stages.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://stages.test/"); await page.addScriptTag({ content: bundle });
  await page.getByLabel("第 1 步 · 初步沟通", { exact: true }).waitFor(); return page;
}
const 第 = (n: number, v: string) => `第 ${n} 步 · ${v}`;
it("阶段名冲突红字、不提交；改好后提交一次，存的是改后的叫法", async () => {
  const page = await open();
  await page.getByLabel(第(1, "初步沟通"), { exact: true }).fill("需求确认");
  await page.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect.poll(() => page.locator(".ant-form-item-explain-error").allTextContents()).toContain("「初步沟通」不能叫「需求确认」：这个名称属于「需求确认」那一步");
  expect(await page.evaluate(() => Reflect.get(window, "__calls").length)).toBe(0);
  await page.getByLabel(第(1, "初步沟通"), { exact: true }).fill("线索");
  await page.getByLabel(第(5, "赢单成交"), { exact: true }).fill("中标");
  await page.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__refresh"))).toBe(1);
  const calls = (await page.evaluate(() => Reflect.get(window, "__calls"))) as { stageLabels?: Record<string, string> }[];
  expect(calls).toHaveLength(1);
  expect(calls[0].stageLabels).toMatchObject({ 初步沟通: "线索", 赢单成交: "中标" });
  await page.close();
});
it("换外贸模版填好询盘那套，换回通用清空", async () => {
  const page = await open();
  await page.getByText("外贸", { exact: true }).click();
  expect(await page.getByLabel(第(1, "初步沟通"), { exact: true }).inputValue()).toBe("询盘");
  expect(await page.getByLabel(第(4, "谈判审核"), { exact: true }).inputValue()).toBe("寄样");
  await page.getByText("通用", { exact: true }).click();
  expect(await page.getByLabel(第(1, "初步沟通"), { exact: true }).inputValue()).toBe("");
  await page.close();
});
