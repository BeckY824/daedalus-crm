import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { expect as uiExpect } from "@playwright/test";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "customer-search-boundary", setup(b) {
  b.onResolve({ filter: /^@\/app\/\(app\)\/customers\/\[id\]\/pick$/ }, a => ({ path: a.path, namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
    export async function 搜客户(word){window.__queries.push(word);if(word==='目标')return new Promise(resolve=>window.__resolveTarget=()=>resolve([{id:'target',name:'目标客户',附注:'13800000002'}]));if(word==='慢')return new Promise(resolve=>window.__resolve=()=>resolve([{id:'stale',name:'旧搜索不该回来',附注:null}]));
      if(word==='断'&&!window.__retried){window.__retried=true;throw Error('network')};return word?[{id:'fast',name:word==='断'?'重试成功':'新搜索结果',附注:'不同公司'}]:[{id:'recent',name:'最近客户',附注:null}]}
    export const 取客户选项=async id=>({id,name:'原选客户',附注:'原公司'});
  ` }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Select from '@/components/CustomerSearchSelect';
    const root=createRoot(document.getElementById('root'));window.__queries=[];
    function Test(){const [value,setValue]=useState(window.__empty?undefined:'chosen');return <><Select aria-label="远程客户" value={value} onChange={setValue} initialOptions={window.__empty?[]:[{id:'chosen',name:'原选客户'}]} style={{width:360}}/><output>{value||'未选择'}</output></>}
    window.__mount=(show=true)=>root.render(show?<Test/>:null);window.__mount();
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
async function open(empty = false) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://search.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://search.test"); await page.evaluate(v => Reflect.set(window, "__empty", v), empty); await page.addScriptTag({ content: bundle }); return page;
}
it("快速回车和搜索等待都不能误选旧客户，结果到达后才允许选择目标ID", async () => {
  const page = await open(true);
  try {
    const input = page.getByRole("combobox", { name: "远程客户" });
    await input.click(); await page.getByTitle("最近客户", { exact: true }).waitFor();
    await input.fill("目标"); await input.press("Enter");
    expect(await page.locator("output").textContent()).toBe("未选择");
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "__queries"))).toContain("目标");
    await uiExpect(page.getByTitle("最近客户", { exact: true })).toHaveClass(/ant-select-item-option-disabled/);
    await input.press("Enter"); expect(await page.locator("output").textContent()).toBe("未选择");
    await page.evaluate(() => Reflect.get(window, "__resolveTarget")());
    await uiExpect(page.getByTitle("目标客户 · 13800000002", { exact: true })).not.toHaveClass(/ant-select-item-option-disabled/);
    await input.press("ArrowDown"); await input.press("Enter"); await uiExpect(page.locator("output")).toHaveText("target");
  } finally { await page.close(); }
});
it("只在展开后搜索，慢请求不覆盖快结果，搜索其他客户仍保留已选姓名", async () => {
  const page = await open();
  try {
    expect(await page.evaluate(() => Reflect.get(window, "__queries"))).toEqual([]);
    const input = page.getByRole("combobox", { name: "远程客户" }); await input.click(); await page.getByTitle("最近客户", { exact: true }).waitFor();
    await input.fill("慢"); await expect.poll(() => page.evaluate(() => Reflect.get(window, "__queries"))).toContain("慢");
    await input.fill("快"); await page.getByTitle("新搜索结果 · 不同公司", { exact: true }).waitFor();
    await page.evaluate(() => Reflect.get(window, "__resolve")());
    expect(await page.getByTitle("旧搜索不该回来", { exact: true }).count()).toBe(0);
    await input.press("Escape");
    await page.locator("#root").getByTitle("原选客户", { exact: true }).waitFor();
    await input.click(); await input.fill("快");
    await page.getByTitle("新搜索结果 · 不同公司", { exact: true }).waitFor();
    await page.getByTitle("新搜索结果 · 不同公司", { exact: true }).click();
    await page.locator("#root").getByTitle("新搜索结果 · 不同公司", { exact: true }).waitFor();
  } finally { await page.close(); }
});
it("网络失败可原词重试，关表单后的慢响应不产生页面错误", async () => {
  const page = await open(); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    const input = page.getByRole("combobox", { name: "远程客户" }); await input.click(); await input.fill("断");
    await page.getByRole("alert").filter({ hasText: "客户加载失败" }).waitFor(); await page.getByRole("button", { name: /重\s*试/ }).click();
    await page.getByTitle("重试成功 · 不同公司", { exact: true }).waitFor();
    await input.fill("慢"); await expect.poll(() => page.evaluate(() => Reflect.get(window, "__queries"))).toContain("慢");
    await page.evaluate(() => Reflect.get(window, "__mount")(false)); await page.evaluate(() => Reflect.get(window, "__resolve")());
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
