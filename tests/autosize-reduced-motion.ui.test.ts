/**
 * 开了「减弱动态效果」，自动长高的输入框（antd autoSize）第一次量也要量对。
 *
 * antd 量行高靠 body 底下一个隐藏 textarea：抄好字号、内边距，马上同步读 scrollHeight。
 * globals.css 那条减弱动态的全局规则给每个元素都挂了 transition: all 0.01ms，
 * 隐藏 textarea 也带着过渡，读到的是浏览器默认的 13.33px 字、2px 边距——两行的框量成 44px（该是 56px）。
 * 之后要等它碰巧再量一次才对，有时一直不量（Windows 上常见），订单详情的「记一笔」就矮一截。
 *
 * 用真浏览器 + 真 antd + globals.css 里原样的那段 @media，记下 antd 第一次写到框上的高度。
 * 另跑一份去掉修法的，确认这个坑在这套 antd 上真的在（不然上面那条绿了也说明不了什么）。
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const css = fs.readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8").replaceAll("\r\n", "\n"); // Windows 检出可能是 CRLF，下面按 \n 找
/** 文件最后那段全局的减弱动态规则（从注释那行起，到 @media 的右括号为止） */
function 减弱动态块() {
  const i = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {");
  expect(i).toBeGreaterThan(-1);
  let 深 = 0;
  for (let k = css.indexOf("{", i); k < css.length; k++) {
    if (css[k] === "{") 深++;
    else if (css[k] === "}" && --深 === 0) return css.slice(i, k + 1);
  }
  throw new Error("没找到 @media 的右括号");
}
const 修法 = /body > textarea\[name="hiddenTextarea"\] \{\s*transition: none !important;\s*\}/;

let browser: Browser; let bundle: string;
beforeAll(async () => {
  const r = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Input} from 'antd'; createRoot(document.getElementById('root')).render(<div style={{width:600}}><Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="记一笔" /></div>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  bundle = r.outputFiles[0].text; browser = await chromium.launch();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function 第一次量(规则: string) {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000);
  await page.route("http://autosize.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<meta charset='utf-8'><style>body{margin:0;font-size:14px}${规则}</style><div id='root'></div>` }));
  await page.goto("http://autosize.test");
  // antd 每次量完把 height 写进框的 style；只要第一次那个
  await page.addScriptTag({ content: `window.__高=[];new MutationObserver(()=>{const t=document.querySelector('#root textarea');const h=t&&t.style.height;if(h&&window.__高[window.__高.length-1]!==h)window.__高.push(h);}).observe(document.getElementById('root'),{subtree:true,attributes:true,childList:true});` });
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __高: string[] }).__高.length)).toBeGreaterThan(0);
  const r = await page.evaluate(() => {
    const t = document.querySelector("#root textarea") as HTMLTextAreaElement; const cs = getComputedStyle(t);
    const 两行 = 2 * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    return { 第一次: (window as unknown as { __高: string[] }).__高[0], 两行: `${两行}px` };
  });
  await ctx.close();
  return r;
}

it("减弱动态下 autoSize 第一次就量成两行高（隐藏的量高 textarea 不带过渡）", async () => {
  const 块 = 减弱动态块();
  expect(块).toMatch(修法);
  const 有 = await 第一次量(块);
  expect(有.第一次).toBe(有.两行);

  const 没有 = await 第一次量(块.replace(修法, ""));
  expect(没有.第一次).not.toBe(没有.两行);
});
