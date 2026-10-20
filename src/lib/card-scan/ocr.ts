/**
 * 扫名片（手机伴侣 /m，2026-10-19）：在手机浏览器里本地认名片，照片不出手机、认完就丢、不花钱、展馆没网也能认。
 *
 * 引擎：PaddleOCR PP-OCRv6 tiny 中英（官方浏览器 SDK @paddleocr/paddleocr-js + onnxruntime-web），检测边长 960。
 * 运行库和模型都在我们自己的 /ocr/v1/ 下（scripts/build-ocr.mjs 打的；模型随镜像发），不连外网 CDN。
 *
 * 流程（实测见 05-反馈与复盘/名片识别-实测-20261019/汇总.md 第 7 节）：
 *   1. 中英认一遍；整张平均置信度 < 0.8 多半是拍倒了 → 图转 180° 再认，取置信度高的那遍
 *   2. 自动：≥ 2 个低分框 / 假拉丁 / 日文写法才考虑换语言；按线索（文字体系、区号、域名、国家）挑一个，
 *      没下载过就当场下（只下一次），换了在低分框上还认不好（< 0.85）就不换，留给人点「名片语言」
 *   3. 人点了「名片语言」：直接用那个语言再认，两遍按框合并
 */
import { 拆字段, 统一, 低分框, 合并两遍, 低分框得分, 低分框线索, 像假拉丁, 四边形转框, type 框, type 字段 } from "./parse";

export type 名片语言 = "中英" | "日" | "韩" | "阿拉伯" | "泰" | "西里尔" | "天城";
export const 名片语言们: { k: 名片语言; 叫: string; 模型: string; MB: number }[] = [
  { k: "中英", 叫: "中英", 模型: "PP-OCRv6_tiny", MB: 0 },
  { k: "日", 叫: "日文", 模型: "PP-OCRv6_small", MB: 19 },
  { k: "韩", 叫: "韩文", 模型: "korean_PP-OCRv5_mobile", MB: 8 },
  { k: "阿拉伯", 叫: "阿拉伯文", 模型: "arabic_PP-OCRv5_mobile", MB: 7 },
  { k: "泰", 叫: "泰文", 模型: "th_PP-OCRv5_mobile", MB: 7 },
  { k: "西里尔", 叫: "俄文", 模型: "cyrillic_PP-OCRv5_mobile", MB: 7 },
  { k: "天城", 叫: "印地文", 模型: "devanagari_PP-OCRv5_mobile", MB: 7 },
];
const 语言表 = Object.fromEntries(名片语言们.map((x) => [x.k, x])) as Record<名片语言, (typeof 名片语言们)[number]>;

export type 进度 = (话: string) => void;
export type 识别结果 = { 字段: 字段; 语言: 名片语言; 平均分: number; 框数: number };

const 根 = "/ocr/v1";
type 引擎 = { 认: (img: Blob) => Promise<框[]>; 关: () => Promise<void> };

// 按 URL 动态加载，不让打包器碰它（10 MB 的 OpenCV + wasm，见 scripts/build-ocr.mjs）
const 载入 = (u: string) => (new Function("u", "return import(u)") as (u: string) => Promise<{ PaddleOCR: { create: (o: unknown) => Promise<unknown> } }>)(u);

/** 已经建好的引擎：中英那台一直留着；别的语言只留最近一台（每台一个 worker，各占几百 MB 内存，手机吃不消） */
const 引擎们 = new Map<名片语言, Promise<引擎>>();
/** 这次打开 App 期间下过 / 用过的语言（下一张没线索时先试它） */
let 最近语言: 名片语言 | null = null;

type 识别项 = { poly: { x: number; y: number }[] | number[][]; text: string; score: number };
type SDK实例 = { predict: (img: Blob, o: unknown) => Promise<{ items: 识别项[] }[]>; dispose: () => Promise<void> };

async function 建引擎(语言: 名片语言): Promise<引擎> {
  const { PaddleOCR } = await 载入(`${根}/paddle.js`);
  const 模型 = 语言表[语言].模型;
  // 跨源隔离的页面才能多线程（SharedArrayBuffer）；没有就单线程，慢一倍但照样能认
  const 线程 = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const ocr = (await PaddleOCR.create({
    textDetectionModelName: "PP-OCRv6_tiny_det",
    textDetectionModelAsset: { url: `${根}/models/PP-OCRv6_tiny_det.tar` },
    textRecognitionModelName: `${模型}_rec`,
    textRecognitionModelAsset: { url: `${根}/models/${模型}_rec.tar` },
    worker: true,
    ortOptions: { backend: "wasm", wasmPaths: `${根}/ort/`, numThreads: 线程, simd: true },
  })) as SDK实例;
  return {
    async 认(img) {
      const [r] = await ocr.predict(img, { textDetLimitSideLen: 960, textDetLimitType: "max" });
      return (r?.items ?? []).map((it) => 四边形转框(it.poly, it.text, it.score, 0));
    },
    关: () => ocr.dispose(),
  };
}

/**
 * 这台手机下过中英那套没有（paddle.js 10 MB + wasm 25 MB + 模型 6 MB，服务器在香港）。下过就在浏览器缓存里（/ocr/ 一年不过期），
 * 第一次那句进度话要说清楚多大、连 Wi-Fi，免得人以为卡住了。只是一句提示用的记号，读写不了（无痕、存储被禁）就当没下过
 */
const 下过键 = "m-ocr-v1-ready";
export const 第一次下载的话 = "第一次要下载约 40MB 识别文件，连 Wi-Fi 更快，下过一次之后没网也能认";
let 这次建好了 = false;
function 下过(): boolean {
  if (这次建好了) return true;
  try { return localStorage.getItem(下过键) === "1"; } catch { return false; }
}
function 记下下过(): void {
  这次建好了 = true;
  try { localStorage.setItem(下过键, "1"); } catch { /* 存不了就下次再提示一遍 */ }
}

function 取引擎(语言: 名片语言): Promise<引擎> {
  let p = 引擎们.get(语言);
  if (!p) {
    for (const [k, q] of 引擎们) {
      if (k !== "中英") { 引擎们.delete(k); void q.then((e) => e.关()).catch(() => undefined); }
    }
    p = 建引擎(语言);
    if (语言 === "中英") void p.then(记下下过, () => undefined);
    // 建失败（断网第一次下载、内存不够）别把坏的留着，下次再试
    p.catch(() => 引擎们.delete(语言));
    引擎们.set(语言, p);
  }
  return p;
}

/** 提前把中英那套载好（打开「扫名片」时就开始，拍照那几秒正好下完） */
export function 预热(): void {
  void 取引擎("中英").catch(() => undefined);
}

/** 手机照片 1200 万像素：先按 EXIF 摆正、缩到长边 1600 再认；转 180° 也在这里做 */
async function 缩图(file: Blob, 转180 = false): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d")!;
  if (转180) { g.translate(w, h); g.rotate(Math.PI); }
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("照片读不出来"))), "image/jpeg", 0.92));
}

const 平均 = (框们: 框[]) => (框们.length ? 框们.reduce((s, b) => s + b.score, 0) / 框们.length : 0);

/** 自动挑语言（汇总 7.3 的 ①+②）：不该换时回 null */
export function 该换的语言(一: 框[]): 名片语言 | null {
  const 低 = 低分框(一);
  const 假拉丁 = 一.filter((b) => 像假拉丁(统一(b.text)) >= 1).length >= 2;
  const 日文 = /(株式会社|有限会社|〒|丁目|携帯|営業|㈱)/.test(一.map((b) => b.text).join(""));
  if (!(低.length >= 2 || 假拉丁 || 日文)) return null;
  const 线索 = 拆字段(一).语言线索.find((l): l is 名片语言 => l in 语言表 && l !== "中英") ?? (低分框线索(一) as 名片语言 | null);
  return 线索 ?? (最近语言 && 最近语言 !== "中英" ? 最近语言 : null);
}

/**
 * 认一张名片。语言不给 = 自动；给了 = 人在「名片语言」里点的。
 * 照片只在这个函数里用，返回的只有文字
 */
export async function 认名片(file: Blob, 进: 进度, 指定?: 名片语言): Promise<识别结果> {
  // 点相机时已经在预热了（引擎们里有、但可能还在下），所以按「建好过没有」判断
  进(下过() ? "正在准备识别…" : 第一次下载的话);
  const 中英 = await 取引擎("中英");
  进("正在认名片…");
  let 图 = await 缩图(file);
  let 一 = await 中英.认(图);
  if (平均(一) < 0.8) {
    // 倒着拍的：转过来再认一遍，谁好用谁
    const 倒 = await 缩图(file, true);
    const 二 = await 中英.认(倒);
    if (平均(二) > 平均(一)) { 一 = 二; 图 = 倒; }
  }
  let 框们 = 一, 语言: 名片语言 = "中英";
  const 换 = 指定 && 指定 !== "中英" ? 指定 : 指定 ? null : 该换的语言(一);
  if (换) {
    const 第一次 = !引擎们.has(换);
    进(第一次 && 语言表[换].MB ? `正在下载${语言表[换].叫}识别（约 ${语言表[换].MB} MB，只下一次）…` : `正在按${语言表[换].叫}再认一遍…`);
    try {
      const 二 = await (await 取引擎(换)).认(图);
      // 自动换的：低分框上还认不好就不换（人点的照用）
      const 低 = 低分框(一);
      if (指定 || !低.length || 低分框得分(一, 二) >= 0.85) { 框们 = 合并两遍(一, 二); 语言 = 换; 最近语言 = 换; }
    } catch (e) {
      if (指定) throw e;
      // 自动换语言失败（没网下不了语言包）：先用中英的结果，人可以联网后再点
    }
  }
  return { 字段: 拆字段(框们), 语言, 平均分: 平均(框们), 框数: 框们.length };
}
