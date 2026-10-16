/** 设置 → 团队 → 被同事盖掉的改动（2026-10-16）：列出我原来写的和现在的、「知道了」后不再提示。服务端动作换成内存假实现。 */
import { afterAll, beforeAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "stub-actions", setup(b) {
  b.onResolve({ filter: /\/team-actions$/ }, (a) => ({ path: a.path, namespace: "fixture" }));
  b.onResolve({ filter: /^next\/link$/ }, (a) => ({ path: a.path, namespace: "fixture-link" }));
  b.onLoad({ filter: /.*/, namespace: "fixture-link" }, () => ({ loader: "js", resolveDir: process.cwd(), contents: "import {createElement} from 'react';export default function L({href,children}){return createElement('a',{href},children)}" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
    const rows=()=>window.__rows.filter(r=>!r.看过);
    export const 读被盖掉=async()=>rows();
    export const 看过被盖掉动作=async(ids)=>{let n=0;for(const r of window.__rows)if(ids.includes(r.id)&&!r.看过){r.看过=1;n++}return{ok:true,看过:n}};` }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{App}from'antd';import C from'@/app/(app)/settings/OverwrittenCard';
    const t=new Date().toISOString();
    window.__rows=[{id:1,表:'客户',名称:'李的老客户',列:'备注',我写的:'赵先改的备注',现在:'老板后改的备注',我改的时间:t,同事改的时间:t,href:'/customers/c1'},{id:2,表:'跟进计划',名称:'李的老客户 · 下周回访',列:'计划时间',我写的:null,现在:'1760000000000',我改的时间:t,同事改的时间:t,href:'/customers/c1'}];
    createRoot(document.getElementById('root')).render(<App><div style={{width:640,padding:16}}><C/></div></App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120000);
afterAll(async () => { await browser?.close(); });
it("列出被盖掉的格子（我写的 / 现在的、点得进客户页），知道了一条少一条，都知道了就不显示", async () => {
  const page = await browser.newPage();
  await page.route("http://overwritten.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://overwritten.test");
  await page.addScriptTag({ content: bundle });
  await page.getByText("有 2 处你改的，被同事后来的改动盖掉了").waitFor();
  expect(await page.getByText("「赵先改的备注」").count()).toBe(1);
  expect(await page.getByText("「老板后改的备注」").count()).toBe(1);
  expect(await page.getByText("（空）").count()).toBe(1);
  expect(await page.getByRole("link", { name: "李的老客户", exact: true }).getAttribute("href")).toBe("/customers/c1");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.getByRole("button", { name: "知道了" }).first().click();
  await page.getByText("有 1 处你改的，被同事后来的改动盖掉了").waitFor();
  expect(await page.getByRole("button", { name: "都知道了" }).count()).toBe(0);
  await page.getByRole("button", { name: "知道了" }).click();
  await expect.poll(() => page.getByTestId("overwritten").count()).toBe(0);
  await page.close();
});
