import { NextResponse } from "next/server";
import { version } from "../../../../package.json";
import { 处理, type 请求 } from "@/lib/mcp/rpc";
import { 认令牌 } from "@/lib/mcp/token";
import { multiTenant } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MCP 端点（streamable HTTP）。**别人的 agent 从这儿连进来。**
 *
 * 我们一直在做的是「我们去调模型」；这条是反过来的：Claude Code / Codex /
 * Claude 桌面端把这个 CRM 当成一个工具箱，用**他们自己的**订阅和模型来查。
 * 对一人公司那个人群意义最大——他多半已经在付 Claude 或 ChatGPT 的钱，
 * 而数据一步都不出他的机器。
 *
 * 接法（桌面端在「设置 → 桌面端」里能直接复制这一条）：
 *
 *     claude mcp add --transport http daedalus http://127.0.0.1:<端口>/api/mcp \
 *       --header "Authorization: Bearer <令牌>"
 *
 * 三条边界：
 *   - **只读**：开出去的是九个查询工具，写入一律没有（见 lib/mcp/tools.ts 的说明）
 *   - **要令牌**：`Authorization: Bearer`，在设置里生成，重新生成即作废旧的。
 *     令牌不放地址栏——地址会进历史、进日志、进别人的截图
 *   - **托管版不开**：那边是多租户，一个 URL 背后有好几个工作区，
 *     而这条协议里没有工作区这个概念。它是给桌面端和自部署的
 */

const 拒绝 = (status: number, message: string) =>
  NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, { status });

export async function POST(req: Request) {
  if (multiTenant()) return 拒绝(404, "托管版不提供 MCP 接口");

  const 头 = req.headers.get("authorization") ?? "";
  const who = await 认令牌(头.toLowerCase().startsWith("bearer ") ? 头.slice(7).trim() : null);
  if (!who) return 拒绝(401, "要一个有效的 MCP 令牌：在「设置 → 桌面端」里生成，用 Authorization: Bearer 带上");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是合法的 JSON" } }, { status: 400 });
  }

  // 批量请求：协议允许一次发一个数组，逐条处理，通知不产出回应
  const 多条 = Array.isArray(body);
  const 消息 = (多条 ? body : [body]) as 请求[];
  const 回应们 = [];
  for (const m of 消息) {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      回应们.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "不是合法的 JSON-RPC 消息" } });
      continue;
    }
    const r = await 处理(m, who, version);
    if (r) 回应们.push(r);
  }

  // 全是通知：按协议回 202，不带正文
  if (回应们.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(多条 ? 回应们 : 回应们[0], { headers: { "Cache-Control": "no-store" } });
}

/**
 * 客户端会开一条 GET 来收服务端主动发的消息。我们没有要主动说的话，
 * 按协议回 405 让它别等——回 200 挂着一条空流，对面会一直以为还有下文。
 */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
