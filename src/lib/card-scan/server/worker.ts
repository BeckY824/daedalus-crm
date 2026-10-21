/**
 * 服务器认名片的 worker 线程（2026-10-20，用户同意「服务器识别为主、本机识别兜底」）。
 * 和手机上跑的是同一套：PaddleOCR 官方 SDK（onnxruntime-web 的 wasm、单线程）+ 同一份 PP-OCRv6 模型，所以认出来的框和字一样，
 * 字段解析照旧在手机上做（lib/card-scan/parse.ts）。
 *
 * 由 scripts/build-ocr.mjs 用 esbuild 打成 ocr-server/worker.mjs（SDK、OpenCV、onnxruntime 都打进去，sharp 外置：standalone 自带），
 * 池子（./pool.ts）按路径起线程。推理是同步的 wasm，放在线程里才不卡住整个服务。
 *
 * 照片只在内存里：收到 → sharp 解码成像素 → 认 → 丢，不落盘、不打日志
 */
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PaddleOCR } from "@paddleocr/paddleocr-js";
import * as ort from "onnxruntime-web";

type 设置 = { 模型目录: string };
type 活 = { id: number; 模型: string; 图: Uint8Array };
type 项 = { poly: unknown; text: string; score: number };
type SDK = {
  predict: (img: unknown, o: unknown) => Promise<{ items: 项[] }[]>;
  dispose: () => Promise<void>;
  initialize: () => Promise<unknown>;
  ensureServedFromHttp: () => void;
  sourceToMat: (cv: CV, src: unknown) => Promise<unknown>;
};
type CV = { Mat: new (h: number, w: number, t: number) => { data: Uint8Array; delete(): void }; CV_8UC4: number };

const { 模型目录 } = workerData as 设置;
// onnxruntime 载模型时会把每个没用上的权重都打一行警告，刷屏（会话级的日志等级默认是警告，SDK 建会话时不给，这里补上）
ort.env.logLevel = "error";
const 建会话 = ort.InferenceSession.create.bind(ort.InferenceSession) as (m: Uint8Array, o?: ort.InferenceSession.SessionOptions) => Promise<ort.InferenceSession>;
(ort.InferenceSession as { create: unknown }).create = (m: Uint8Array, o?: ort.InferenceSession.SessionOptions) => 建会话(m, { ...o, logSeverityLevel: 3 });
// 模型包从本地文件读（SDK 要 fetch，给它一个读文件的）
const 读文件 = (async (u: string | URL | Request) => {
  const 名 = path.basename(String(u));
  return new Response(await fs.promises.readFile(path.join(模型目录, 名)));
}) as typeof fetch;

/** 照片 → OpenCV 的 RGBA 图（和浏览器里 cv.imread(canvas) 一样的格式）。长边超过 1600 的缩下来（手机端本来就缩好了，防有人传大图） */
async function 照片转图(cv: CV, 图: unknown) {
  const { data, info } = await sharp(图 as Uint8Array, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC4);
  mat.data.set(data);
  return { width: info.width, height: info.height, mat, dispose: () => mat.delete() };
}

/** 中英那台一直留着；别的语言只留最近一台（每台几十 MB） */
const 引擎们 = new Map<string, Promise<SDK>>();
function 取引擎(模型: string): Promise<SDK> {
  let p = 引擎们.get(模型);
  if (p) return p;
  for (const [k, q] of 引擎们) {
    if (k !== "PP-OCRv6_tiny") { 引擎们.delete(k); void q.then((e) => e.dispose()).catch(() => undefined); }
  }
  p = (async () => {
    const e = (await PaddleOCR.create({
      textDetectionModelName: "PP-OCRv6_tiny_det",
      textDetectionModelAsset: { url: "PP-OCRv6_tiny_det.tar" },
      textRecognitionModelName: `${模型}_rec`,
      textRecognitionModelAsset: { url: `${模型}_rec.tar` },
      worker: false,
      initialize: false,
      fetch: 读文件,
      ortOptions: { backend: "wasm", numThreads: 1, simd: true },
    })) as unknown as SDK;
    e.ensureServedFromHttp = () => undefined;
    e.sourceToMat = 照片转图;
    await e.initialize();
    return e;
  })();
  p.catch(() => 引擎们.delete(模型));
  引擎们.set(模型, p);
  return p;
}

parentPort!.on("message", async (x: 活 | { 预热: true }) => {
  if ("预热" in x) { void 取引擎("PP-OCRv6_tiny").catch(() => undefined); return; }
  const 起 = performance.now();
  try {
    if (!/^[\w-]+$/.test(x.模型) || !fs.existsSync(path.join(模型目录, `${x.模型}_rec.tar`))) throw new Error("不认识的识别模型");
    const e = await 取引擎(x.模型);
    const [r] = await e.predict(x.图, { textDetLimitSideLen: 960, textDetLimitType: "max" });
    const items = (r?.items ?? []).map((it) => ({ poly: it.poly, text: it.text, score: it.score }));
    parentPort!.postMessage({ id: x.id, items, ms: Math.round(performance.now() - 起) });
  } catch (e) {
    parentPort!.postMessage({ id: x.id, 错: e instanceof Error ? e.message : String(e) });
  }
});
