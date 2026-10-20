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
 *
 * 2026-10-20 用户在伦敦第一次下载「识别模型没下载下来」（服务器在香港，现压 gzip 只有约 90 KB/s，一串文件要三分钟，断一次就全白下）：
 *   - 主文件不再带 OpenCV：我们只用 worker 模式，主线程那份 10 MB 的 OpenCV 从来不用（worker 里自带一份）
 *   - 每个文件预先压好 .br / .gz（app/ocr-files 按 Accept-Encoding 直接给，带长度，浏览器能显示进度、断了能续）
 *   - 写一份 manifest.json：每种语言要哪几个文件、多大，客户端照着自己下（显示百分比、断了重试，见 lib/card-scan/download.ts）
 *
 * 同一天改成服务器识别为主（用户同意）：服务器上跑同一套 SDK + 模型，在 worker 线程里（lib/card-scan/server/worker.ts），
 * 这里顺手打成 ocr-server/worker.mjs（SDK、OpenCV、onnxruntime 都打进去；sharp 外置，standalone 里有），onnxruntime 的 Node 版 wasm 放旁边。
 * 不进仓库，Dockerfile 拷进运行镜像；模型照旧读 public/ocr/v1/models
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

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
  plugins: [不带主线程OpenCV()],
});

// worker 是 SDK 预打好的（自带 OpenCV + onnxruntime），按它自己写死的相对路径放
for (const f of fs.readdirSync(path.join(sdk, "assets"))) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(sdk, "assets", f), path.join(出, "assets", f));
}
// worker 里的 onnxruntime 用的是 jsep 版（带 WebGPU 的那份）
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  fs.copyFileSync(path.join(ort, f), path.join(出, "ort", f));
}
await 预压缩(出);
写清单(出);
await 打服务器识别();
console.log("ocr: public/ocr/v1、ocr-server 已生成");

/** 服务器识别的 worker：打成一个 ESM 文件，OpenCV.js 里用的 __dirname / require 补上 */
async function 打服务器识别() {
  const 服 = path.join(根, "ocr-server");
  fs.rmSync(服, { recursive: true, force: true });
  await build({
    entryPoints: { worker: path.join(根, "src/lib/card-scan/server/worker.ts") },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outdir: 服,
    outExtension: { ".js": ".mjs" },
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    external: ["sharp"],
    banner: {
      js: [
        'import { createRequire as __ocrRequire } from "node:module";',
        'import { fileURLToPath as __ocrPath } from "node:url";',
        "const require = __ocrRequire(import.meta.url);",
        "const __filename = __ocrPath(import.meta.url);",
        'const __dirname = __ocrPath(new URL(".", import.meta.url));',
      ].join(" "),
    },
  });
  // onnxruntime-web 的 Node 版按 import.meta.url 找这两个（不带 WebGPU 的那份）
  for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) fs.copyFileSync(path.join(ort, f), path.join(服, f));
}

/**
 * SDK 主文件里 `import cvModule from "@techstark/opencv-js"` 只给主线程模式用（OcrPipelineRunner.initialize → initOpenCvRuntime），
 * worker 模式（我们只用这个）直接走 WorkerBackedPaddleOCR，主线程从不碰它。换成一个一碰就报错的空壳，主文件 10 MB → 0.4 MB
 */
function 不带主线程OpenCV() {
  return {
    name: "no-main-thread-opencv",
    setup(b) {
      b.onResolve({ filter: /^@techstark\/opencv-js$/ }, () => ({ path: "opencv-stub", namespace: "ocr-stub" }));
      b.onLoad({ filter: /.*/, namespace: "ocr-stub" }, () => ({
        contents: `export default new Proxy({}, { get(_, k) { if (k === "then") return undefined; throw new Error("扫名片只走 worker：主线程没打 OpenCV"); } });`,
        loader: "js",
      }));
    },
  };
}

/** 能压的都预先压好 .br / .gz（省不到 5% 的不留，浏览器直接拿原文件）；js / wasm 用最高档，模型包压不动多少，用快档 */
async function 预压缩(目录) {
  const br = promisify(zlib.brotliCompress), gz = promisify(zlib.gzip);
  const 文件们 = 列文件(目录).filter((f) => /\.(js|mjs|wasm|tar)$/.test(f));
  await Promise.all(文件们.map(async (f) => {
    const 原 = fs.readFileSync(f);
    const 档 = f.endsWith(".tar") ? 9 : 11;
    const [b, g] = await Promise.all([
      br(原, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 档, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 原.length } }),
      gz(原, { level: 9 }),
    ]);
    for (const [后缀, 压] of [[".br", b], [".gz", g]]) {
      if (压.length < 原.length * 0.95) fs.writeFileSync(f + 后缀, 压);
      else fs.rmSync(f + 后缀, { force: true });
    }
  }));
}

/**
 * manifest.json：{ 文件: { 相对路径: [原大小, br 大小] }, 共用: [...] }。
 * 共用 = 不管哪种语言都要的（主文件、它的小块、worker、onnxruntime、检测模型）；每种语言再加自己的 models/<模型>_rec.tar。
 * 客户端按 br 大小（线上真正要传的）算进度
 */
function 写清单(目录) {
  const 文件 = {};
  for (const f of 列文件(目录)) {
    if (/\.(br|gz|map)$/.test(f) || f.endsWith("manifest.json")) continue;
    const 相对 = path.relative(目录, f).split(path.sep).join("/");
    const 原 = fs.statSync(f).size;
    文件[相对] = [原, fs.existsSync(f + ".br") ? fs.statSync(f + ".br").size : 原];
  }
  const 主文件块 = Object.keys(文件).filter((k) => /^chunk-[\w-]+\.js$/.test(k));
  const 共用 = [
    "paddle.js", ...主文件块,
    ...Object.keys(文件).filter((k) => k.startsWith("assets/worker-entry-")),
    "ort/ort-wasm-simd-threaded.jsep.mjs", "ort/ort-wasm-simd-threaded.jsep.wasm",
    "models/PP-OCRv6_tiny_det.tar",
  ];
  for (const k of 共用) if (!文件[k]) throw new Error(`ocr: manifest 里缺 ${k}`);
  fs.writeFileSync(path.join(目录, "manifest.json"), JSON.stringify({ 文件, 共用 }));
}

function 列文件(目录) {
  return fs.readdirSync(目录, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name));
}
