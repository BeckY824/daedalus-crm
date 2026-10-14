import { createHash } from "node:crypto";
import { 是本机地址 } from "@/lib/desktop/local-guard";
export const dynamic = "force-dynamic";

/** 供桌面父进程确认本次服务已就绪；只返回不可用于登录的摘要。 */
export async function GET(req: Request) {
  const token = process.env.DESKTOP_TOKEN;
  if (process.env.DESKTOP_LOCAL !== "1" || !token || !是本机地址(req.headers.get("host") ?? new URL(req.url).host)) {
    return new Response("Not Found", { status: 404 });
  }
  return Response.json({ instance: createHash("sha256").update(token).digest("hex") }, { headers: { "Cache-Control": "no-store" } });
}
