/** 设置 → 团队 → 失权冲突：列出、导出、标记已处理（不删除）。服务端动作换成内存假实现。 */
import { afterAll, beforeAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser, bundle: string;
const plugin: Plugin = { name: "stub-actions", setup(b) {
  b.onResolve({ filter: /\/team-actions$/ }, (a) => ({ path: a.path, namespace: "fixture" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
    const rows=()=>window.__rows.filter(r=>!r.已确认);
    export const 读范围冲突=async()=>rows();
    export const 导出范围冲突动作=async()=>{window.__exported=(window.__exported||0)+1;return JSON.stringify({条目:window.__rows})};
    export const 确认范围冲突动作=async(ids)=>{let n=0;for(const r of window.__rows)if(ids.includes(r.id)&&!r.已确认){r.已确认='x';n++}return{ok:true,确认:n}};` }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{App}from'antd';import C from'@/app/(app)/settings/ScopeConflicts';
    window.__rows=[{id:1,表:'客户',编号:'lost2',名称:'lost2',操作:'修改',改动列:['remark'],改动时间:new Date().toISOString(),原因:'r',已确认:null},{id:2,表:'联系人',编号:'c9',名称:'张经理',操作:'新建',改动列:['（整条新建）'],改动时间:new Date().toISOString(),原因:'r',已确认:null}];
    URL.createObjectURL=()=>'blob:x';URL.revokeObjectURL=()=>{};
    createRoot(document.getElementById('root')).render(<App><C/></App>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120000);
afterAll(async () => { await browser?.close(); });
it("列出冲突、导出文件、标记所选为已处理后从列表消失但记录仍在", async () => {
  const page = await browser.newPage();
  await page.route("http://conflict.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://conflict.test");
  await page.addScriptTag({ content: bundle });
  await page.getByText("有 2 条改动因同步权限变化没能上传").waitFor();
  expect(await page.getByText("张经理").count()).toBe(1);
  expect(await page.getByText("remark").count()).toBe(1);
  await page.getByRole("button", { name: /导出文件/ }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__exported"))).toBe(1);
  await page.locator("tbody .ant-checkbox-input").first().check();
  await page.getByRole("button", { name: "标记所选为已处理" }).click();
  await page.getByText("有 1 条改动因同步权限变化没能上传").waitFor();
  expect(await page.evaluate(() => (Reflect.get(window, "__rows") as unknown[]).length)).toBe(2);
  await page.close();
});
