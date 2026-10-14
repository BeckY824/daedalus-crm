import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser, bundle: string;
const plugin: Plugin = { name: "contract-date-actions", setup(b) {
  b.onResolve({ filter: /^next\/navigation$/ }, a => ({ path: a.path, namespace: "fixture", pluginData: "export const useRouter=()=>({refresh(){},push(){}});" }));
  b.onResolve({ filter: /^\.\.\/actions$/ }, a => ({ path: a.path, namespace: "fixture", pluginData: "export const saveContract=async(value)=>{window.__saved=value;return {ok:true}};export const listContractLinks=async()=>({商机:[],计划:[],待办:[]});" }));
  b.onResolve({ filter: /^\.\.\/\.\.\/orders\/actions$/ }, a => ({ path: a.path, namespace: "fixture", pluginData: "export const 供应商候选=async()=>[];" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import ContractForm from '@/app/(app)/customers/[id]/ContractForm';import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    const editing=window.__new?null:{id:'qa-contract',amount:1200,currency:'CNY',signedAt:'2026-10-11T00:00:00+08:00',remark:null,order:{id:'qa-order',no:'QA-DATE',payment:null,supplier:null}};
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={{...DEFAULT_BUSINESS,template:window.__trade?'trade':'general'}} timeZone={window.__hosted?'Asia/Shanghai':null}><ContractForm open customerId='qa-customer' editing={editing} onClose={()=>{window.__closed=true}}/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, plugins: [plugin], logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
async function open(opts = { trade: true, fresh: false, hosted: false }) {
  const page = await browser.newPage({ timezoneId: "America/New_York" }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('http://contract-date.test/**', r => r.fulfill({ contentType: 'text/html', body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto('http://contract-date.test');
  await page.evaluate(o => Object.assign(window, { __trade: o.trade, __new: o.fresh, __hosted: o.hosted }), opts);
  await page.addScriptTag({ content: bundle });
  await page.getByRole('dialog').waitFor().catch(async e => { throw new Error(`${e.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`); });
  return page;
}
async function save(page: Page) { await page.getByRole('dialog').getByRole('button', { name: /保\s*存/ }).click(); }
async function signedAt(page: Page) {
  return page.evaluate(() => (Reflect.get(window, '__saved') as unknown as { signedAt?: Date } | undefined)?.signedAt?.toISOString());
}
it.each(['2026-13-40', '2026-02-29'])("B5 编辑订单无效日期 %s 不提交旧日期，纠正后才能保存", async invalid => {
  const page = await open();
  try {
    const input = page.getByLabel('订单确认时间', { exact: true });
    await input.fill(invalid); await save(page);
    await page.getByText('请输入有效日期（YYYY-MM-DD）', { exact: true }).waitFor();
    expect(await input.inputValue()).toBe(invalid);
    expect(await page.evaluate(() => Reflect.get(window, '__saved'))).toBeUndefined();
    expect(await page.evaluate(() => Reflect.get(window, '__closed'))).toBeUndefined();
    await input.fill('2028-02-29'); await save(page);
    await expect.poll(() => signedAt(page)).toBe('2028-02-29T05:00:00.000Z');
  } finally { await page.close(); }
});
it.each([false, true])("新建通用签约／订单（外贸=%s）空文本不能沿用默认日期", async trade => {
  const page = await open({ trade, fresh: true, hosted: false });
  try {
    await page.getByRole('spinbutton', { name: trade ? '订单金额' : '签约金额', exact: true }).fill('333');
    const input = page.getByLabel(trade ? '订单确认时间' : '签约时间', { exact: true });
    await input.fill(''); await save(page);
    expect(await page.evaluate(() => Reflect.get(window, '__saved'))).toBeUndefined();
    await input.fill('2026-10-12'); await save(page);
    await expect.poll(() => signedAt(page)).toBe('2026-10-12T04:00:00.000Z');
  } finally { await page.close(); }
});
it("托管北京日期在纽约浏览器手输与日历选择都能保存，不漂移日期", async () => {
  const page = await open({ trade: false, fresh: false, hosted: true });
  try {
    const input = page.getByLabel('签约时间', { exact: true });
    await input.fill('2026-03-08'); await save(page);
    await expect.poll(() => signedAt(page)).toBe('2026-03-07T16:00:00.000Z');
    await input.click();
    await page.locator('.ant-picker-cell[title="2026-03-09"] .ant-picker-cell-inner').last().click();
    await save(page);
    await expect.poll(() => signedAt(page)).toBe('2026-03-08T16:00:00.000Z');
  } finally { await page.close(); }
});
it.each([false, true])("输入无效日期后从日历重新选择原日期，也能解除错误并保存（北京业务日=%s）", async hosted => {
  const page = await open({ trade: true, fresh: false, hosted });
  try {
    const input = page.getByLabel('订单确认时间', { exact: true });
    const original = await input.inputValue();
    await input.fill('2026-13-40'); await save(page);
    await page.getByText('请输入有效日期（YYYY-MM-DD）', { exact: true }).waitFor();
    await input.click();
    await page.locator(`.ant-picker-cell[title="${original}"] .ant-picker-cell-inner`).last().click();
    expect(await input.inputValue()).toBe(original);
    await save(page);
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__saved'))).toBeDefined();
    const expected = await page.evaluate(({ original, hosted }) => new Date(original + (hosted ? 'T00:00:00+08:00' : 'T00:00:00')).toISOString(), { original, hosted });
    expect(await signedAt(page)).toBe(expected);
  } finally { await page.close(); }
});
