import { NextResponse } from "next/server";
import { 认扫名片的人, 建限次 } from "@/lib/card-scan/server/auth";
import { AI整理名片, 整理配置 } from "@/lib/card-scan/server/ai-call";
import type { 名片行 } from "@/lib/card-scan/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 扫名片的 AI 整理（2026-10-20 用户定「用 AI，免费不扣次数」，只给团队版）。
 *
 *   GET  能不能用（团队版、服务器配了模型）：手机据此决定认完要不要再问一句
 *   POST body = {行们: 名片行[], 行业们: string[]}（OCR 认出的文字，不是照片；行业选项是这个团队桌面端的）
 *        → {答: AI回答} 或 {答: null}（模型没回 / 超时 / 回的不像样：手机用规则拆的）
 *
 * 不扣次数；按账号 10 分钟 60 张。名片文字只在这次请求里，不落盘、不打日志
 */

const 记一次 = 建限次(60);
const 最多行 = 80;
const 最多字节 = 16 * 1024;

export async function GET(req: Request) {
  const 人 = await 认扫名片的人(req);
  if (人 instanceof NextResponse) return 人;
  return NextResponse.json({ ok: Boolean(整理配置()) }, { headers: { "Cache-Control": "no-store" } });
}

/** 只收认得出的形状：手机传来的东西原样拼进提示词，别让人塞别的进去 */
function 读行们(x: unknown): 名片行[] | null {
  if (!Array.isArray(x) || !x.length || x.length > 最多行) return null;
  const 行们: 名片行[] = [];
  for (const [i, l] of x.entries()) {
    const o = l as Record<string, unknown>;
    if (typeof o?.text !== "string") return null;
    行们.push({
      i,
      text: o.text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200),
      字号: Math.max(0, Math.min(10, Math.round(Number(o.字号) || 0))),
      位: o.位 === "左" || o.位 === "右" ? o.位 : "中",
      面: o.面 === 1 ? 1 : 0,
      联系方式: o.联系方式 === true,
    });
  }
  return 行们;
}

export async function POST(req: Request) {
  const 人 = await 认扫名片的人(req);
  if (人 instanceof NextResponse) return 人;
  if (!整理配置()) return NextResponse.json({ error: "这台服务器没配模型" }, { status: 404 });
  if (Number(req.headers.get("content-length") ?? 0) > 最多字节) return NextResponse.json({ error: "太长了" }, { status: 413 });
  let body: { 行们?: unknown; 行业们?: unknown };
  try {
    const 文 = await req.text();
    if (文.length > 最多字节) return NextResponse.json({ error: "太长了" }, { status: 413 });
    body = JSON.parse(文);
  } catch {
    return NextResponse.json({ error: "看不懂" }, { status: 400 });
  }
  const 行们 = 读行们(body.行们);
  if (!行们) return NextResponse.json({ error: "看不懂" }, { status: 400 });
  const 行业们 = Array.isArray(body.行业们)
    ? body.行业们.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 30).map((x) => x.trim()).slice(0, 60)
    : [];
  if (!记一次(人.accountId)) return NextResponse.json({ error: "扫得太快了" }, { status: 429 });
  const 答 = await AI整理名片(行们, 行业们);
  return NextResponse.json({ 答 }, { headers: { "Cache-Control": "no-store" } });
}
