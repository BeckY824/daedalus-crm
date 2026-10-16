import { NextResponse } from "next/server";
import { 网关认证, 网关错误 } from "@/lib/tenant/gateway-auth";
import { 读网页, 读页出错 } from "@/lib/research/read-page";
import { 背调有收获 } from "@/lib/tenant/credits";
import { 背调上限, type 读页回应 } from "@/lib/research/types";
import { 读请求体, 认runId, 先记一次, 查花费, 兜底 } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 和搜索一样，比客户端的上限多 2 次余量（见 search/route.ts 的 搜索余量） */
const 读页余量 = 2;
/** 网址最长多少。正常的网址一两百字；再长的多半是塞了别的东西进来 */
const 网址最长 = 2048;

/**
 * 背调里读一页：服务器替桌面端去取（lib/research/read-page.ts，带防 SSRF 的那一套），把正文交回去。
 * 不另扣次数，只按次数闸记一次。
 */
export async function POST(req: Request) {
  try {
    return await 处理(req);
  } catch (e) {
    return 兜底("read", e);
  }
}

async function 处理(req: Request) {
  const auth = await 网关认证(req);
  if (!auth.ok) return auth.res;
  const { accountId } = auth;
  const 读 = await 读请求体(req);
  if (!读.ok) return 读.res;
  const runId = 认runId(读.body);
  if (!runId) return 网关错误(400, "runId 不对：要 1–64 位字母、数字、- 或 _");
  const url = typeof 读.body.url === "string" ? 读.body.url.trim() : "";
  if (!url) return 网关错误(400, "网址是空的");
  if (url.length > 网址最长) return 网关错误(400, "网址太长了");

  const owner = { kind: "account" as const, id: accountId };
  const 钱 = await 查花费(owner, runId);
  if (钱.挡) return 钱.挡;
  const 挡 = await 先记一次(owner, runId, "pages", 背调上限.读页 + 读页余量);
  if (挡) return 挡;

  try {
    const 页 = await 读网页(url, { signal: req.signal });
    await 背调有收获(owner, runId);
    // 读页在我们服务器上读，不花模型的钱；花费照样带回去，桌面端每一步都知道离上限多远
    const 回应: 读页回应 = { ...页, 花费: 钱.花费 };
    return NextResponse.json(回应);
  } catch (e) {
    /*
      读失败**不还名额**（和搜索相反）。搜索失败是我们的上游出错，还回去是应该的；读页失败绝大多数是那个网址本身
      读不了（404、PDF、内网、超时），还回去的话，拿一串坏网址就能让我们的服务器无限往外连——
      读页的次数闸防的正是这个。一次失败的读页几乎不花钱，占掉一个名额，桌面端换一个网址就是了
    */
    if (e instanceof 读页出错) return 网关错误(422, e.message);
    console.error("[research/read] 读页意外失败：", e instanceof Error ? e.message : String(e));
    return 网关错误(422, "这个网址读不了：出了点意外，换一个网址试试");
  }
}
