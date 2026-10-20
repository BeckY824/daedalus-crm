import { NextResponse } from "next/server";
import { multiTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 连手机资格 } from "@/lib/tenant/mobile-link";
import { 语言表, 是名片语言 } from "@/lib/card-scan/langs";
import { 取识别池, 太忙 } from "@/lib/card-scan/server/pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 服务器认名片（2026-10-20，用户同意「服务器识别为主、本机识别兜底」：第一次也不用下 12 MB 识别文件）。
 *
 *   GET  打开扫名片时叫一声：能不能用（团队版、没超次数），能用就把识别线程先起好
 *   POST ?lang=中英  body = 手机压好的 JPEG（几百 KB，最多 2 MB）→ 一行一行回 JSON（application/x-ndjson）：
 *        {"排队":x}（前面还有 x 张，变了就再回一行）… 最后一行 {"框":[{poly,text,score}…]} 或 {"忙":true}（手机改用本机识别）
 *
 * 只给登录了的团队版账号（和连手机同一条：在团队、团队开着、有自己连上的设备）；按账号限流，防有人拿来刷。
 * 不调 AI、不扣次数。照片只在内存里：读进来 → 交给识别线程 → 认完就丢，不落盘、不打日志
 */

const 最大字节 = 2 * 1024 * 1024;
/** 一张名片最多认 3 遍（中英、倒过来、换语言），10 分钟 60 遍 ≈ 20 张以上，展会上一张张扫够用 */
const 限次 = 60;
const 限时毫秒 = 10 * 60_000;
const 资格缓存毫秒 = 5 * 60_000;

const 用过 = new Map<string, number[]>();
/** 这个账号还能不能认（能就记一次）。表按账号放内存：只有一个容器，重启清空无所谓 */
function 记一次(accountId: string, now = Date.now()): boolean {
  const 次们 = (用过.get(accountId) ?? []).filter((t) => now - t < 限时毫秒);
  if (次们.length >= 限次) { 用过.set(accountId, 次们); return false; }
  次们.push(now);
  用过.set(accountId, 次们);
  if (用过.size > 10_000) for (const [k, v] of 用过) if (!v.some((t) => now - t < 限时毫秒)) 用过.delete(k);
  return true;
}

/** 是团队版的记 5 分钟（扫名片一张要问好几次）；不是的不记：刚开通的马上就能用 */
const 资格缓存 = new Map<string, number>();
async function 是团队版(accountId: string): Promise<boolean> {
  if ((资格缓存.get(accountId) ?? 0) > Date.now()) return true;
  const ok = (await 连手机资格(accountId)) === "ok";
  if (ok) 资格缓存.set(accountId, Date.now() + 资格缓存毫秒);
  else 资格缓存.delete(accountId);
  if (资格缓存.size > 10_000) for (const [k, 到] of 资格缓存) if (到 <= Date.now()) 资格缓存.delete(k);
  return ok;
}

/** 认人：不是多租户（自部署）就当没有这个接口，手机自己认 */
async function 认人(req: Request): Promise<{ accountId: string } | NextResponse> {
  if (!multiTenant()) return new NextResponse("Not Found", { status: 404 });
  const t = await 认领(取Bearer(req));
  if (!t) return NextResponse.json({ error: "登录已失效，请重新登录" }, { status: 401 });
  if (!(await 是团队版(t.accountId))) return NextResponse.json({ error: "服务器识别只给团队版" }, { status: 403 });
  return { accountId: t.accountId };
}

export async function GET(req: Request) {
  const 人 = await 认人(req);
  if (人 instanceof NextResponse) return 人;
  取识别池().预热();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/** 读请求体，超过上限就不读了 */
async function 读图(req: Request): Promise<Uint8Array | null> {
  const 说的 = Number(req.headers.get("content-length") ?? 0);
  if (说的 > 最大字节 || !req.body) return null;
  const 读 = req.body.getReader();
  const 块们: Uint8Array[] = [];
  let 共 = 0;
  for (;;) {
    const { done, value } = await 读.read();
    if (done) break;
    共 += value.byteLength;
    if (共 > 最大字节) { await 读.cancel().catch(() => undefined); return null; }
    块们.push(value);
  }
  if (!共) return null;
  const 图 = new Uint8Array(共);
  let i = 0;
  for (const b of 块们) { 图.set(b, i); i += b.byteLength; }
  return 图;
}

export async function POST(req: Request) {
  const 人 = await 认人(req);
  if (人 instanceof NextResponse) return 人;
  const 语言 = new URL(req.url).searchParams.get("lang") ?? "中英";
  if (!是名片语言(语言)) return NextResponse.json({ error: "不认识的名片语言" }, { status: 400 });
  if (!记一次(人.accountId)) return NextResponse.json({ error: "扫得太快了，先在手机上认" }, { status: 429 });
  const 图 = await 读图(req);
  if (!图) return NextResponse.json({ error: "照片太大或是空的" }, { status: 413 });

  const 编 = new TextEncoder();
  const 停 = new AbortController();
  req.signal?.addEventListener("abort", () => 停.abort(), { once: true });
  const 体 = new ReadableStream<Uint8Array>({
    async start(c) {
      const 行 = (x: unknown) => { try { c.enqueue(编.encode(JSON.stringify(x) + "\n")); } catch { /* 手机走了 */ } };
      let 上次 = -1;
      try {
        const 项们 = await 取识别池().认(图, 语言表[语言].模型, {
          signal: 停.signal,
          // 排着的时候每变一次报一行；排过队的轮到了再报一个 0（手机把「排队中」换回「正在认」）
          进: (前面) => { if (前面 !== 上次 && (前面 > 0 || 上次 > 0)) { 上次 = 前面; 行({ 排队: 前面 }); } },
        });
        行({ 框: 项们 });
      } catch (e) {
        行(e instanceof 太忙 ? { 忙: true } : { 错: "服务器没认出来" });
      }
      try { c.close(); } catch { /* 手机走了 */ }
    },
    cancel() { 停.abort(); },
  });
  return new Response(体, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // 一行一行地推（排队位置），别让中间的代理攒着、压缩
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
