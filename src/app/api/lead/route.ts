import { NextResponse } from "next/server";
import { 解析来源IP } from "@/lib/rate-limit";
import { 来源允许, 校验线索, 线索通道可用, 线索限流, 发线索 } from "@/lib/lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 官网预约演示表单 → 我们的邮箱。规则和理由都在 lib/lead.ts，这里只做 HTTP 翻译：
 * 来源不对 403、通道没配 503、限流 429、字段不对 400、发不出去 502。
 * 官网那边只认 2xx，其余一律落回复制粘贴的兜底面板，所以状态码分得细是给日志看的。
 *
 * 蜜罐命中回 200：让脚本以为成功了，别教它怎么绕。
 */

function 跨域头(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  if (!来源允许(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: 跨域头(origin!) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!来源允许(origin)) return NextResponse.json({ error: "来源不允许" }, { status: 403 });
  const 头 = 跨域头(origin!);
  const 回 = (body: unknown, status: number) => NextResponse.json(body, { status, headers: 头 });

  if (!线索通道可用()) return 回({ error: "邮件通道没配" }, 503);

  const ip = 解析来源IP(req.headers.get("x-forwarded-for"));
  const 拒 = 线索限流(ip);
  if (拒) return 回({ error: 拒 === "ip" ? "今天提交太多次了" : "今天的名额满了" }, 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return 回({ error: "请求体不是 JSON" }, 400);
  }
  const 校 = 校验线索(body);
  if (!校.ok) return "bot" in 校 ? 回({ ok: true }, 200) : 回({ error: 校.error }, 400);

  const r = await 发线索(校.线索, ip);
  return r.ok ? 回({ ok: true }, 200) : 回({ error: r.error }, 502);
}
