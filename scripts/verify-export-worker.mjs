/** Run after next build: verify the actual Turbopack Worker bootstrap and downloaded ZIP. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";

const root = process.cwd();
const chunks = path.join(root, ".next/static/chunks");
let config;
for (const name of fs.readdirSync(chunks)) {
  if (!name.endsWith(".js")) continue;
  const source = fs.readFileSync(path.join(chunks, name), "utf8");
  if (!source.includes("导出等待超时")) continue;
  const match = /default\("(static\/chunks\/turbopack-worker-[^"]+)",(\[[^\]]+\])\)/.exec(source);
  if (match) config = { entry: match[1], chunks: JSON.parse(match[2]) };
}
if (!config) throw new Error("Build the application first; export Worker bootstrap was not found");
const bundle = await build({ stdin: { contents: "import { DEFAULT_BUSINESS } from '@/lib/business-config'; window.__business=DEFAULT_BUSINESS", resolveDir: root }, bundle: true, write: false, alias: { "@": path.join(root, "src") }, logLevel: "silent" });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", m => console.log("browser", m.type(), m.text()));
  page.on("pageerror", e => console.log("pageerror", e.message));
  page.on("requestfailed", r => console.log("requestfailed", r.url(), r.failure()?.errorText));
  await page.route("http://worker-build.test/**", r => {
    const pathname = new URL(r.request().url()).pathname;
    if (pathname === "/") return r.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><title>Worker build verification</title>' });
    if (!pathname.startsWith("/_next/static/") || pathname.includes("..")) { console.log("rejected asset",pathname); return r.abort(); }
    return r.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.join(root, ".next", pathname.slice("/_next/".length))) });
  });
  await page.goto("http://worker-build.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const bytes = await page.evaluate(async ({ entry, chunks }) => {
    const params = [chunks.map(p => "/_next/"+p).reverse(), "", "/_next/", null, null];
    const worker = new Worker("/_next/"+entry+"#params="+encodeURIComponent(JSON.stringify(params)));
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Built Worker timed out")), 15000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        let step = 0;
        worker.onmessage = event => {
          if (!event.data.ok) { clearTimeout(timer); return reject(new Error(event.data.error)); }
          if (step++ === 0) worker.postMessage({ 动作: "完成", 清单: { 客户数: 1, 跟进数: 0 } });
          else { clearTimeout(timer); resolve(Array.from(event.data.bytes)); }
        };
        worker.postMessage({ 动作: "分批", b: window.__business, 批次: { 类别: "客户", rows: [{ id: "built-worker-customer", name: "生产构建验证", phone: "+8613800000001", school: null, major: null, grade: null, followStatus: "待跟进", decisionStatus: "待定", expectedSignAt: null, signedAmount: 0, salesOwnerName: "测试", remark: "=safe text" }] } });
      });
    } finally { worker.terminate(); }
  }, config);
  const files = unzipSync(new Uint8Array(bytes));
  const manifest = JSON.parse(strFromU8(files["导出清单.json"]));
  if (manifest.客户数 !== 1 || manifest.分批?.[0]?.条数 !== 1) throw new Error("Incorrect built Worker manifest");
  const inner = unzipSync(files[manifest.分批[0].文件]);
  if (!strFromU8(inner["xl/worksheets/sheet1.xml"]).includes("built-worker-customer")) throw new Error("Built Worker lost the stable customer ID");
  console.log("PASS: actual Next/Turbopack Worker bootstrap, XLSX and ZIP manifest");
} finally { await browser.close(); }
