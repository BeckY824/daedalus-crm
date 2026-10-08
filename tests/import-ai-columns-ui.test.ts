/**
 * 导入抽屉里「让 AI 认列」那一下（回归核对 L-076、J-057，2026-10-04）。
 *
 *   L-076 读完表就自动拿认不出的列的前 3 行原文去问 AI，抽屉上还写着「文件不上传」。
 *         违反「AI 不自动跑」：现在要人点一下才发，按钮旁边说清发的是什么。
 *   J-057 AI 的结果回来晚了，会把人已经看过预览的列对应悄悄换掉，落库和预览不一致。
 *         现在：结果回来时人已经去算预览 / 往下走了，就丢掉，并说一句。
 *
 * 做法同 tests/ai-settings-ui.test.ts：esbuild 打包真组件，在 Playwright 的 Chromium 里点；
 * server action（./ai、./import-actions）换成桩，桩把每次调用记在 window.__调用 里。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let 包 = "";

const 预览 = { 新建: 4, 补空: 0, 跳过: 0, 已在库里: 0, 说不清: 0, 进不了: 0, 合掉几行: 0, 待复核: [], 挡下: [], 没对上的列名: [] };

const 桩插件: Plugin = {
  name: "import-drawer-stubs",
  setup(b) {
    const 桩 = (filter: RegExp, contents: string) => {
      b.onResolve({ filter }, (a) => ({ path: a.path + "#" + a.importer, namespace: "stub", pluginData: contents }));
    };
    桩(/^\.\/ai$/, `
      const 记 = (名, 参) => (window.__调用[名] ||= []).push(参);
      export const 粘成表格 = (...参) => { 记("粘", 参); return window.__粘贴结果 ? Promise.resolve(window.__粘贴结果) : new Promise(() => {}); };
      // 认列的回答由用例自己决定什么时候回：把 resolve 存起来
      export const 猜列建议 = (...参) => { 记("猜列", 参); return new Promise((r) => window.__认列回.push(r)); };
      export const 导入认列状态 = () => Promise.resolve({ 能认列: window.__能认列, 本机: window.__本机 });
    `);
    桩(/^\.\/import-actions$/, `
      const 记 = (名, 参) => (window.__调用[名] ||= []).push(JSON.parse(JSON.stringify(参)));
      export const 预览导入 = (...参) => { 记("预览", 参); return Promise.resolve({ ok: true, 预览: window.__预览结果 ?? ${JSON.stringify(预览)} }); };
      export const 执行导入 = (...参) => { 记("执行", 参); return Promise.resolve({ ok: true, batchId: "b1", 新建: 4, 补空: 0, 跳过: 0, 进不了: 0 }); };
      export const 撤销批次 = () => Promise.resolve({ ok: true, 删掉: 0, 还原: 0, 没动: [] });
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
        import { AiMeterProvider, AiMeterBar } from "@/components/AiCost";
        window.__调用 = {};
        window.__认列回 = [];
        createRoot(document.getElementById("root")).render(
          React.createElement(App, null, React.createElement(AiMeterProvider, { 初值: window.__计次,
            children: React.createElement(React.Fragment, null, React.createElement(AiMeterBar), React.createElement(C, { open: true, onClose() {}, b: DEFAULT_BUSINESS, aiEnabled: true, onDone() {} })) }))
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

/** 第三列「备用栏」规则认不出来；四行数据，看发给 AI 的是不是只有前 3 行 */
const 表 = ["姓名,手机号,备用栏", "张三,13800000001,展会", "李四,13800000002,朋友介绍", "王五,13800000003,官网", "赵六,13800000004,展会"].join("\n");

async function 开(选项: { 能认列?: boolean; 本机?: boolean; 零额度?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://import-drawer.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><div id="root"></div>` }),
  );
  await page.goto("http://import-drawer.test/");
  await page.evaluate(({ 能认列, 本机, 零额度 }) => {
    const state = 零额度 ? { 计次: true, 还剩: 0, 上限: 30 } : { 计次: false, 还剩: null, 上限: null };
    Object.assign(window, { __能认列: 能认列, __本机: 本机, __计次: state, __余额: state });
    const original = window.fetch;
    window.fetch = async (...args) => String(args[0]).includes("/api/ai/meter") ? new Response(JSON.stringify((window as unknown as { __余额: unknown }).__余额)) : original(...args);
  }, { 能认列: 选项.能认列 ?? true, 本机: 选项.本机 ?? false, 零额度: 选项.零额度 ?? false });
  await page.addScriptTag({ content: 包 });
  await page.getByText("把 Excel 或 CSV 拖到这里").waitFor();
  return page;
}

async function 选文件(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({ name: "名单.csv", mimeType: "text/csv", buffer: Buffer.from(表) });
  await page.getByText(/读到了/).waitFor();
}

const 调用 = (page: Page, 名: string) =>
  page.evaluate((n) => ((window as unknown as { __调用: Record<string, unknown[]> }).__调用[n] ?? []) as unknown[][], 名);

it("零额度禁用真实整理按钮且不调用动作；余额刷新或自带Key恢复", async () => {
  const page = await 开({ 零额度: true });
  page.setDefaultTimeout(5000);
  await page.getByText("粘一段文本", { exact: true }).click();
  await page.getByRole("textbox").fill("赵一 13800000001");
  expect(await page.getByRole("button", { name: "AI 次数已用完" }).isDisabled()).toBe(true);
  expect(await 调用(page, "粘")).toHaveLength(0);
  await page.evaluate(() => Object.assign(window, { __余额: { 计次: true, 还剩: 2, 上限: 32 } }));
  await page.locator(".ant-drawer-body").getByRole("button", { name: "刷新余额", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "整理成表格" }).isEnabled()).toBe(true);
  await page.evaluate(() => { Object.assign(window, { __余额: { 计次: true, 还剩: 0, 上限: 32 } }); window.dispatchEvent(new Event("focus")); });
  await page.getByRole("button", { name: "AI 次数已用完" }).waitFor();
  await page.evaluate(() => Object.assign(window, { __余额: { 计次: false, 还剩: null, 上限: null } }));
  await page.locator(".ant-drawer-body").getByRole("button", { name: "刷新余额", exact: true }).click();
  await expect.poll(() => page.getByRole("button", { name: "整理成表格" }).isEnabled()).toBe(true);
  expect(await 调用(page, "粘")).toHaveLength(0);
  await page.close();
});

it("分批失败后再次整理把已完成批次传给续作，原文保留", async () => {
  const page = await 开();
  const 原文 = "赵一 13800000001";
  const 续作 = { 原文, 已完成: [{ 表头: ["姓名", "手机号"], 数据: [["赵一", "13800000001"]] }] };
  await page.evaluate((r) => Object.assign(window, { __粘贴结果: { ok: false, error: "第二批中断，已保留前1批", 续作: r } }), 续作);
  await page.getByText("粘一段文本", { exact: true }).click();
  await page.getByRole("textbox").fill(原文);
  await page.getByRole("button", { name: "整理成表格" }).click();
  await page.getByText("第二批中断，已保留前1批", { exact: true }).waitFor();
  expect(await page.getByRole("textbox").inputValue()).toBe(原文);
  await page.getByRole("button", { name: "整理成表格" }).click();
  await expect.poll(async () => (await 调用(page, "粘")).length).toBe(2);
  expect((await 调用(page, "粘"))[1]).toEqual([原文, 续作]);
  expect(await 调用(page, "执行")).toHaveLength(0);
  await page.close();
});

it("粘贴错配及微信遗漏可见，确认前不能预览或落库，重新整理要重新确认", async () => {
  const page = await 开();
  const 原文 = "赵一 13800000001 平川科技\n钱二 13800000002 长河教育\n孙三 微信 sunsan_88";
  const { 核对 } = await import("@/lib/import/paste");
  const result = 核对({ 表头: ["姓名", "手机号", "公司"], 数据: [["赵一", "13800000002", "平川科技"], ["钱二", "13800000001", "长河教育"]] }, 原文);
  await page.evaluate((r) => Object.assign(window, { __粘贴结果: { ok: true, ...r } }), result);
  await page.getByText("粘一段文本", { exact: true }).click();
  await page.getByRole("textbox").fill(原文);
  await page.getByRole("button", { name: "整理成表格" }).click();
  const panel = page.getByRole("region", { name: "粘贴原文复核" });
  await panel.waitFor();
  expect(await panel.getByText("关联待核对", { exact: true }).count()).toBe(2);
  await panel.getByText("展开未覆盖的原文（也可能是标题或说明）", { exact: true }).click();
  expect(await panel.innerText()).toContain("孙三 微信 sunsan_88");
  expect(await page.getByRole("button", { name: "下一步", exact: true }).isDisabled()).toBe(true);
  expect(await 调用(page, "预览")).toHaveLength(0);
  expect(await 调用(page, "执行")).toHaveLength(0);
  await panel.getByRole("checkbox").check();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect.poll(async () => (await 调用(page, "预览")).length).toBe(1);
  expect(await 调用(page, "执行")).toHaveLength(0);
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await page.getByRole("button", { name: "整理成表格" }).click();
  await panel.waitFor();
  expect(await panel.getByRole("checkbox").isChecked()).toBe(false);
  expect(await page.getByRole("button", { name: "下一步", exact: true }).isDisabled()).toBe(true);
  await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-J070-原文复核.png"), fullPage: true });
  await page.close();
});

describe("让 AI 认列：点了才发（L-076）", () => {
  it("读完表、停几秒：一次都不问 AI；点「让 AI 认一下」才问，只带认不出的那几列和前 3 行", async () => {
    const page = await 开();
    await 选文件(page);
    await page.waitForTimeout(2500);
    expect((await 调用(page, "猜列")).length, "读完表就自己去问 AI 了").toBe(0);

    const 按钮 = page.getByRole("button", { name: /让 AI 认一下/ });
    await 按钮.waitFor();
    // 按钮旁边一句实话：会发什么
    expect(await page.locator("body").innerText()).toMatch(/表头和前 3 行发给 AI/);
    await 按钮.click();
    await expect.poll(async () => (await 调用(page, "猜列")).length).toBe(1);
    const [表头, 样例, 规则] = (await 调用(page, "猜列"))[0] as [string[], string[][], (string | null)[]];
    expect(表头).toEqual(["姓名", "手机号", "备用栏"]);
    expect(样例).toHaveLength(3);
    // 规则认出来的列不问：只有第三列是空的
    expect(规则[0]).not.toBeNull();
    expect(规则[1]).toBe("phone");
    expect(规则[2]).toBeNull();

    // 回来了：填进那一列的下拉
    await page.evaluate(() => (window as unknown as { __认列回: ((v: unknown) => void)[] }).__认列回[0]({ c2: { 选: "school", 置信: 0.9 } }));
    await expect.poll(() => page.getByRole("row", { name: /^备用栏 / }).innerText()).toContain("公司");
    await page.close();
  });

  it("「导入时让 AI 认列」没开（默认）：没有按钮，也不问", async () => {
    const page = await 开({ 能认列: false });
    await 选文件(page);
    await page.waitForTimeout(1000);
    expect(await page.getByRole("button", { name: /让 AI 认一下/ }).count()).toBe(0);
    expect((await 调用(page, "猜列")).length).toBe(0);
    await page.close();
  });
});

describe("AI 认列回来晚了：不许改人已经看过预览的对应（J-057）", () => {
  it("点了认列、没等回来就去算预览：回来的结果丢掉，落库的映射和预览的一模一样", async () => {
    const page = await 开();
    await 选文件(page);
    await page.getByRole("button", { name: /让 AI 认一下/ }).click();
    await expect.poll(async () => (await 调用(page, "猜列")).length).toBe(1);

    await page.getByRole("button", { name: "下一步" }).click();
    await expect.poll(async () => (await 调用(page, "预览")).length).toBe(1);
    // 预览算完了才回来
    await page.evaluate(() => (window as unknown as { __认列回: ((v: unknown) => void)[] }).__认列回[0]({ c2: { 选: "school", 置信: 0.9 } }));
    await expect.poll(() => page.locator("body").innerText()).toMatch(/AI 认列的结果回来晚了/);

    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "开始导入" }).click();
    await expect.poll(async () => (await 调用(page, "执行")).length).toBe(1);
    const 预览映射 = ((await 调用(page, "预览"))[0][0] as { 映射: unknown[] }).映射;
    const 落库映射 = ((await 调用(page, "执行"))[0][0] as { 映射: unknown[] }).映射;
    expect(落库映射).toEqual(预览映射);
    expect(落库映射[2], "AI 后到的猜法人从没在预览里看过，不能进库").toBeNull();
    await page.close();
  });
});

describe("抽屉上说的是实情（L-076 / H-096）", () => {
  it("网页端不说「文件不上传」，说清内容会传到服务器", async () => {
    const page = await 开({ 本机: false });
    await expect.poll(() => page.locator("body").innerText()).toMatch(/传到服务器/);
    const 全文 = await page.locator("body").innerText();
    expect(全文).not.toMatch(/不上传/);
    await page.close();
  });

  it("桌面端本机：说写进这台电脑上的库", async () => {
    const page = await 开({ 本机: true });
    await expect.poll(() => page.locator("body").innerText()).toMatch(/这台电脑上的库/);
    expect(await page.locator("body").innerText()).not.toMatch(/不上传/);
    await page.close();
  });
});

it("J053/J055：真实文件上传如实提示截断和公式修复，不自动预览", async () => {
  const page = await 开();
  page.setDefaultTimeout(5000);
  await page.locator('input[type="file"]').setInputFiles(path.resolve("tests/fixtures/r2-data-公式.xlsx"));
  await page.getByText(/单元格 B3 的公式没有缓存结果/).waitFor();
  expect(await 调用(page, "预览")).toHaveLength(0);
  const headers = ["姓名", "手机号", ...Array.from({length: 49}, (_, i) => "额外" + i)];
  const row = ["张三", "13800000001", ...Array(49).fill("值")].join(",");
  const csv = headers.join(",") + "\n" + Array(10001).fill(row).join("\n");
  await page.locator('input[type="file"]').setInputFiles({ name: "超大.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByText(/原文件总行数未统计/).waitFor();
  const text = await page.locator("body").innerText();
  expect(text).toContain("原文件总列数未统计");
  expect(text).toContain("请拆成每份不超过 10000 条");
  expect(text).not.toMatch(/原表 \d+ [行列]/);
  await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-J053-大表提示.png"), fullPage: true });
  await page.close();
});

it("J050：确认步骤同时显示真实补空与跳过，允许切换处置", async () => {
  const page = await 开();
  page.setDefaultTimeout(5000);
  await page.evaluate(() => Object.assign(window, { __预览结果: { 新建: 0, 已在库里: 3, 可补空: 1, 补空: 0, 跳过: 3, 说不清: 0, 进不了: 0, 合掉几行: 0, 待复核: [], 挡下: [], 没对上的列名: [] } }));
  await 选文件(page);
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("radio", { name: /只补空着的字段/ }).check();
  await expect.poll(() => page.getByRole("radio", { name: /只补空着的字段/ }).isChecked()).toBe(true);
  await expect.poll(() => page.getByRole("button", { name: "开始导入" }).isEnabled()).toBe(true);
  await page.getByText("跳过（无需补空/不可修改）", { exact: true }).waitFor();
  expect(await page.getByText("补空字段", { exact: true }).locator("..").innerText()).toMatch(/1/);
  expect(await page.getByText("跳过（无需补空\/不可修改）", { exact: true }).locator("..").innerText()).toMatch(/2/);
  await page.screenshot({ path: path.resolve("../测试证据-2026-10-08/整改-J050-补空预览.png"), fullPage: true });
  await page.close();
});
