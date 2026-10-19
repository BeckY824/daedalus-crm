/**
 * 扫名片（手机伴侣 /m，2026-10-19）用的识别运行库：构建前从 node_modules 打成 public/ocr/v1/ 下的静态文件。
 *
 * 为什么不让 Next 打：官方浏览器 SDK `@paddleocr/paddleocr-js` 里带 10 MB 的 OpenCV.js、一个预打好的 worker
 * （`new URL("./assets/worker-entry-*.js", import.meta.url)`）、onnxruntime-web 的 wasm——交给 Turbopack 打
 * 不好控（拆块、wasm 路径、worker 路径都可能被改写），而这份东西只有点「扫名片」才用。这里用 esbuild 打成一个 ESM，
 * 页面上按 URL 动态 import；worker 和 wasm 原样拷过去。
 *
 * 产物不进仓库（.gitignore），模型文件 public/ocr/v1/models/*.tar 进仓库（不在 npm 上）。
 * v1 换版本时整个目录换名：next.config.ts 给 /ocr/ 下的文件一年缓存（展会上没网也能用）。
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const 根 = path.resolve(import.meta.dirname, "..");
const 出 = path.join(根, "public/ocr/v1");
const sdk = path.join(根, "node_modules/@paddleocr/paddleocr-js/dist");
const ort = path.join(根, "node_modules/onnxruntime-web/dist");

fs.mkdirSync(path.join(出, "assets"), { recursive: true });
fs.mkdirSync(path.join(出, "ort"), { recursive: true });

// SDK 主文件：OpenCV、clipper、js-yaml 打进来；onnxruntime-web 是 SDK 里懒加载的（只有不走 worker 才用），拆成单独一块
await build({
  entryPoints: { paddle: path.join(sdk, "index.mjs") },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: 出,
  minify: true,
  target: "es2022",
  platform: "browser",
  legalComments: "none",
  logLevel: "warning",
  // OpenCV.js 里有 node 分支的 require("fs") 之类，浏览器里走不到
  external: ["fs", "path", "crypto"],
});

// worker 是 SDK 预打好的（自带 OpenCV + onnxruntime），按它自己写死的相对路径放
for (const f of fs.readdirSync(path.join(sdk, "assets"))) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(sdk, "assets", f), path.join(出, "assets", f));
}
// worker 里的 onnxruntime 用的是 jsep 版（带 WebGPU 的那份）
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  fs.copyFileSync(path.join(ort, f), path.join(出, "ort", f));
}
console.log("ocr: public/ocr/v1 已生成");
