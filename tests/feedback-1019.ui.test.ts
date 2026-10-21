/**
 * 客户使用反馈（2026-10-19）第 4、5 条，在真浏览器里钉住新建 / 编辑客户那个弹窗：
 *
 *   4. 点框外面不关；Esc / X 关时填过东西先问「放弃填的内容？」；新建没保存就关的，下次打开接着填（只在本机），保存成功就清掉
 *   5. 外贸：电话 / WhatsApp / 邮箱 / 微信至少填一个，四格旁边同一个记号；只知道微信号也能建
 *
 * 真组件（CustomerForm + lib/form-guard），服务端动作换成假的、记下交了什么。
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let bundle: string;

const plugin: Plugin = { name: "feedback-1019-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>'/customers';");
  stub(/^\.\/actions$/, `
    const 记=(名,参)=>{(window.__calls??=[]).push({名,参});return {ok:true,id:'c1'}};
    export const saveCustomer=async(x)=>记('saveCustomer',x),checkDuplicate=async()=>null;`);
  stub(/^\.\.\/channels\/actions$/, "export const saveChannel=async()=>({ok:true,id:'ch1'});");
  b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };

beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {BUSINESS_PRESETS} from '@/lib/business-config';
    import CustomerForm from '@/app/(app)/customers/CustomerForm';
    const 老客户={id:'c0',name:'Old Li',phone:'',school:null,grade:null,major:null,followStatus:'待跟进',decisionStatus:'了解中',expectedSignAt:null,lastFollowAt:null,remark:null,
      referrerCustomerId:null,channelId:null,referrerName:null,attributionName:null,channelOwnerId:null,channelOwnerName:null,salesOwnerId:'u1',salesOwnerName:'我',signedAmount:0,
      extra:{country:null,whatsapp:null,wechat:'old_li_wx',email:null,source:null,level:null,website:null},updatedAt:'2026-10-19T01:00:00Z'};
    function Test(){
      const [开,set开]=useState(null);
      return <>
        <button onClick={()=>set开('new')}>开新建</button>
        <button onClick={()=>set开('edit')}>开编辑</button>
        <span id="state">{开??'关着'}</span>
        <CustomerForm open={开!==null} editing={开==='edit'?老客户:null} users={[{id:'u1',name:'我'}]} channels={[]} customers={[]} onClose={(存了)=>{window.__closed=(window.__closed??[]).concat([存了]);set开(null)}}/>
      </>;
    }
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={BUSINESS_PRESETS['外贸出口']} timeZone={'Asia/Shanghai'}><Test/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

type 调用 = { 名: string; 参: Record<string, unknown> };
async function 开(): Promise<{ page: Page; errors: string[]; 调用们: () => Promise<调用[]> }> {
  // UA 写死成 Mac 桌面端：这张表单不分系统，但写死了 Windows CI 上也走同一条路（PR #29 那次的教训）
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Electron/38.0.0" });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://fb.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://fb.test");
  await page.addScriptTag({ content: bundle });
  return { page, errors, 调用们: () => page.evaluate(() => (window as unknown as { __calls?: 调用[] }).__calls ?? []) };
}

const 状态 = (page: Page) => page.locator("#state").innerText();
// 两个字的按钮 antd 中间会塞空格（「保 存」），按钮名用正则
const 问框 = (page: Page) => page.locator(".ant-modal-confirm-title", { hasText: "放弃填的内容？" });
const 框 = (page: Page) => page.getByRole("dialog", { name: "新建客户" });
async function 点遮罩(page: Page) {
  // 弹窗外面（左上角）点一下：落在 .ant-modal-wrap 上，就是 antd 的「点遮罩」
  await page.mouse.click(8, 8);
  await page.waitForTimeout(400);
}

it("点框外面不关；没填东西按 Esc 直接关，不问", async () => {
  const { page, errors } = await 开();
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await 点遮罩(page);
  expect(await 状态(page)).toBe("new");
  expect(await 框(page).isVisible()).toBe(true);
  // 打开时程序填的默认值（跟进状态、负责人）不算「填过」
  await page.keyboard.press("Escape");
  await expect.poll(() => 状态(page)).toBe("关着");
  expect(await 问框(page).count()).toBe(0);
  expect(errors).toEqual([]);
});

it("填了一半按 Esc：先问；「继续填」留在原地；「留着草稿，先关掉」下次打开接着填；保存成功后草稿清掉", async () => {
  const { page, errors, 调用们 } = await 开();
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await 框(page).getByLabel("客户姓名").fill("Wang Wei");
  await 框(page).getByLabel(/^微信/).fill("wangwei_88");
  await 点遮罩(page);
  expect(await 状态(page)).toBe("new");

  await page.keyboard.press("Escape");
  await 问框(page).waitFor();
  // 刚打开就填（动画还没走完）：不能把自己刚填的当草稿「恢复」一遍
  expect(await page.getByText("接着上次没填完的继续填").count()).toBe(0);
  // 焦点在「继续填」上：顺手按回车不会把填的扔掉
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe("继续填");
  if (process.env.FB_SHOT) await page.waitForTimeout(500), await page.screenshot({ path: `${process.env.FB_SHOT}/confirm.png` });
  await page.getByRole("button", { name: "继续填" }).click();
  await expect.poll(() => 问框(page).count()).toBe(0);
  expect(await 框(page).getByLabel("客户姓名").inputValue()).toBe("Wang Wei");

  // 右上角 X 一样问；这次留着草稿关掉
  await 框(page).getByRole("button", { name: /^(Close|关闭)$/ }).click();
  await page.getByRole("button", { name: "留着草稿，先关掉" }).click();
  await expect.poll(() => 状态(page)).toBe("关着");
  expect((await page.evaluate(() => (window as unknown as { __closed?: boolean[] }).__closed)) ?? []).toEqual([false]);

  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await expect.poll(() => 框(page).getByLabel("客户姓名").inputValue()).toBe("Wang Wei");
  expect(await 框(page).getByLabel(/^微信/).inputValue()).toBe("wangwei_88");
  await page.getByText("接着上次没填完的继续填").waitFor();

  // 只填了微信：能存（四样填一样就行）
  await 框(page).getByRole("button", { name: /^保\s*存$/ }).click();
  await expect.poll(() => 状态(page)).toBe("关着");
  const 存 = (await 调用们()).filter((c) => c.名 === "saveCustomer");
  expect(存).toHaveLength(1);
  expect(存[0].参).toMatchObject({ name: "Wang Wei", phone: "", extra: { wechat: "wangwei_88" } });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("daedalus:草稿:")))).toEqual([]);

  // 再开就是空的
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await page.waitForTimeout(400);
  expect(await 框(page).getByLabel("客户姓名").inputValue()).toBe("");
  expect(errors).toEqual([]);
});

it("「放弃」：关掉、草稿也清掉，下次打开是空的", async () => {
  const { page, errors } = await 开();
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await 框(page).getByLabel("客户姓名").fill("Temp");
  await 框(page).getByRole("button", { name: /^取\s*消$/ }).click();
  await page.getByRole("button", { name: /^放\s*弃$/ }).click();
  await expect.poll(() => 状态(page)).toBe("关着");
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  await page.waitForTimeout(400);
  expect(await 框(page).getByLabel("客户姓名").inputValue()).toBe("");
  expect(errors).toEqual([]);
});

it("外贸新建：四格（电话 / WhatsApp / 邮箱 / 微信）旁边同一个记号；四样都没填，说四样至少填一个，不交", async () => {
  const { page, errors, 调用们 } = await 开();
  await page.getByRole("button", { name: "开新建" }).click();
  await 框(page).waitFor();
  expect(await 框(page).locator(".cf-any-mark").count()).toBe(6); // 五格各一个（10-21 加了阿里 ID），提示那一行再一个
  // 电话不再单独标红星：四格是一样的
  expect(await 框(page).locator("label[for=phone].ant-form-item-required").count()).toBe(0);
  await 框(page).getByLabel("客户姓名").fill("Nobody");
  await 框(page).getByRole("button", { name: /^保\s*存$/ }).click();
  await 框(page).getByText("电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个", { exact: true }).waitFor();
  expect((await 调用们()).filter((c) => c.名 === "saveCustomer")).toHaveLength(0);
  expect(errors).toEqual([]);
});

it("编辑：改了按 Esc 也问，但不给「留着草稿」（编辑不存草稿）；按微信认的那位，微信不能清空", async () => {
  const { page, errors, 调用们 } = await 开();
  await page.getByRole("button", { name: "开编辑" }).click();
  const 编辑框 = page.getByRole("dialog", { name: "编辑客户" });
  await 编辑框.waitFor();
  await 编辑框.getByLabel(/^微信/).fill("");
  await 编辑框.getByRole("button", { name: /^保\s*存$/ }).click();
  await 编辑框.getByText("这位没有电话，是按微信认的，微信不能清空").waitFor();
  expect((await 调用们()).filter((c) => c.名 === "saveCustomer")).toHaveLength(0);

  await page.keyboard.press("Escape");
  await 问框(page).waitFor();
  expect(await page.getByRole("button", { name: "留着草稿，先关掉" }).count()).toBe(0);
  await page.getByRole("button", { name: /^放\s*弃$/ }).click();
  await expect.poll(() => 状态(page)).toBe("关着");
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("daedalus:草稿:")))).toEqual([]);
  expect(errors).toEqual([]);
});
