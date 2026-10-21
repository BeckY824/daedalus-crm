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
import { 下载齐, 下载中断, type 要下的 } from "./download";
import { 服务器认, 服务器预热, 服务器不认, 服务器整理, 能用服务器, 等预热 } from "./cloud";
import { 名片行们, 验AI回答, 合AI, type AI附加 } from "./ai";
import { 名片语言们, 语言表, type 名片语言 } from "./langs";
export { 名片语言们, type 名片语言 };

/** 百分 = 下载进度 0–100，只有在下识别文件时给 */
export type 进度 = (话: string, 百分?: number) => void;
/** 框们：认出的文字框（只有文字和位置，照片不在里面），给 AI 整理用，表单关了就没了 */
export type 识别结果 = { 字段: 字段; 语言: 名片语言; 平均分: number; 框数: number; 框们: 框[] };

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

/**
 * build-ocr.mjs 写的清单：每个文件 [原大小, 线上大小]，共用 = 哪种语言都要的那几个。
 * 每次都问一下服务器（no-cache，没变回 304）；拿不到（断网、老服务器没有）就不自己下，让 SDK 直接载（缓存里有就能用）
 */
type 清单 = { 文件: Record<string, [number, number]>; 共用: string[] };
let 清单在取: Promise<清单 | null> | null = null;
function 取清单(): Promise<清单 | null> {
  清单在取 ??= fetch(`${根}/manifest.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? (r.json() as Promise<清单>) : null))
    .catch(() => null)
    .then((x) => { if (!x) 清单在取 = null; return x; });
  return 清单在取;
}

/** 这台引擎要的文件：共用的 + 这种语言的识别模型包 */
function 要的文件(单: 清单, 语言: 名片语言): 要下的[] {
  return [...单.共用, `models/${语言表[语言].模型}_rec.tar`]
    .filter((k) => 单.文件[k])
    .map((k) => ({ url: `${根}/${k}`, 原: 单.文件[k][0], 传: 单.文件[k][1] }));
}

/** 正在下的进度（预热时就开始下，认名片时接着报给页面） */
type 下载进度 = { 已: number; 总: number };
const 下载们 = new Map<名片语言, 下载进度>();
const 听下载 = new Set<() => void>();
function 报下载(语言: 名片语言, 已: number, 总: number) {
  下载们.set(语言, { 已, 总 });
  for (const f of 听下载) f();
}

async function 建引擎(语言: 名片语言): Promise<引擎> {
  const 单 = await 取清单();
  if (单) {
    try {
      await 下载齐(要的文件(单, 语言), { 进: (已, 总) => 报下载(语言, 已, 总) });
    } finally {
      下载们.delete(语言);
    }
  }
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
 * 这台手机下过中英那套没有（预压缩后约 12 MB：worker 2.6 + wasm 3.3 + 模型 5.7，服务器在香港）。下过就在浏览器缓存里（/ocr/ 一年不过期），
 * 第一次那句进度话要说清楚多大、连 Wi-Fi，免得人以为卡住了。只是一句提示用的记号，读写不了（无痕、存储被禁）就当没下过
 */
const 下过键 = "m-ocr-v1-ready";
export const 第一次下载的话 = (MB: number) => `第一次要下载约 ${MB}MB 识别文件，连 Wi-Fi 更快，下过一次之后没网也能认`;
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

/**
 * 等某种语言的引擎建好，下载期间把进度报给页面。
 * 预热那次是在相机盖着（页面在后台）时下的，断了会是 下载中断：人现在回到页面了，就接着下，不让他再点一次
 */
async function 等引擎(语言: 名片语言, 进: 进度, 话: (MB: number) => string): Promise<引擎> {
  const 报 = () => {
    const d = 下载们.get(语言);
    if (d && d.总) 进(话(Math.max(1, Math.round(d.总 / 1024 / 1024))), Math.floor((d.已 / d.总) * 100));
  };
  听下载.add(报);
  报();
  try {
    try {
      return await 取引擎(语言);
    } catch (e) {
      if (e instanceof 下载中断 && typeof document !== "undefined" && !document.hidden) return await 取引擎(语言);
      throw e;
    }
  } finally {
    听下载.delete(报);
  }
}

/**
 * 打开「扫名片」时就开始准备，拍照那几秒正好备好：
 * 本机下过识别文件的照旧本机认，先把引擎载好；没下过、服务器能用的叫服务器起好线程（不下 12 MB）；服务器不给用就照旧先下本机的
 */
export function 预热(): void {
  if (!下过() && 能用服务器()) {
    void 服务器预热().then((能) => { if (!能 && !能用服务器()) void 取引擎("中英").catch(() => undefined); });
    return;
  }
  void 取引擎("中英").catch(() => undefined);
}

/**
 * 按 EXIF 摆正读进来。老内核不认 imageOrientation: "from-image"（10-20 模拟器：夸克 10.19 是 Chrome 100，直接报错、名片认不了），
 * 退回 <img>（Chrome 81 起 <img> 默认按 EXIF 摆正）
 */
async function 读图(file: Blob): Promise<{ 图: CanvasImageSource; 宽: number; 高: number; 关: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { 图: bmp, 宽: bmp.width, 高: bmp.height, 关: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { 图: img, 宽: img.naturalWidth, 高: img.naturalHeight, 关: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

/** 手机照片 1200 万像素：先按 EXIF 摆正、缩到长边 1600 再认；转 180° 也在这里做。传服务器的压狠一点（几百 KB，慢网也几秒传完） */
async function 缩图(file: Blob, 转180 = false, 质量 = 0.92): Promise<Blob> {
  const { 图, 宽, 高, 关 } = await 读图(file);
  const k = Math.min(1, 1600 / Math.max(宽, 高));
  const w = Math.round(宽 * k), h = Math.round(高 * k);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d")!;
  if (转180) { g.translate(w, h); g.rotate(Math.PI); }
  g.drawImage(图, 0, 0, w, h);
  关();
  return new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("照片读不出来"))), "image/jpeg", 质量));
}

const 平均 = (框们: 框[]) => (框们.length ? 框们.reduce((s, b) => s + b.score, 0) / 框们.length : 0);

/** 没线索时服务器上盲试的语言：认成拉丁乱码、靠线索分不出来的这几种（韩文有「生僻汉字」、俄文有假拉丁、日文有写法，不用盲试） */
const 盲试语言: 名片语言[] = ["阿拉伯", "泰", "天城"];

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
  // 点相机时已经在预热了（引擎们里有、但可能还在下），所以按「建好过没有」判断；在下的时候带上百分比
  const 第一次 = !下过();
  进("正在准备识别…");
  // 本机下过识别文件的照旧本机认（不用传照片）；没下过的先交给服务器，服务器不行这一张就改在手机上认
  if (第一次) await 等预热();
  let 云 = 第一次 && 能用服务器();
  const 中英话 = (MB: number) => (第一次 ? 第一次下载的话(MB) : "正在准备识别…");
  /** 认一遍：服务器能用先服务器；服务器不认（不给用、排太久、断了）就在手机上认（第一次要下识别文件，带百分比） */
  const 认一遍 = async (图: Blob, 语言: 名片语言, 下载话: (MB: number) => string): Promise<框[]> => {
    if (云) {
      try {
        const 项们 = await 服务器认(图, 语言, (前面) => 进(前面 > 0 ? `排队中，前面还有 ${前面} 张…` : "正在认名片…"));
        return 项们.map((it) => 四边形转框(it.poly, it.text, it.score, 0));
      } catch (e) {
        if (!(e instanceof 服务器不认)) throw e;
        云 = false;
      }
    }
    const 引擎 = await 等引擎(语言, 进, 下载话);
    进("正在认名片…");
    return 引擎.认(图);
  };
  // 本机认：下过的从浏览器缓存里过一遍，一下就到 100%，不说「下载」
  if (!云) await 等引擎("中英", 进, 中英话);
  进("正在认名片…");
  const 质量 = 云 ? 0.85 : 0.92;
  let 图 = await 缩图(file, false, 质量);
  let 一 = await 认一遍(图, "中英", 中英话);
  if (平均(一) < 0.8) {
    // 倒着拍的：转过来再认一遍，谁好用谁
    const 倒 = await 缩图(file, true, 质量);
    const 二 = await 认一遍(倒, "中英", 中英话);
    if (平均(二) > 平均(一)) { 一 = 二; 图 = 倒; }
  }
  let 框们 = 一, 语言: 名片语言 = "中英";
  const 换 = 指定 && 指定 !== "中英" ? 指定 : 指定 ? null : 该换的语言(一);
  // 有认不好的框、却看不出是哪种语言（阿拉伯 / 泰 / 印地文被认成拉丁乱码，10-20 阿曼真名片）：
  // 服务器上认一遍不到 1 秒、不用下载，几种都试一下，低分框上认得最好、够 0.85 的就用它。手机上认的不盲试（每种要先下 7 MB）
  if (!换 && !指定 && 云 && 低分框(一).length >= 2) {
    let 最好: { k: 名片语言; 分: number; 框们: 框[] } | null = null;
    for (const k of 盲试语言) {
      进(`正在按${语言表[k].叫}试认…`);
      try {
        const 二 = await 服务器认(图, k, () => undefined);
        const 分 = 低分框得分(一, 二.map((it) => 四边形转框(it.poly, it.text, it.score, 0)));
        if (分 >= 0.85 && (!最好 || 分 > 最好.分)) 最好 = { k, 分, 框们: 二.map((it) => 四边形转框(it.poly, it.text, it.score, 0)) };
      } catch { break; }
    }
    if (最好) { 最近语言 = 最好.k; 进("正在认名片…"); const 合 = 合并两遍(一, 最好.框们); return { 字段: 拆字段(合), 语言: 最好.k, 平均分: 平均(最好.框们), 框数: 最好.框们.length, 框们: 合 }; }
  }
  if (换) {
    const 要下 = !云 && !引擎们.has(换) && 语言表[换].MB;
    进(要下 ? `正在下载${语言表[换].叫}识别（约 ${语言表[换].MB} MB，只下一次）…` : `正在按${语言表[换].叫}再认一遍…`);
    try {
      const 二 = await 认一遍(图, 换, () => `正在下载${语言表[换].叫}识别（约 ${语言表[换].MB} MB，只下一次）…`);
      // 自动换的：低分框上还认不好就不换（人点的照用）
      const 低 = 低分框(一);
      if (指定 || !低.length || 低分框得分(一, 二) >= 0.85) { 框们 = 合并两遍(一, 二); 语言 = 换; 最近语言 = 换; }
    } catch (e) {
      if (指定) throw e;
      // 自动换语言失败（没网下不了语言包）：先用中英的结果，人可以联网后再点
    }
  }
  return { 字段: 拆字段(框们), 语言, 平均分: 平均(框们), 框数: 框们.length, 框们 };
}

/**
 * 团队版认完再请服务器上的模型摆一下格子、翻译外文（2026-10-20 用户定「用 AI，免费不扣次数」，lib/card-scan/ai.ts）。
 * 只传认出的文字，不传照片。不是团队版、服务器没配模型、超时、回的不对 → null，用规则拆的
 */
export async function AI整理(r: 识别结果, 行业们: readonly string[]): Promise<{ 字段: 字段; 附加: AI附加 } | null> {
  if (!r.框们.length) return null;
  const 行们 = 名片行们(r.框们);
  const 答 = 验AI回答(await 服务器整理(行们, 行业们), 行们.length, 行业们);
  return 答 ? 合AI(r.字段, r.框们, 答) : null;
}
