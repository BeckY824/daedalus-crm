import { NextResponse } from "next/server";
import { version } from "../../../../package.json";
import { requireUser } from "@/lib/auth";
import { control } from "@/lib/tenant/control";
import { multiTenant, currentTenant } from "@/lib/tenant/context";
import { 认领, 取Bearer } from "@/lib/tenant/device-token";
import { 本地模式, 云端地址, 读 as 读云端凭据 } from "@/lib/desktop/cloud";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 反馈正文的上限。够写清一件事，又不至于让人把整段日志糊进来 */
const 上限 = 4000;

/**
 * 「哪儿不好用」的收件口。**一条路由，三种部署各走各的**：
 *
 *   桌面端（本地模式）—— 库在用户自己机器上，我们读不到，所以这里只做转发：
 *                        带上那枚设备令牌发到云端同名接口，由云端落库
 *   托管版             —— 我们就是云端，直接写控制面库
 *   自部署的开源版     —— **什么都不发**。他的实例连我们的云都不该认识，
 *                        界面在这种部署下压根不发请求，直接把人送去 GitHub issues
 *
 * 一起发过去的只有定位问题必须的几样：版本、系统、当时在哪一页、谁发的。
 * **没有任何业务数据**——界面上是这么写的，这里就得是这样。
 */
export async function POST(req: Request) {
  // 云端受理桌面端的转发：认的是设备令牌，不是 cookie（桌面端没有我们的会话）
  const bearer = 取Bearer(req);
  if (bearer && multiTenant()) {
    const who = await 认领(bearer);
    if (!who) return NextResponse.json({ error: "令牌无效" }, { status: 401 });
    const 单 = await 读正文(req);
    if ("error" in 单) return NextResponse.json({ error: 单.error }, { status: 400 });
    const account = await control.account.findUnique({ where: { id: who.accountId } });
    await 落库({
      ...单,
      source: "desktop",
      accountId: who.accountId,
      who: account ? [account.name, account.email ?? account.phone].filter(Boolean).join(" · ") : who.accountId,
    });
    return NextResponse.json({ ok: true });
  }

  // 应用里点的「反馈」：认的是当前登录的人
  const me = await requireUser();
  const 单 = await 读正文(req);
  if ("error" in 单) return NextResponse.json({ error: 单.error }, { status: 400 });

  if (本地模式()) {
    const 凭据 = 读云端凭据();
    if (!凭据) return NextResponse.json({ error: "没登录云端账号，暂时发不出去" }, { status: 503 });
    try {
      const r = await fetch(`${云端地址()}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${凭据.token}` },
        body: JSON.stringify(单),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return NextResponse.json({ error: "云端没收下，稍后再试" }, { status: 502 });
    } catch {
      return NextResponse.json({ error: "连不上，检查一下网络" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  }

  if (!multiTenant()) {
    // 自部署：不往我们这儿发，也不假装发成功了
    return NextResponse.json({ error: "这个部署不往外发反馈，请到 GitHub 提 issue" }, { status: 501 });
  }

  // 工作区用 slug 标出来：运营台按它就能对上是哪个团队发的
  const ws = currentTenant();
  await 落库({
    ...单,
    source: "web",
    accountId: null,
    who: [ws?.slug, me.name].filter(Boolean).join(" · "),
  });
  return NextResponse.json({ ok: true });
}

type 单 = { body: string; path: string | null; version: string; platform: string | null };

async function 读正文(req: Request): Promise<单 | { error: string }> {
  let raw: { body?: string; path?: string; platform?: string; version?: string };
  try {
    raw = (await req.json()) as typeof raw;
  } catch {
    return { error: "请求体不是合法 JSON" };
  }
  const body = (raw.body ?? "").trim();
  if (!body) return { error: "写一句再发" };
  return {
    body: body.slice(0, 上限),
    path: (raw.path ?? "").slice(0, 200) || null,
    // 转发来的那条带着桌面端自己的版本号；网页直接用本进程的
    version: (raw.version ?? "").slice(0, 40) || version,
    platform: (raw.platform ?? "").slice(0, 120) || null,
  };
}

function 落库(f: 单 & { source: string; accountId: string | null; who: string }) {
  return control.feedback.create({ data: f });
}
