/**
 * 一次导上万条、带进度（2026-10-21 用户放行）。导入抽屉这一头：
 *   - 表分块交给服务端暂存，每块都在 server action 的 1 MB 以内，拼回去和原表一样
 *   - 一段一段写，进度条跟着走；写完到「完成」
 *   - 断了（连不上后台）：自己重试两次，还不行停下，说清写到哪、已经进去多少；「接着导」带同一批从断处往下
 *   - 服务端说暂存没了（软件重启过）：自己把表重新送一遍，人感觉不到
 *   - 检查那一步出错不再弹英文
 *
 * 做法同 tests/import-ai-columns-ui.test.ts：esbuild 打包真组件，server action 换成桩
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let 包 = "";

const 桩插件: Plugin = {
  name: "import-progress-stubs",
  setup(b) {
    const 桩 = (filter: RegExp, contents: string) => {
      b.onResolve({ filter }, (a) => ({ path: a.path + "#" + a.importer, namespace: "stub", pluginData: contents }));
    };
    桩(/^\.\/ai$/, `
      export const 粘成表格 = () => new Promise(() => {});
      export const 猜列建议 = () => new Promise(() => {});
      export const 导入认列状态 = () => Promise.resolve({ 能认列: false, 本机: true });
    `);
    桩(/^\.\/import-actions$/, `
      const 记 = (名, 参) => (window.__调用[名] ||= []).push(JSON.parse(JSON.stringify(参)));
      export const 暂存导入表 = async (...参) => { 记("暂存", 参); window.__块大小.push(new Blob([JSON.stringify(参)]).size); return { ok: true, 收到: 参[1].起 + 参[1].数据.length }; };
      export const 预览导入 = async (...参) => { 记("预览", 参); if (window.__预览错) throw new Error(window.__预览错); return { ok: true, 预览: { 新建: window.__共, 补空: 0, 跳过: 0, 已在库里: 0, 说不清: 0, 进不了: 0, 合掉几行: 0, 待复核: [], 挡下: [], 没对上的列名: [] } }; };
      export const 分段导入 = async (...参) => { 记("执行", 参); return window.__分段(参); };
      export const 执行导入 = () => Promise.reject(new Error("抽屉不该再调它"));
      export const 撤销批次 = async (...参) => { 记("撤销", 参); return { ok: true, 删掉: 1000, 还原: 0, 没动: [] }; };
    `);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.pluginData as string, loader: "jsx", resolveDir: process.cwd() }));
  },
};

beforeAll(async () => {
  const r = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { App } from "antd";
        import { DEFAULT_BUSINESS } from "@/lib/business-config";
        import C from "@/app/(app)/customers/ImportDrawer";
        window.__调用 = {};
        window.__块大小 = [];
        createRoot(document.getElementById("root")).render(
          React.createElement(App, null, React.createElement(C, { open: true, onClose() {}, b: DEFAULT_BUSINESS, aiEnabled: false, onDone() {} }))
        );
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [桩插件],
    logLevel: "silent",
  });
  包 = r.outputFiles[0].text;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

const 共 = 3000;
/** 9 列、带中文的表，约 3000 行：整张远超 1 MB 的一半，分块才能送 */
const 表 = [
  "姓名,手机号,公司,职位,邮箱,城市,行业,来源,备注",
  ...Array.from({ length: 共 }, (_, i) =>
    `客户${i},139${String(i).padStart(8, "0")},上海浦东新区张江高科技园区智慧照明工程有限公司${i},采购部经理,buyer${i}@example.com,上海,照明灯具,展会,第${i}位客户的备注：要样品、要报价单、要看工厂`),
].join("\n");

/** 默认的分段桩：每段写 1000 条，停一会儿好让进度条看得见 */
const 默认分段 = `async ([, , 续]) => {
  await new Promise((r) => setTimeout(r, 400));
  const 下 = Math.min(续.起 + 1000, ${共});
  return { ok: true, batchId: "b1", 新建: 下, 补空: 0, 跳过: 0, 进不了: 0, 下一个: 下 >= ${共} ? null : 下, 共: ${共} };
}`;

async function 开(分段 = 默认分段): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.route("http://import-progress.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><div id="root"></div>` }),
  );
  await page.goto("http://import-progress.test/");
  await page.evaluate(`window.__共 = ${共}; window.__分段 = ${分段};`);
  await page.addScriptTag({ content: 包 });
  await page.getByText("把 Excel 或 CSV 拖到这里").waitFor();
  await page.locator('input[type="file"]').setInputFiles({ name: "一万条.csv", mimeType: "text/csv", buffer: Buffer.from(表) });
  await page.getByText(/读到了/).waitFor();
  return page;
}

const 调用 = (page: Page, 名: string) =>
  page.evaluate((n) => ((window as unknown as { __调用: Record<string, unknown[][]> }).__调用[n] ?? []), 名);

async function 走到开始导入(page: Page) {
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "开始导入" }).click();
}

it("表分块暂存（每块 1 MB 以内、拼回去一样），一段一段写、进度跟着走，写完到完成", async () => {
  const page = await 开();
  await 走到开始导入(page);
  await page.getByText("已处理 1,000 / 3,000 条", { exact: false }).waitFor();
  // 写的时候只剩一颗转圈的按钮，没有「上一步」
  expect(await page.locator(".ant-drawer-footer button").count()).toBe(1);
  expect(await page.locator(".ant-drawer-footer button").getAttribute("class")).toContain("ant-btn-loading");
  await page.getByText("导完了").waitFor();

  const 暂存 = (await 调用(page, "暂存")) as [string, { 起: number; 数据: string[][]; 行号?: number[] }, { 表头: string[]; 共: number } | undefined][];
  expect(暂存.length).toBeGreaterThan(1);
  expect(new Set(暂存.map((x) => x[0])).size).toBe(1);
  expect(暂存[0][2]).toEqual({ 表头: 表.split("\n")[0].split(","), 共 });
  expect(暂存.flatMap((x) => x[1].数据)).toEqual(表.split("\n").slice(1).map((l) => l.split(",")));
  expect(暂存.flatMap((x) => x[1].行号 ?? [])).toHaveLength(共);
  for (const n of await page.evaluate(() => (window as unknown as { __块大小: number[] }).__块大小)) expect(n).toBeLessThan(1024 * 1024 * 0.6);

  // 预览、落库只带暂存号，不再带整张表
  const 预览 = (await 调用(page, "预览"))[0][0] as { 暂存: string; 数据: unknown[] };
  expect(预览.暂存).toBe(暂存[0][0]);
  expect(预览.数据).toEqual([]);
  const 执行 = (await 调用(page, "执行")) as [unknown, string, { batchId?: string; 起: number }][];
  expect(执行.map((x) => x[2])).toEqual([{ 起: 0 }, { batchId: "b1", 起: 1000 }, { batchId: "b1", 起: 2000 }]);
  await page.close();
}, 60_000);

it("连不上后台：重试两次后停下说清写到哪；接着导从断处、同一批往下", async () => {
  const page = await 开(`async ([, , 续]) => {
    if (续.起 === 1000 && window.__断 > 0) { window.__断--; throw new TypeError("Failed to fetch"); }
    const 下 = Math.min(续.起 + 1000, ${共});
    return { ok: true, batchId: "b1", 新建: 下, 补空: 0, 跳过: 0, 进不了: 0, 下一个: 下 >= ${共} ? null : 下, 共: ${共} };
  }`);
  await page.evaluate(() => Object.assign(window, { __断: 3 }));
  await 走到开始导入(page);
  await page.getByText("导到第 1,000 / 3,000 条时停下了").waitFor({ timeout: 15_000 });
  const 提示 = await page.getByRole("alert").innerText();
  expect(提示).toContain("连不上软件的后台服务");
  expect(提示).toContain("已经导进去的 1,000 条新建");
  expect(提示).not.toMatch(/fetch|Error/i);
  expect(await 调用(page, "执行")).toHaveLength(4);
  // 断了之后不让退回去改了再导一份
  expect(await page.getByRole("button", { name: "上一步" }).count()).toBe(0);
  await page.getByRole("button", { name: "撤销已导入的" }).waitFor();

  await page.getByRole("button", { name: "接着导" }).click();
  await page.getByText("导完了").waitFor();
  const 执行 = (await 调用(page, "执行")) as [unknown, string, { batchId?: string; 起: number }][];
  expect(执行.slice(4).map((x) => x[2])).toEqual([{ batchId: "b1", 起: 1000 }, { batchId: "b1", 起: 2000 }]);
  // 同一份表没换：不重新送
  expect(new Set(((await 调用(page, "暂存")) as [string][]).map((x) => x[0])).size).toBe(1);
  await page.close();
}, 60_000);

it("断了选撤销：撤的是已经写进去的那一批", async () => {
  const page = await 开(`async ([, , 续]) => {
    if (续.起 === 1000) return { ok: false, error: "这一批已经撤销了，不能再接着导；要导请重新开始" };
    return { ok: true, batchId: "b9", 新建: 1000, 补空: 0, 跳过: 0, 进不了: 0, 下一个: 1000, 共: ${共} };
  }`);
  await 走到开始导入(page);
  await page.getByText("导到第 1,000 / 3,000 条时停下了").waitFor();
  await page.getByRole("button", { name: "撤销已导入的" }).click();
  await page.getByRole("button", { name: /^撤\s*销$/ }).click();
  await page.locator(".ant-modal-confirm-title", { hasText: "已撤销这一批" }).waitFor();
  expect(await 调用(page, "撤销")).toEqual([["b9"]]);
  await page.close();
}, 60_000);

it("服务端说暂存没了（软件重启过）：自己重新送一遍表再接着写", async () => {
  const page = await 开(`async ([方案, , 续]) => {
    if (!window.__送过 && 续.起 === 1000) { window.__送过 = 方案.暂存; return { ok: false, error: "这份表要重新交给软件一次", 重送: true }; }
    const 下 = Math.min(续.起 + 1000, ${共});
    return { ok: true, batchId: "b1", 新建: 下, 补空: 0, 跳过: 0, 进不了: 0, 下一个: 下 >= ${共} ? null : 下, 共: ${共} };
  }`);
  await 走到开始导入(page);
  await page.getByText("导完了").waitFor();
  const 号们 = ((await 调用(page, "暂存")) as [string][]).map((x) => x[0]);
  expect(new Set(号们).size).toBe(2);
  const 执行 = (await 调用(page, "执行")) as [{ 暂存: string }, string, { batchId?: string; 起: number }][];
  expect(执行.at(-1)![0].暂存).toBe(号们.at(-1));
  expect(执行.map((x) => x[2].起)).toEqual([0, 1000, 1000, 2000]);
  await page.close();
}, 60_000);

it("检查那一步后台出错：说人话，不弹英文", async () => {
  const page = await 开();
  await page.evaluate(() => Object.assign(window, { __预览错: "Minified React error #441; visit https://react.dev/errors/441" }));
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("没检查完：后台服务出了错，没有回话。库里什么都没动，点「下一步」再试一次").waitFor();
  await page.close();
}, 60_000);
