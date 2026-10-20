/**
 * 服务器认名片（手机这头，2026-10-20 用户同意「服务器识别为主、本机识别兜底」）。接口见 app/api/mobile/scan/route.ts。
 *
 * 手机把压好的照片（长边 1600、几百 KB）传上去，服务器用同一套 PaddleOCR 认出框和字，字段照旧在手机上拆（parse.ts）。
 * 服务器不行（不是团队版 / 自部署没有这个接口、排队太久、超次数、坏了、没网）就抛 服务器不认，认名片改在手机上认（ocr.ts）。
 *
 * 这个文件要轻：MobileApp 一打开就 import 它来设令牌，识别那一大套（ocr.ts）还是点了扫名片才载
 */
import type { 名片语言 } from "./langs";

export type 服务器识别项 = { poly: { x: number; y: number }[] | number[][]; text: string; score: number };

/** 服务器这次认不了：认名片接着在手机上认（不是给人看的错） */
export class 服务器不认 extends Error {
  constructor(readonly 原因: "没开" | "忙" | "坏" | "断网") {
    super(`服务器识别不可用：${原因}`);
    this.name = "服务器不认";
  }
}

let 令牌: string | null = null;
/** 这次打开期间服务器不给用（自部署没有接口、不是团队版、令牌失效）：不再每张都去问 */
let 停用 = false;

/** MobileApp 登录 / 退出时设 */
export function 设识别令牌(t: string | null): void {
  if (t !== 令牌) 停用 = false;
  令牌 = t;
}

export function 能用服务器(): boolean {
  return Boolean(令牌) && !停用 && (typeof navigator === "undefined" || navigator.onLine !== false);
}

const 不给用 = (status: number) => status === 401 || status === 403 || status === 404;

let 在问: Promise<boolean> | null = null;

/** 打开扫名片时先叫一声：服务器把识别线程起好；不给用就记下，回 false（调用方改成预热本机识别） */
export function 服务器预热(抓: typeof fetch = fetch): Promise<boolean> {
  if (!能用服务器()) return Promise.resolve(false);
  在问 ??= (async () => {
    try {
      const r = await 抓("/api/mobile/scan", { headers: { Authorization: `Bearer ${令牌}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (不给用(r.status)) 停用 = true;
      return r.ok;
    } catch {
      return false;
    } finally {
      在问 = null;
    }
  })();
  return 在问;
}

/** 预热还在问的话等它问完（拍得快的：别在知道服务器给不给用之前就把照片传上去） */
export async function 等预热(): Promise<void> {
  if (在问) await 在问;
}

/**
 * 认一遍。排队时每变一次位置调 排队(前面还有几张)，轮到了调 排队(0)。
 * 整个过程超过 总毫秒（默认 45 秒：上传 + 排队最多 20 秒 + 认）就算服务器不行
 */
export async function 服务器认(
  图: Blob,
  语言: 名片语言,
  排队: (前面: number) => void,
  设: { 抓?: typeof fetch; 总毫秒?: number } = {},
): Promise<服务器识别项[]> {
  const { 抓 = fetch, 总毫秒 = 45_000 } = 设;
  if (!能用服务器()) throw new 服务器不认("没开");
  let r: Response;
  const 停 = AbortSignal.timeout(总毫秒);
  try {
    r = await 抓(`/api/mobile/scan?lang=${encodeURIComponent(语言)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${令牌}`, "Content-Type": 图.type || "image/jpeg" },
      body: 图,
      signal: 停,
    });
  } catch {
    throw new 服务器不认("断网");
  }
  if (不给用(r.status)) { 停用 = true; throw new 服务器不认("没开"); }
  if (!r.ok || !r.body) throw new 服务器不认(r.status === 429 ? "忙" : "坏");

  const 读 = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let 攒 = "";
  try {
    for (;;) {
      const { done, value } = await 读.read();
      if (value) 攒 += value;
      let i: number;
      while ((i = 攒.indexOf("\n")) >= 0) {
        const 行 = 攒.slice(0, i).trim();
        攒 = 攒.slice(i + 1);
        if (!行) continue;
        const x = JSON.parse(行) as { 排队?: number; 框?: 服务器识别项[]; 忙?: boolean; 错?: string };
        if (typeof x.排队 === "number") 排队(x.排队);
        else if (Array.isArray(x.框)) return x.框;
        else if (x.忙) throw new 服务器不认("忙");
        else throw new 服务器不认("坏");
      }
      if (done) break;
    }
  } catch (e) {
    if (e instanceof 服务器不认) throw e;
    throw new 服务器不认("断网");
  } finally {
    void 读.cancel().catch(() => undefined);
  }
  throw new 服务器不认("坏");
}
