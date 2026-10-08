import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser } from "playwright";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import path from "node:path";
let browser: Browser, script: string, worker: string;
const stub: Plugin = { name: "export-actions-local", setup(b) {
  b.onResolve({ filter: /^\.\/export-action$/ }, () => ({ path: "actions", namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
    const totals = () => window.__case === 'big' ? {客户数:20001,跟进数:50001} : {客户数:2,跟进数:1};
    export async function 开始完整导出() { if(window.__case==='hang') return new Promise(()=>{}); return {...totals(),截止:'2026-01-01T00:00:00.000Z'}; }
    export async function 读取完整导出批次(filters,at,kind,cursor) {
      const total = kind==='客户'?totals().客户数:totals().跟进数;
      const start = cursor ? Number(cursor):0, end = Math.min(total,start+(kind==='客户'?5000:10000));
      const rows=Array.from({length:end-start},(_,n)=>{const i=start+n; return kind==='客户'?{id:'c'+i,name:'客户'+i,phone:'+86 13800000001',school:null,major:null,grade:null,followStatus:'待跟进',decisionStatus:'待定',expectedSignAt:null,signedAmount:0,salesOwnerName:'我',remark:'=文本'}:{id:'f'+i,customerId:'c'+(i%totals().客户数),customerName:'客户'+(i%totals().客户数),phone:'+86 13800000001',occurredAt:at,type:'PHONE',title:'回电',content:'完整跟进 '+i,status:'已完成',opportunityName:null,orderNo:null,ownerName:'我'};});
      return {类别:kind,rows,指纹:'local',游标:end<total?String(end):null};
    }
    export async function 校验完整导出(){if(window.__case==='change') throw new Error('导出期间数据发生变化，请重新导出'); return {ok:true};}
  ` }));
} };
beforeAll(async () => {
  script = (await build({ stdin: { contents: `
    import { 完整导出 } from '@/app/(app)/customers/export-client';
    import { DEFAULT_BUSINESS } from '@/lib/business-config';
    let controller;
    window.__ticks=0; window.__maxGap=0;
    let last=performance.now(); setInterval(()=>{const now=performance.now();window.__maxGap=Math.max(window.__maxGap,now-last);last=now;window.__ticks++},16);
    document.getElementById('go').onclick=async()=>{controller=new AbortController();try{await 完整导出({},DEFAULT_BUSINESS,t=>document.getElementById('status').textContent=t,controller.signal);document.getElementById('status').textContent='完成';}catch(e){document.getElementById('status').textContent=e.message;}};
    document.getElementById('cancel').onclick=()=>controller?.abort();
  `, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", plugins: [stub], alias: { "@": path.resolve("src") }, logLevel: "silent" })).outputFiles[0].text;
  worker = (await build({ entryPoints: ["src/app/(app)/customers/export.worker.ts"], bundle: true, write: false, format: "iife", alias: { "@": path.resolve("src") }, logLevel: "silent" })).outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(() => browser?.close());
async function open(mode: string) {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.route("http://export.test/**", r => {
    const pathname = new URL(r.request().url()).pathname;
    return r.fulfill({ contentType: pathname === "/" ? "text/html" : "application/javascript", body: pathname === "/" ? '<meta charset="utf-8"><button id="go">完整导出</button><button id="cancel">取消导出</button><div id="status" role="status"></div><script type="module" src="/client.js"></script>' : pathname === "/client.js" ? script : worker });
  });
  await page.goto("http://export.test/");
  await page.evaluate(m => { Object.assign(window, { __case: m }); }, mode);
  return page;
}
it("W025：真实Worker导出超上限全量ZIP，清单/分片/稳定编号完整且页面保持响应", async () => {
  const page = await open("big");
  const download = page.waitForEvent("download", { timeout: 90000 });
  await page.getByRole("button", { name: "完整导出", exact: true }).click();
  const file = await download;
  const zipPath = path.resolve("../测试证据-2026-10-08/整改-W025-完整导出.zip");
  await file.saveAs(zipPath);
  const files = unzipSync(readFileSync(zipPath));
  const manifest = JSON.parse(strFromU8(files["导出清单.json"]));
  expect(manifest).toMatchObject({ 客户数: 20001, 跟进数: 50001 });
  expect(manifest.分批).toHaveLength(11);
  const counts: Record<string, number> = { 客户: 0, 跟进: 0 };
  for (const part of manifest.分批) {
    const xlsx = unzipSync(files[part.文件]);
    const xml = strFromU8(xlsx["xl/worksheets/sheet1.xml"]);
    expect((xml.match(/<row\b/g)?.length ?? 0)-1).toBe(part.条数);
    expect(xml).toContain("客户编号");
    expect(xml).not.toContain("<f>");
    counts[part.类别] += part.条数;
  }
  expect(counts).toEqual({ 客户: 20001, 跟进: 50001 });
  expect(await page.evaluate(() => (window as unknown as { __ticks: number }).__ticks)).toBeGreaterThan(10);
  expect(await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap)).toBeLessThan(500);
  await page.close();
}, 120_000);
it.each(["hang", "change"])("导出%s时取消或校验失败，不生成部分下载包", async mode => {
  const page = await open(mode);
  page.setDefaultTimeout(5000);
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "完整导出", exact: true }).click();
  if (mode === "hang") {
    await page.getByRole("status").filter({ hasText: /核对导出范围/ }).waitFor();
    await page.getByRole("button", { name: "取消导出" }).click();
    await page.getByText("已取消导出", { exact: true }).waitFor();
  } else await page.getByText(/导出期间数据发生变化/).waitFor();
  expect(downloads).toBe(0);
  await page.close();
});
