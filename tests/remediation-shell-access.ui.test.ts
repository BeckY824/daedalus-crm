import { beforeAll, afterAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "shell-boundaries", setup(b) {
  b.onResolve({ filter: /^next\/(navigation|link)$/ }, a => ({ path: a.path, namespace: "fixture" }));
  b.onResolve({ filter: /(^|\/)(UpdateRow|WhatsNew|AiTasks|AiDock|FeedbackButton|AiCost|RailResizer)$/ }, a => ({ path: a.path, namespace: "empty-child" }));
  b.onLoad({ filter: /.*/, namespace: "empty-child" }, () => ({ contents: "export default function Empty(){return null} export function AiMeterBar(){return null}" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ resolveDir: process.cwd(), contents: a.path === "next/link"
    ? `import React from 'react';export default function Link({href,onClick,prefetch,children,...p}){return React.createElement('a',{...p,href,onClick:e=>{onClick?.(e);if(!e.defaultPrevented){e.preventDefault();window.__route=href}}},children)}`
    : `export const useRouter=()=>({push:p=>window.__route=p,refresh:()=>window.__refresh++});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);` }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import Shell from '@/components/AppShell';import Audit from '@/app/(app)/settings/AuditTab';import AuthSide from '@/app/login/AuthSide';
    const root=createRoot(document.getElementById('root'));window.__route='';window.__refresh=0;
    const logs=['Opportunity','Contact','FollowUp','Task','FollowPlan','TradeOrder','Supplier','Customer'].map((entity,i)=>({id:String(i),at:'2026-10-08T08:00:00Z',userName:'QA',action:i===7?'import':'create',entity,summary:'记录'+i,detail:null}));
    window.__render=(ai=false)=>root.render(location.pathname==='/auth'?<AuthSide 门="托管版"/>:<Shell user={{id:'qa',name:'QA',email:'qa@example.test',role:'ADMIN',title:'管理员'}} workspace={{name:'QA工作区',multiple:!location.search.includes('single'),billing:!location.search.includes('no-billing')}} desktop={location.search.includes('desktop')} 反馈去向="github" pane={null} ai={ai?{models:[]}:null} 要跟={{逾期:1,今天:2}}><Audit logs={logs}/></Shell>);
    window.__render();`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
async function open(url = "/billing", width = 1200): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 850 } }); page.setDefaultTimeout(5000);
  await page.route("http://shell.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://shell.test" + url); await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "QA，账号菜单" }).waitFor(); return page;
}
it("H-100 手机账号菜单可退出并POST注销、刷新会话，工作区和设置入口可操作", async () => {
  const page = await open("/billing", 390); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.getByRole("button", { name: "QA，账号菜单" }).click();
  expect(await page.getByRole("menu").innerText()).toContain("当前工作区：QA工作区");
  await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-手机账号菜单.png"), animations: "disabled" });
  expect(await page.locator(".ant-table-content").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole("menuitem", { name: "切换工作区" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__route"))).toBe("/workspaces");
  await page.getByRole("button", { name: "QA，账号菜单" }).click();
  await page.getByRole("menuitem", { name: /设置$/ }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__route"))).toBe("/settings");
  let method = ""; await page.route("**/api/auth/logout", r => { method = r.request().method(); return r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
  await page.getByRole("button", { name: "QA，账号菜单" }).click(); await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__route"))).toBe("/login");
  expect(method).toBe("POST"); expect(await page.evaluate(() => Reflect.get(window, "__refresh"))).toBe(1); expect(errors).toEqual([]); await page.close();
});
it("手机单工作区不摆无意义切换；开通订阅菜单高亮正确，设置名称一致", async () => {
  const page = await open("/billing?single", 390);
  await page.getByRole("button", { name: "QA，账号菜单" }).click(); expect(await page.getByRole("menuitem", { name: "切换工作区" }).count()).toBe(0);
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "打开导航菜单" }).click();
  const nav = page.getByRole("menu").filter({ hasText: "开通订阅" });
  expect(await nav.getByRole("menuitem", { name: "开通订阅" }).getAttribute("class")).toContain("selected");
  expect(await nav.getByRole("menuitem", { name: /设置$/ }).count()).toBe(1);
  await page.getByRole("menuitem", { name: "开通订阅" }).click(); expect(await page.evaluate(() => Reflect.get(window, "__route"))).toBe("/billing"); await page.close();
});
it("H-098/J-210 桌面宽度订阅入口被选中，首页不误亮；无权限不显示入口", async () => {
  const page = await open(); const bill = page.getByRole("link", { name: "开通订阅", exact: true });
  expect(await bill.getAttribute("class")).toContain(" on"); expect(await page.getByRole("link", { name: "首页", exact: true }).getAttribute("class")).not.toContain(" on");
  await bill.click(); expect(await page.evaluate(() => Reflect.get(window, "__route"))).toBe("/billing"); await page.close();
  const hidden = await open("/dashboard?no-billing"); expect(await hidden.getByRole("link", { name: "开通订阅", exact: true }).count()).toBe(0); await hidden.close();
});
it("J-209 没接AI回车保留问题不跳页；接入后同一句可交给首页", async () => {
  const page = await open("/customers"); await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog"); const input = dialog.locator("input"); const question = "哪个同事有最多的逾期任务？";
  await input.fill(question); await input.press("Enter");
  expect(await input.inputValue()).toBe(question); expect(await dialog.isVisible()).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "__route"))).toBe(""); expect(await dialog.innerText()).toContain("问题保留在输入框中");
  expect(await dialog.innerText()).not.toContain("首页和数据页");
  await page.evaluate(() => Reflect.get(window, "__render")(true));
  await page.getByRole("button", { name: /问一句/ }).waitFor(); await input.press("Enter");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__route"))).toBe("/dashboard?q=" + encodeURIComponent(question)); await page.close();
});
it("J-181 操作日志真实表格显示全部业务对象中文，导入不再显示import", async () => {
  const page = await open(); const table = page.getByRole("table"); const text = await table.innerText();
  for (const name of ["商机", "联系人", "跟进记录", "待办", "跟进计划", "订单", "供应商", "客户", "导入"]) expect(text).toContain(name);
  expect(text).not.toMatch(/Opportunity|Contact|FollowUp|FollowPlan|TradeOrder|Supplier|import/); expect(await page.locator("body").innerText()).not.toContain("所有人都能查看和修改全部"); await page.close();
});
it.each([false, true])("H-097 跟进角标说明符合desktop=%s", async desktop => {
  const page = await open("/follow-ups" + (desktop ? "?desktop" : ""));
  const title = await page.getByRole("link", { name: "跟进，要跟 3 条（逾期 1）" }).locator(".rail-count").getAttribute("title");
  expect(title).toContain(desktop ? "应用图标提示" : "跟进计划"); if (!desktop) expect(title).not.toContain("图标"); await page.close();
});
it("H-095 托管登录说明按云端和权限说明，不把所有工作区说成共享试用", async () => {
  const page = await browser.newPage(); await page.route("http://shell.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://shell.test/auth"); await page.addScriptTag({ content: bundle }); await page.locator(".auth-fine").waitFor();
  const text = await page.locator(".auth-fine").innerText(); expect(text).toContain("云服务器"); expect(text).toContain("按账号权限"); expect(text).not.toContain("团队共用的试用工作区"); await page.close();
});
