/**
 * 外贸基础（2026-10-16）的界面：真浏览器里点一遍（打包方式同 remediation-business-clock.ui.test.ts，服务端动作换成假的、记下交了什么）。
 *   计划页点 ✓ → 小框：方式按计划写的来、一句话没写时「保存并完成」是灰的、下次默认 7 天后（北京日历日）→ 交给 saveFollowUp 的就是
 *     一条已完成的跟进 + 完成这条计划 + 7 天后的日期计划；「不排」就不带计划；「跳过，直接完成」只调 completePlan
 *   待办点 ✓ 不弹框，照旧直接完成
 *   对方当地时间：浏览器在伦敦，美国客户显示「对方当地 HH:mm」，是夜里的标「夜里」；英国客户（同一钟点）不显示
 * 2026-10-17 PR26 手测补的：
 *   有 WhatsApp 号的客户：计划写着老默认「电话沟通」时小框默认 WhatsApp；记录跟进、新建计划（给定的 / 挑中的）也默认 WhatsApp
 *   「保存并完成」的提示里有「撤销」，点了交给 撤销记一笔 的是这一笔、这条计划、刚排的下一条
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let bundle: string;
let 表单包: string;
const plugin: Plugin = { name: "trade-basics-ui", setup(b) {
  const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub", pluginData: code }));
  stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});export const usePathname=()=>'/follow-ups/plans';");
  stub(/^next\/link$/, "export default function L(p){return <a {...p}/>}");
  stub(/(^|\/)demo-data$/, "export const 查演示数据状态=async()=>({可灌:false,可清:false}),灌一套演示数据=async()=>({ok:true}),清除演示数据=灌一套演示数据;");
  stub(/(customers\/\[id\]\/|^\.\/)actions$/, `
    const 记=(名,参)=>{(window.__calls??=[]).push({名,参});return {ok:true,id:'f1'}};
    export const 撤销记一笔=async(x)=>记('撤销记一笔',x);
    export const saveFollowUp=async(x)=>({...记('saveFollowUp',x),...(x.附带?.plan?{下次计划id:'n1'}:{})}),completePlan=async(id,完成=true)=>记('completePlan',{id,完成}),toggleTask=async(id,v)=>记('toggleTask',{id,v}),deletePlan=async()=>({ok:true}),deleteTask=deletePlan;`);
  stub(/customers\/\[id\]\/(PlanForm|TaskForm)$/, "export default function C(){return null}");
  b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
} };

beforeAll(async () => {
  const r = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {BUSINESS_PRESETS} from '@/lib/business-config';
    import PlansView from '@/app/(app)/follow-ups/plans/PlansView';import LocalTime from '@/components/LocalTime';
    const 计划=(id,subject,method,有WhatsApp)=>({id,subject,method,有WhatsApp,plannedAt:'2026-10-16T01:00:00Z',updatedAt:'2026-10-16T01:00:00Z',customerId:'c-'+id,customerName:'Acme '+id,ownerId:'u',ownerName:'我'});
    function Test(){return <>
      <div id="us"><LocalTime country="美国"/></div>
      <div id="uk"><LocalTime country="英国"/></div>
      <div id="dubai"><LocalTime country="UAE" 简短/></div>
      <PlansView plans={[计划('p1','发新报价','WhatsApp'),计划('p2','问样品','电话沟通'),计划('p3','回访','邮件沟通'),计划('p4','催定金','电话沟通',true),计划('p5','寄目录','邮件沟通',true)]}
        tasks={[{id:'t1',title:'整理报价单',dueAt:'2026-10-16T01:00:00Z',updatedAt:'2026-10-16T01:00:00Z',customerId:'c',customerName:'Acme',ownerId:'u',ownerName:'我'}]}
        done={[]} meId="u" 预选客户={null} 直接新建={false}/>
    </>}
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={BUSINESS_PRESETS['外贸出口']} timeZone={'Asia/Shanghai'}><Test/></BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin], logLevel: "silent" });
  bundle = r.outputFiles[0].text;
  // 记录跟进 / 新建计划两张表单：真组件，服务端动作和挑人那一格换成假的；挑人那一格点一下就挑中一位有 WhatsApp 号的
  const 表单插件: Plugin = { name: "trade-basics-forms", setup(b) {
    const stub = (filter: RegExp, code: string) => b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub", pluginData: code }));
    stub(/^next\/navigation$/, "export const useRouter=()=>({refresh(){},push(){}});");
    stub(/^\.\/actions$/, "export const saveFollowUp=async()=>({ok:true,id:'f1'}),completePlan=saveFollowUp,savePlan=saveFollowUp;");
    stub(/^\.\/ai$/, "export const parseFollowUpDraft=async()=>({ok:false,error:'no'});");
    stub(/^\.\/CustomerPick$/, `const 人=(id,name,有WhatsApp)=>({id,name,上次跟进:null,未完成计划:null,未完成计划数:0,contacts:[],opportunities:[],orders:[],有WhatsApp});
      export default function C(p){return <><button type='button' onClick={()=>p.on近况(人('c9','Zeta',true))}>挑 Zeta</button><button type='button' onClick={()=>p.on近况(人('c8','Bright',false))}>挑 Bright</button></>}`);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData, loader: "jsx", resolveDir: process.cwd() }));
  } };
  const f = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/locale/zh_CN';
    import {BusinessProvider} from '@/lib/business-client';import {BUSINESS_PRESETS} from '@/lib/business-config';
    import FollowUpForm from '@/app/(app)/customers/[id]/FollowUpForm';import PlanForm from '@/app/(app)/customers/[id]/PlanForm';
    const 关=()=>{};const 哪个=new URLSearchParams(location.search).get('f');
    const 表={
      跟进有号:<FollowUpForm open onClose={关} onSaved={关} customerId="c1" 有WhatsApp record={null} aiEnabled={false}/>,
      跟进没号:<FollowUpForm open onClose={关} onSaved={关} customerId="c1" record={null} aiEnabled={false}/>,
      跟进挑人:<FollowUpForm open onClose={关} onSaved={关} record={null} aiEnabled={false}/>,
      计划有号:<PlanForm open onClose={关} onSaved={关} customerId="c1" 有WhatsApp record={null}/>,
      计划没号:<PlanForm open onClose={关} onSaved={关} customerId="c1" record={null}/>,
      计划挑人:<PlanForm open onClose={关} onSaved={关} record={null}/>,
    };
    createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App><BusinessProvider value={BUSINESS_PRESETS['外贸出口']} timeZone={'Asia/Shanghai'}>{表[哪个]}</BusinessProvider></App></ConfigProvider>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", alias: { "@": path.resolve("src") }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [表单插件], logLevel: "silent" });
  表单包 = f.outputFiles[0].text;
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
  await page.getByText(/已记一笔，「发新报价」完成；下次 10 月 23 日/).waitFor({ timeout: 15_000 });
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
  await page.getByText("已记一笔，「问样品」完成").waitFor({ timeout: 15_000 });
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
  await page.getByText(/「回访」完成；下次 11 月 2 日/).waitFor({ timeout: 15_000 });
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

it("有 WhatsApp 号：计划写的是老默认「电话沟通」时小框默认 WhatsApp，写了别的（邮件）照它的", async () => {
  const { page } = await 开();
  await page.getByRole("button", { name: "完成 催定金" }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await 框.waitFor();
  await expect.poll(() => 框.getByLabel("跟进方式").locator("..").innerText()).toContain("WhatsApp");
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await page.getByText("「催定金」已完成").waitFor();
  await page.getByRole("button", { name: "完成 寄目录" }).click();
  await 框.waitFor();
  await expect.poll(() => 框.getByLabel("跟进方式").locator("..").innerText()).toContain("邮件沟通");
  await page.close();
});

it("「保存并完成」的提示里有撤销：点了交给 撤销记一笔 的是这一笔、这条计划、刚排的下一条", async () => {
  const { page, errors, 调用们 } = await 开();
  await page.getByRole("button", { name: "完成 催定金" }).click();
  const 框 = page.getByTestId("complete-plan-modal");
  await 框.waitFor();
  await 框.getByLabel("这次聊了什么").fill("催了，说下周付");
  await page.getByRole("button", { name: "保存并完成" }).click();
  // 这条只管「撤销」交了什么；下次是哪天由第一条（7 天后）管，这里不绑日期。CI 全量并发时提示条偶尔超 5 秒才出来，放宽到 15 秒
  await page.getByText(/已记一笔，「催定金」完成；下次 \d+ 月 \d+ 日/).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "撤销" }).click();
  await page.getByText("「催定金」已改回未完成，刚记的那笔已删掉").waitFor();
  const 撤 = (await 调用们()).filter((x) => x.名 === "撤销记一笔");
  expect(撤.map((x) => x.参)).toEqual([{ customerId: "c-p4", 跟进id: "f1", 计划id: "p4", 下次计划id: "n1" }]);
  expect(errors).toEqual([]);
  await page.close();
});

async function 开表单(哪个: string) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://trade-forms.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<meta charset='utf-8'><div id='root'></div>" }));
  await page.goto(`http://trade-forms.test/?f=${encodeURIComponent(哪个)}`);
  await page.addScriptTag({ content: 表单包 });
  await page.getByRole("dialog").waitFor();
  return { page, errors };
}
/** 「跟进类型」那一格：读整格的字（标签 + 选中的那一项），下拉不展开时只有选中的那一项 */
const 类型格 = (page: Page) => page.getByRole("dialog").locator(".ant-form-item", { hasText: "跟进类型" }).first();
const 方式格 = (page: Page) => page.getByRole("dialog").locator(".ant-form-item", { hasText: "跟进方式" }).locator("input");

it("记录跟进：有 WhatsApp 号默认 WhatsApp，没号照旧电话沟通；挑人时挑中有号的那位也跟着变", async () => {
  for (const [哪个, 应是] of [["跟进有号", "WhatsApp"], ["跟进没号", "电话沟通"]] as const) {
    const { page, errors } = await 开表单(哪个);
    await expect.poll(() => 类型格(page).innerText()).toMatch(new RegExp(`跟进类型\\s+${应是}$`));
    expect(errors).toEqual([]);
    await page.close();
  }
  const { page } = await 开表单("跟进挑人");
  await expect.poll(() => 类型格(page).innerText()).toMatch(/跟进类型\s+电话沟通$/);
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(() => 类型格(page).innerText()).toMatch(/跟进类型\s+WhatsApp$/);
  await page.close();
});

it("新建计划：有 WhatsApp 号方式默认 WhatsApp，没号照旧电话沟通；挑人时挑中有号的那位也跟着变", async () => {
  for (const [哪个, 应是] of [["计划有号", "WhatsApp"], ["计划没号", "电话沟通"]] as const) {
    const { page, errors } = await 开表单(哪个);
    await expect.poll(() => 方式格(page).inputValue()).toBe(应是);
    expect(errors).toEqual([]);
    await page.close();
  }
  const { page } = await 开表单("计划挑人");
  await expect.poll(() => 方式格(page).inputValue()).toBe("电话沟通");
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(() => 方式格(page).inputValue()).toBe("WhatsApp");
  // 2026-10-17 复测：有号 → 没号要回电话沟通（程序填进去的 WhatsApp 不算人改过）
  await page.getByRole("button", { name: "挑 Bright" }).click();
  await expect.poll(() => 方式格(page).inputValue()).toBe("电话沟通");
  await page.close();
});

it("新建计划：人亲手改过方式（邮件）之后再换人，方式不动", async () => {
  const { page } = await 开表单("计划挑人");
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(() => 方式格(page).inputValue()).toBe("WhatsApp");
  await 方式格(page).fill("邮件沟通");
  await expect.poll(() => 方式格(page).inputValue()).toBe("邮件沟通");
  await page.getByRole("button", { name: "挑 Bright" }).click();
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(() => 方式格(page).inputValue()).toBe("邮件沟通");
  await page.close();
});

it("记录跟进：有号 → 没号回电话沟通；人亲手改过类型（邮件）之后再换人，类型不动", async () => {
  const { page } = await 开表单("跟进挑人");
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(() => 类型格(page).innerText()).toMatch(/跟进类型\s+WhatsApp$/);
  await page.getByRole("button", { name: "挑 Bright" }).click();
  await expect.poll(() => 类型格(page).innerText()).toMatch(/跟进类型\s+电话沟通$/);
  await 类型格(page).locator(".ant-select").click();
  await page.locator(".ant-select-dropdown:visible").getByText("邮件沟通", { exact: true }).click();
  // 下拉开过之后它挂在这一格里，整格 innerText 会多带选项文字（快慢不定，全量并发跑时常撞上）：只看选中的那一项
  const 选中 = () => 类型格(page).locator(".ant-select-content").first().innerText();
  await expect.poll(选中).toBe("邮件沟通");
  await page.getByRole("button", { name: "挑 Zeta" }).click();
  await expect.poll(选中).toBe("邮件沟通");
  await page.close();
});
