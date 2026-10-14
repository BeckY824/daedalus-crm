import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser } from "playwright";
let browser: Browser; let bundle: string;
const plugin: Plugin = { name: "clock-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, a => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){window.__refreshes=(window.__refreshes??0)+1},push(){}});export const usePathname=()=>'/follow-ups/plans';");
  stub(/^@\/app\/\(app\)\/demo-data$/, "export const 查演示数据状态=async()=>({可灌:false,可清:false}),灌一套演示数据=async()=>({ok:true}),清除演示数据=灌一套演示数据;");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/customers\/\[id\]\/actions$/, "export const toggleTask=async()=>({ok:true}),completePlan=toggleTask,deletePlan=toggleTask,deleteTask=toggleTask;");
  stub(/customers\/\[id\]\/(PlanForm|TaskForm)$/, "export default function C(){return null}");
  b.onLoad({ filter: /.*/, namespace: "stub" }, a => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };
beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {DEFAULT_BUSINESS} from '@/lib/business-config';
    import {认日期} from '@/lib/import/plan';import {dayjs,smartTime} from '@/lib/utils';import {calendarDay} from '@/lib/schedule-date';import {是逾期} from '@/lib/overdue';import {parseDateInput} from '@/lib/date-input';
    import PlansView from '@/app/(app)/follow-ups/plans/PlansView';import DatePicker from '@/components/BusinessDatePicker';
    function Test(){const now=new Date();return <>
      <pre id="clock">{JSON.stringify({today:calendarDay(now),imported:calendarDay(认日期('2026-11-01')),month:dayjs().startOf('month').toISOString(),start:dayjs().startOf('day').toISOString(),added:dayjs().add(1,'day').toISOString(),hour:dayjs().hour(2).minute(15).toISOString(),parsed:parseDateInput('2026-11-01T02:30')?.toISOString(),label:smartTime('2026-10-31T16:15Z'),overdue:是逾期('2026-10-31'),todayOverdue:是逾期('2026-11-01')})}</pre>
      <div id="date"><DatePicker onChange={d=>window.__picked=d?.format('YYYY-MM-DD')}/></div>
      <div id="time"><DatePicker showTime format="YYYY-MM-DD HH:mm" onChange={d=>window.__timed=d?.toISOString()}/></div>
      <PlansView plans={['2026-10-31','2026-11-01','2026-10-31T15:00Z','2026-10-31T17:00Z'].map((plannedAt,i)=>({id:'p'+i,subject:'计划'+i,plannedAt,method:'电话沟通',updatedAt:'2026-10-31T15:00Z',customerId:'c',customerName:'QA',ownerId:'u',ownerName:'QA'}))} tasks={[]} done={[]} meId="u" 预选客户={null} 直接新建={false}/>
    </>}
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={DEFAULT_BUSINESS} timeZone={window.__hosted?'Asia/Shanghai':null}><Test/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });
it.each(["America/New_York", "America/Los_Angeles", "UTC", "America/Santiago", "Pacific/Auckland"])("托管浏览器%s与服务端北京业务日一致，包括夏令时/跨月和实际计划分组", async timezoneId => {
  const page = await browser.newPage({ timezoneId }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://clock.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://clock.test"); await page.clock.setFixedTime(new Date("2026-10-31T16:30Z"));
  await page.evaluate(() => Object.assign(window, { __hosted: true })); await page.addScriptTag({ content: bundle });
  const clock = JSON.parse((await page.locator("#clock").textContent())!);
  expect(clock).toMatchObject({ today: "2026-11-01", imported: "2026-11-01", month: "2026-10-31T16:00:00.000Z", start: "2026-10-31T16:00:00.000Z", added: "2026-11-01T16:30:00.000Z", hour: "2026-10-31T18:15:00.000Z", parsed: "2026-10-31T18:30:00.000Z", label: "今天 00:15", overdue: true, todayOverdue: false });
  expect(await page.getByText(/北京时间（UTC\+8）/).count()).toBe(1);
  const overdue = page.locator(".plan-g").filter({ has: page.locator(".plan-g-h b", { hasText: /^逾期$/ }) });
  const today = page.locator(".plan-g").filter({ has: page.locator(".plan-g-h b", { hasText: /^今天$/ }) });
  expect(await overdue.locator(".plan-row").count()).toBe(2); expect(await today.locator(".plan-row").count()).toBe(2);
  await page.locator("#date input").click(); await page.locator(".ant-picker-now-btn:visible").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __picked?: string }).__picked)).toBe("2026-11-01");
  await page.locator("#time input").click(); await page.locator(".ant-picker-now-btn:visible").filter({ hasText: /^此刻$/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __timed?: string }).__timed)).toBe("2026-10-31T16:30:00.000Z");
  if (timezoneId === "America/New_York") {
    // 北京合法的02:30不得因纽约同日DST缺口而被输入解析器拒绝。
    await page.locator("#time input").fill("2026-03-08 02:30"); await page.locator("#time input").press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __timed?: string }).__timed)).toBe("2026-03-07T18:30:00.000Z");
    await page.clock.setFixedTime(new Date("2026-11-01T04:30Z")); await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(await page.evaluate(() => (window as unknown as { __refreshes?: number }).__refreshes ?? 0)).toBe(0);
    await page.clock.setFixedTime(new Date("2026-11-01T16:30Z")); await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshes?: number }).__refreshes)).toBe(1);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(await page.evaluate(() => (window as unknown as { __refreshes?: number }).__refreshes)).toBe(1);
  }
  expect(errors).toEqual([]); await page.close();
});
it("纽约桌面本地浏览器保留本机日期、月底和计划分组", async () => {
  const page = await browser.newPage({ timezoneId: "America/New_York" }); page.setDefaultTimeout(5000);
  await page.route("http://clock.test/**", r => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://clock.test"); await page.clock.setFixedTime(new Date("2026-10-31T16:30Z"));
  await page.evaluate(() => Object.assign(window, { __hosted: false })); await page.addScriptTag({ content: bundle });
  expect(JSON.parse((await page.locator("#clock").textContent())!)).toMatchObject({ today: "2026-10-31", month: "2026-10-01T04:00:00.000Z", overdue: false });
  expect(await page.getByText(/本机时区/).count()).toBe(1);
  const today = page.locator(".plan-g").filter({ has: page.locator(".plan-g-h b", { hasText: /^今天$/ }) }); expect(await today.locator(".plan-row").count()).toBe(3);
  await page.close();
});
