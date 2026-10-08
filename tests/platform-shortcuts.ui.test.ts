import { beforeAll, afterAll, it, expect } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "navigation", setup(b) {
  b.onResolve({filter:/^next\/navigation$/}, a => ({path:a.path,namespace:"stub"}));
  b.onLoad({filter:/.*/,namespace:"stub"}, () => ({contents:"export const useRouter=()=>({push:p=>window.__route=p});"}));
} };
beforeAll(async () => {
  const r = await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
    import C from '@/components/CommandBar';import S from '@/components/Shortcut';
    createRoot(document.getElementById('root')).render(<><div className="page-head-a"><button className="ant-btn-primary" onClick={()=>window.__new++}>新建</button></div><kbd id="key"><S>⌘↵</S></kbd><C 有AI={true}/></>);`,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"});
  bundle=r.outputFiles[0].text;browser=await chromium.launch();
},120_000);
afterAll(async()=>{await browser?.close()});
it.each([["Win32","Control","Ctrl+"],["MacIntel","Meta","⌘"]])("%s 对应快捷键可操作，标签与键一致",async(platform,key,label)=>{
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.addInitScript(platform=>Object.defineProperty(navigator,"platform",{get:()=>platform}),platform);
  await page.route("http://keys.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));
  await page.goto("http://keys.test");await page.evaluate(()=>Object.assign(window,{__new:0,__route:""}));
  await page.addScriptTag({content:bundle});
  await expect.poll(()=>page.locator("#key").innerText()).toBe(label+"↵");
  await page.keyboard.press(key+"+n");
  expect(await page.evaluate(()=>Reflect.get(window,"__new"))).toBe(1);
  await page.keyboard.press(key+"+k");
  const dialog=page.getByRole("dialog");await dialog.waitFor();
  expect(await dialog.innerText()).toContain(label+"K");
  if(platform==="Win32") expect(await dialog.innerText()).not.toContain("⌘");
  const input=dialog.locator("input");await input.fill("跟进计划");
  await input.press(key+"+n");
  expect(await page.evaluate(()=>Reflect.get(window,"__new"))).toBe(1);
  await input.press("Enter");
  await expect.poll(()=>page.evaluate(()=>Reflect.get(window,"__route"))).toBe("/follow-ups/plans");
  await page.close();
});
