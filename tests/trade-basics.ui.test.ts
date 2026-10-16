/**
 * 外贸基础（2026-10-16）的界面：真浏览器里点一遍（打包方式同 remediation-business-clock.ui.test.ts，服务端动作换成假的、记下交了什么）。
 *   计划页点 ✓ → 小框：方式按计划写的来、一句话没写时「保存并完成」是灰的、下次默认 7 天后（北京日历日）→ 交给 saveFollowUp 的就是
 *     一条已完成的跟进 + 完成这条计划 + 7 天后的日期计划；「不排」就不带计划；「跳过，直接完成」只调 completePlan
 *   待办点 ✓ 不弹框，照旧直接完成
 *   对方当地时间：浏览器在伦敦，美国客户显示「对方当地 HH:mm」，是夜里的标「夜里」；英国客户（同一钟点）不显示
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let bundle: string;
const plugin: Plugin = { name: "trade-basics-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>'/follow-ups/plans';");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)demo-data$/, "export const 查演示数据状态=async()=>({可灌:false,可清:false}),灌一套演示数据=async()=>({ok:true}),清除演示数据=灌一套演示数据;");
  stub(/(customers\/\[id\]\/|^\.\/)actions$/, `
    const 记=(名,参)=>{(window.__calls??=[]).push({名,参});return {ok:true,id:'f1'}};
    export const saveFollowUp=async(x)=>记('saveFollowUp',x),completePlan=async(id,完成=true)=>记('completePlan',{id,完成}),toggleTask=async(id,v)=>记('toggleTask',{id,v}),deletePlan=async()=>({ok:true}),deleteTask=deletePlan;`);
  stub(/customers\/\[id\]\/(PlanForm|TaskForm)$/, "export default function C(){return null}");
  b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };

beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {BUSINESS_PRESETS} from '@/lib/business-config';
    import PlansView from '@/app/(app)/follow-ups/plans/PlansView';import LocalTime from '@/components/LocalTime';
    const 计划=(id,subject,method)=>({id,subject,method,plannedAt:'2026-10-16T01:00:00Z',updatedAt:'2026-10-16T01:00:00Z',customerId:'c-'+id,customerName:'Acme '+id,ownerId:'u',ownerName:'我'});
    function Test(){return <>
      <div id="us"><LocalTime country="美国"/></div>
      <div id="uk"><LocalTime country="英国"/></div>
      <div id="dubai"><LocalTime country="UAE" 简短/></div>
      <PlansView plans={[计划('p1','发新报价','WhatsApp'),计划('p2','问样品','电话沟通'),计划('p3','回访','邮件沟通')]}
        tasks={[{id:'t1',title:'整理报价单',dueAt:'2026-10-16T01:00:00Z',updatedAt:'2026-10-16T01:00:00Z',customerId:'c',customerName:'Acme',ownerId:'u',ownerName:'我'}]}
        done={[]} meId="u" 预选客户={null} 直接新建={false}/>
    </>}
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={BUSINESS_PRESETS['外贸出口']} timeZone={'Asia/Shanghai'}><Test/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

type 调用 = { 名: string; 参: Record<string, unknown> };
async function 开(): Promise<{ page: Page; errors: string[]; 调用们: () => Promise<调用[]> }> {
  const page = await browser.newPage({ timezoneId: "Europe/London" });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://trade.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto("http://trade.test");
  // 伦敦 2026-10-16 07:05（夏令时）= 北京 14:05 = 纽约 02:05
  await page.clock.setFixedTime(new Date("2026-10-16T06:05:00Z"));
  await page.addScriptTag({ content: bundle });
  return { page, errors, 调用们: () => page.evaluate(() => (window as unknown as { __calls?: 调用[] }).__calls ?? []) };
}

it("计划页：点 ✓ 弹小框；没写一句话时保存是灰的；保存并完成交的是「跟进 + 完成计划 + 7 天后的日期计划」", async () => {
  const { page, errors, 调用们 } = await 开();
  await page.getByRole("button", { name: "完成 发新报价" }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await 框.waitFor();
  await expect.poll(() => 框.getByLabel("跟进方式").locator("..").innerText()).toContain("WhatsApp");
  const 保存 = page.getByRole("button", { name: "保存并完成" });
  expect(await 保存.isDisabled()).toBe(true);
  await 框.getByLabel("这次聊了什么").fill("新报价发了，客户说周五回复");
  expect(await 保存.isDisabled()).toBe(false);
  expect(await 框.innerText()).toContain("会排一条 10 月 23 日的计划：接着跟进：新报价发了");
  await 保存.click();
  await page.getByText(/已记一笔，「发新报价」完成；下次 10 月 23 日/).waitFor();
  const [c] = (await 调用们()).filter((x) => x.名 === "saveFollowUp");
  expect(c.参).toMatchObject({
    customerId: "c-p1", type: "WHATSAPP", status: "已完成", content: "新报价发了，客户说周五回复",
    附带: { tasks: [], 完成计划: "p1", plan: { subject: "接着跟进：新报价发了", plannedAt: "2026-10-23", method: "WhatsApp" } },
  });
  expect((await 调用们()).some((x) => x.名 === "completePlan")).toBe(false);
  expect(errors).toEqual([]);
  await page.close();
});

it("小框：方式按计划写的认（电话沟通 → 电话）；「不排」就不带下次计划；「选日子」挑的那天照交", async () => {
  const { page, 调用们 } = await 开();
  await page.getByRole("button", { name: "完成 问样品" }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await 框.waitFor();
  await expect.poll(() => 框.getByLabel("跟进方式").locator("..").innerText()).toContain("电话沟通");
  await 框.getByLabel("这次聊了什么").fill("打过了，样品没问题");
  await 框.getByText("不排", { exact: true }).click();
  expect(await 框.innerText()).not.toContain("会排一条");
  await page.getByRole("button", { name: "保存并完成" }).click();
  await page.getByText("已记一笔，「问样品」完成").waitFor();
  const [c] = (await 调用们()).filter((x) => x.名 === "saveFollowUp");
  expect(c.参).toMatchObject({ type: "PHONE", 附带: { 完成计划: "p2" } });
  expect((c.参.附带 as Record<string, unknown>).plan).toBeUndefined();

  // 另一条：选日子
  await page.getByRole("button", { name: "完成 回访" }).click();
  await 框.waitFor();
  await expect.poll(() => 框.getByLabel("跟进方式").locator("..").innerText()).toContain("邮件沟通");
  await 框.getByLabel("这次聊了什么").fill("邮件回了");
  await 框.getByText("选日子", { exact: true }).click();
  await 框.getByLabel("下次跟进日期").fill("2026-11-02");
  await 框.getByLabel("下次跟进日期").press("Enter");
  await page.getByRole("button", { name: "保存并完成" }).click();
  await page.getByText(/「回访」完成；下次 11 月 2 日/).waitFor();
  const 第二 = (await 调用们()).filter((x) => x.名 === "saveFollowUp")[1];
  expect(第二.参).toMatchObject({ type: "EMAIL", 附带: { plan: { plannedAt: "2026-11-02", method: "邮件沟通" } } });
  await page.close();
});

it("小框：「跳过，直接完成」只勾掉计划（提示里照旧有撤销）；待办点 ✓ 不弹框", async () => {
  const { page, 调用们 } = await 开();
  await page.getByRole("button", { name: "完成 发新报价" }).click();
  await page.getByTestId("complete-plan-modal").waitFor();
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await page.getByText("「发新报价」已完成").waitFor();
  await page.getByRole("button", { name: "撤销" }).waitFor();
  expect((await 调用们()).map((x) => x.名)).toEqual(["completePlan"]);

  await page.getByRole("button", { name: "完成 整理报价单" }).click();
  await page.getByText("「整理报价单」已完成").waitFor();
  expect(await page.getByTestId("complete-plan-modal").count()).toBe(0);
  expect((await 调用们()).map((x) => x.名)).toEqual(["completePlan", "toggleTask"]);
  await page.close();
});

it("对方当地时间：美国显示「对方当地 02:05」并标夜里；迪拜简短写法；英国和本机同一钟点不显示", async () => {
  const { page, errors } = await 开();
  await page.locator("#us [data-testid=local-time]").waitFor();
  expect(await page.locator("#us").innerText()).toBe("对方当地 02:05夜里");
  expect(await page.locator("#us [data-testid=local-time]").getAttribute("title")).toContain("America/New_York");
  expect(await page.locator("#dubai").innerText()).toBe("10:05");
  expect(await page.locator("#uk").innerText()).toBe("");
  expect(errors).toEqual([]);
  await page.close();
});
