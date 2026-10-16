import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 背调还一次, 背调有收获, 背调记花费 } from "@/lib/tenant/credits";
import { 读价目, 搜索花费元 } from "@/lib/research/price";
import { 记一次 } from "@/lib/tenant/ai-cost";
import { 抹掉密钥 } from "@/lib/secret";
import { 选搜索服务 } from "@/lib/research/providers";
import { 背调上限, type 搜索回应 } from "@/lib/research/types";
import { 读请求体, 认runId, 先记一次, 查花费, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 查询词最长多少字。模型写的查询正常二三十字，再长就不是查询了，而且每个字都进上游的 token */
const 查询最长 = 300;
/**
 * 服务器这边的次数闸比客户端那份（背调上限.搜索）多 2 次余量：桌面端超时重发、
 * 计数和服务器差一两次都不该被挡；它防的是被改过的客户端无限搜，不是正常的那一两次出入
 */
const 搜索余量 = 2;

/**
 * 背调里的一次搜索：服务器拿中转站自带的搜索去搜（lib/research/providers.ts），把结果交回桌面端。
 * 不另扣次数——start 时整笔扣过了；这里只按次数闸记一次。
 */
export async function POST(req: Request) {
  try {
    return await 处理(req);
  } catch (e) {
    return 兜底("search", e);
  }
}

async function 处理(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { cfg, accountId } = auth;
  const 读 = await 读请求体(req);
  if (!读.ok) return 读.res;
  const runId = 认runId(读.body);
  if (!runId) return 网关错误(400, "runId 不对：要 1–64 位字母、数字、- 或 _");
  const query = typeof 读.body.query === "string" ? 读.body.query.trim() : "";
  if (!query) return 网关错误(400, "搜索词是空的");
  if (query.length > 查询最长) return 网关错误(400, `搜索词太长了（最多 ${查询最长} 字）`);

  const owner = { kind: "account" as const, id: accountId };
  const 钱 = await 查花费(owner, runId);
  if (钱.挡) return 钱.挡;
  const 挡 = await 先记一次(owner, runId, "searches", 背调上限.搜索 + 搜索余量);
  if (挡) return 挡;

  const 服务 = 选搜索服务(cfg);
  let r: Awaited<ReturnType<typeof 服务.search>>;
  try {
    r = await 服务.search(query, { signal: req.signal });
  } catch (e) {
    // 搜索服务自己出的错：这一次什么都没搜到，名额还回去，桌面端可以再搜一次
    await 背调还一次(owner, runId, "searches");
    console.error(`[research/search] ${服务.名} 搜索失败：`, 抹掉密钥(e instanceof Error ? e.message : String(e), cfg.apiKey));
    return 网关错误(502, "搜索服务这会儿没响应，这次没算次数，可以再搜一次");
  }

  // 成本账：搜索花的 token 和模型调用记在一起，按 research 归类（运营台「模型用量」按功能分组）
  if (r.usage) await 记一次(owner, { model: r.usage.model, usage: { input: r.usage.input, output: r.usage.output }, feature: "research" });
  if (r.results.length) await 背调有收获(owner, runId);
  // 这一次搜索的钱（搜索那一路的 token + 每次的搜索费）累到这次背调上，回应里告诉桌面端到现在花了多少
  const 这次 = 搜索花费元(读价目(), r.usage?.model ?? 服务.名, r.usage?.input ?? 0, r.usage?.output ?? 0);
  await 背调记花费(owner, runId, 这次);
  // 按厘取整，和库里记的单位一致（不带 0.07200000000000001 这种浮点尾巴）
  const 回应: 搜索回应 = { results: r.results, 花费: { 已花元: Math.round((钱.花费.已花元 + 这次) * 1000) / 1000, 上限元: 钱.花费.上限元 } };
  return NextResponse.json(回应);
}
