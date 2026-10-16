import type { NextResponse } from "next/server";
import { 网关错误 } from "@/lib/tenant/gateway-auth";
import { 规整请求id, 背调计一次, 背调已花, type Owner } from "@/lib/tenant/credits";
import { 成本上限元 } from "@/lib/research/price";
import type { 花费 } from "@/lib/research/types";
import { 抹掉密钥 } from "@/lib/secret";

/**
 * 背调四个接口（start / search / read / finish）共用的几样：读请求体、认 runId、按次数闸记一次、兜底报错。
 *
 * 和模型网关同一扇门（设备令牌，见 lib/tenant/gateway-auth.ts）、同一种报错格式（OpenAI 的 { error: { message } }），
 * 桌面端那边的错误显示不用另写一套。
 */

/** 请求体上限。四个接口的请求体都只有一个编号加一句查询 / 一个网址，几百字节；16 KB 是宽到不会误伤的地板 */
export const 正文上限 = 16 * 1024;

export async function 读请求体(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }> {
  const raw = await req.text();
  if (raw.length > 正文上限) return { ok: false, res: 网关错误(413, `请求体太大（${Math.round(raw.length / 1024)} KB），上限 ${正文上限 / 1024} KB`) };
  try {
    const body = JSON.parse(raw || "{}") as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, res: 网关错误(400, "请求体不是合法 JSON") };
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, res: 网关错误(400, "请求体不是合法 JSON") };
  }
}

/** runId 和 X-Question-Id 一个规矩（规整请求id）：不对就是 400，不能像网关那样退回「没带编号」——没编号就没法记账 */
export function 认runId(body: Record<string, unknown>): string | null {
  return 规整请求id(typeof body.runId === "string" ? body.runId : null);
}

/**
 * 搜索 / 读页之前先在账上记一次：这次背调得是这个账号开的、没退过、没过期、没超次数。
 * 返回 null 是放行，否则是要直接回给桌面端的那句话
 */
export async function 先记一次(owner: Owner, runId: string, 哪样: "searches" | "pages", 上限: number): Promise<NextResponse | null> {
  const r = await 背调计一次(owner, runId, 哪样, 上限);
  if (r === "ok") return null;
  if (r === "没有") return 网关错误(404, "找不到这次背调，请重新开始");
  if (r === "退过") return 网关错误(409, "这次背调已经结束了，请重新开始");
  if (r === "过期") return 网关错误(409, "这次背调开始超过 30 分钟了，请重新开始");
  return 网关错误(429, 哪样 === "searches" ? "这次背调的搜索次数到上限了" : "这次背调读的网页数到上限了");
}

/**
 * 单次成本硬上限（lib/research/price.ts，默认 4 元）：到了就不再给搜、不再给读。
 * 返回 null 是放行；否则是 429，桌面端看到就停手、用已有材料出报告（lib/research/run.ts）
 */
export async function 查花费(owner: Owner, runId: string): Promise<{ 挡: NextResponse | null; 花费: 花费 }> {
  const 上限元 = 成本上限元();
  const 已花元 = (await 背调已花(owner, runId)) ?? 0;
  return { 挡: 已花元 >= 上限元 ? 网关错误(429, `这次背调的花费到上限了（${上限元} 元），用已经查到的出报告`) : null, 花费: { 已花元, 上限元 } };
}

/** 四个接口最外面那层兜底：库或别的什么炸了，日志里抹掉 Key，对外一句人话 */
export function 兜底(哪个: string, error: unknown): NextResponse {
  console.error(`[research/${哪个}] 处理失败：`, 抹掉密钥(error instanceof Error ? error.message : String(error), process.env.GATEWAY_API_KEY));
  return 网关错误(503, "AI 背调暂时不可用，请稍后重试");
}
