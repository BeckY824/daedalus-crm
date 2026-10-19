import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 背调还能用 } from "@/lib/tenant/credits";
import { 核验 } from "@/lib/research/verify/check";
import { 主机 } from "@/lib/research/verify/domain";
import type { 核验请求 } from "@/lib/research/verify/types";
import { 读请求体, 认runId, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 背调的程序直查（2026-10-18）：域名注册时间、官网、邮箱、电话、制裁名单、工商库、税号。
 * 全程不经模型（不花模型的钱），**不另扣背调次数**——属于这次背调的一部分，认 runId。
 * 一次背调最多核 2 次（桌面端超时重发一次是常事）：每次都要往外打好几家官方接口，不能被拿来当免费查询服务。
 */
const 每次最多 = 2;
const 核过 = new Map<string, number>();

function 字符串们(v: unknown, 最多: number, 最长: number): string[] {
  return (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x && x.length <= 最长)
    .slice(0, 最多);
}

export async function POST(req: Request) {
  try {
    return await 处理(req);
  } catch (e) {
    return 兜底("verify", e);
  }
}

async function 处理(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { accountId } = auth;
  const 读 = await 读请求体(req);
  if (!读.ok) return 读.res;
  const b = 读.body;
  const runId = 认runId(b);
  if (!runId) return 网关错误(400, "runId 不对：要 1–64 位字母、数字、- 或 _");
  const 公司 = typeof b.公司 === "string" ? b.公司.trim() : "";
  if (公司.length < 2 || 公司.length > 200) return 网关错误(400, "公司名不对（2–200 字）");

  const owner = { kind: "account" as const, id: accountId };
  const 能 = await 背调还能用(owner, runId);
  if (能 === "没有") return 网关错误(404, "找不到这次背调，请重新开始");
  if (能 === "退过") return 网关错误(409, "这次背调已经结束了，请重新开始");
  if (能 === "过期") return 网关错误(409, "这次背调开始超过 30 分钟了，请重新开始");
  const 键 = `${accountId}:${runId}`;
  const 次 = 核过.get(键) ?? 0;
  if (次 >= 每次最多) return 网关错误(429, "这次背调已经核过了");
  核过.set(键, 次 + 1);
  // 只留最近的：一个进程跑几个月也不会越攒越多
  if (核过.size > 5000) for (const k of [...核过.keys()].slice(0, 1000)) 核过.delete(k);

  const 域名 = typeof b.域名 === "string" ? 主机(b.域名) : undefined;
  const 国家 = typeof b.国家 === "string" && /^[A-Z]{2}$/.test(b.国家) ? b.国家 : undefined;
  const 自报国家 = typeof b.自报国家 === "string" && /^[A-Z]{2}$/.test(b.自报国家) ? b.自报国家 : undefined;
  const 请求: Omit<核验请求, "runId"> = {
    公司,
    别名: 字符串们(b.别名, 2, 200),
    域名,
    邮箱: 字符串们(b.邮箱, 3, 254),
    电话: 字符串们(b.电话, 3, 40),
    税号: typeof b.税号 === "string" && b.税号.trim().length <= 20 ? b.税号.trim() : undefined,
    国家,
    自报国家,
  };
  return NextResponse.json(await 核验(请求, { signal: req.signal }));
}
