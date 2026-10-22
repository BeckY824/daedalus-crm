import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { 附件文件, 删附件 } from "@/lib/attachments";
import { 是附件编号, 是图片, 读大小 } from "@/lib/attachment-rules";
import { 解析范围 } from "@/app/ocr-files/[...path]/route";
import { 认父记录 } from "../access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 一个附件：GET / HEAD 取文件（缩略图、看大图、网页上下载），DELETE 删掉。
 * 只有图片按原类型给、能在页面里显示；别的一律当下载（application/octet-stream + attachment）：
 * 有人传个 .html / .svg 进来，在本站打开就能跑脚本
 */

type 参数 = { params: Promise<{ id: string }> };

async function 取(id: string, 要改: boolean) {
  if (!是附件编号(id)) return { 错: "找不到这个附件", 状态: 404 } as const;
  const a = await prisma.attachment.findFirst({ where: { id } });
  if (!a) return { 错: "这个附件已经不在了，刷新看看", 状态: 404 } as const;
  const 挂在 = a.opportunityId ? { opportunityId: a.opportunityId } : a.orderId ? { orderId: a.orderId } : null;
  if (!挂在) return { 错: "找不到这个附件", 状态: 404 } as const;
  const 父 = await 认父记录(挂在, 要改);
  if ("错" in 父) return 父;
  return { a, 叫法: 父.叫法 };
}

async function 出(req: Request, ctx: 参数, 只要头: boolean): Promise<Response> {
  if (!(await getCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const r = await 取((await ctx.params).id, false);
  if ("错" in r) return new Response(r.错, { status: r.状态 });
  const { a } = r;
  let 总: number;
  try { 总 = fs.statSync(附件文件(a.id)).size; } catch { return new Response("文件不在这台电脑上", { status: 404 }); }
  const 图 = 是图片(a.mime);
  const 头 = new Headers({
    "Content-Type": 图 ? a.mime : "application/octet-stream",
    "Content-Disposition": `${图 ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    // 文件存进去以后不再改：同一个编号永远是同一份字节
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    ETag: `"${a.sha256}"`,
  });
  if (req.headers.get("if-none-match") === `"${a.sha256}"`) return new Response(null, { status: 304, headers: 头 });
  const 段 = 解析范围(req.headers.get("range"), 总);
  if (段 === "超出") {
    头.set("Content-Range", `bytes */${总}`);
    return new Response(null, { status: 416, headers: 头 });
  }
  const { 起, 止 } = 段 ?? { 起: 0, 止: 总 - 1 };
  头.set("Content-Length", String(止 - 起 + 1));
  if (段) 头.set("Content-Range", `bytes ${起}-${止}/${总}`);
  const 体 = 只要头 || 总 === 0 ? null : (Readable.toWeb(fs.createReadStream(附件文件(a.id), { start: 起, end: 止 })) as ReadableStream);
  return new Response(体, { status: 段 ? 206 : 200, headers: 头 });
}

export function GET(req: Request, ctx: 参数) {
  return 出(req, ctx, false);
}

export function HEAD(req: Request, ctx: 参数) {
  return 出(req, ctx, true);
}

export async function DELETE(_req: Request, ctx: 参数) {
  const 我 = await getCurrentUser();
  if (!我) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const id = (await ctx.params).id;
  // 已经删了（两个窗口、连点）当成功
  if (是附件编号(id) && !(await prisma.attachment.findFirst({ where: { id }, select: { id: true } }))) return NextResponse.json({ ok: true });
  const r = await 取(id, true);
  if ("错" in r) return NextResponse.json({ error: r.错 }, { status: r.状态 });
  await 删附件(prisma, r.a.id);
  await recordAudit({ user: 我, action: "delete", entity: "Attachment", entityId: r.a.id, summary: `删了${r.叫法}的附件「${r.a.name}」（${读大小(r.a.size)}）`, detail: { 名字: r.a.name, 大小: r.a.size } });
  return NextResponse.json({ ok: true });
}
