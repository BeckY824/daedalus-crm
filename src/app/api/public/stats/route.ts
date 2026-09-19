import { NextResponse } from "next/server";
import { 来源允许 } from "@/lib/lead";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 官网首页那排数字的唯一出处：**公开、只读、跨域**。
 *
 * 为什么要有这么个接口：官网是一堆手写的静态 HTML，发站是手动跑 deploy/deploy.sh。
 * 数字如果在构建期烧进 HTML（deploy/latest-json.py 那种做法），那它就冻在发站那一刻——
 * 一个月不发站，首页就挂着一个月前的数。所以数字必须由浏览器运行时来取，也就是这里。
 *
 * **这个项目的规矩：算不出来就不显示，绝不摆一个看起来像那么回事的数。**
 * 落到这份 JSON 上就是：取不到的字段**直接不出现**——不返回 0，也不返回 null，
 * 因为 0 和 null 到了前端都要再判一次，判漏一次首页上就是个假数。三个都取不到就回 `{}`，
 * 官网那边看到没有字段就整排不渲染。
 *
 * 三个数各自的出处和口径：
 *   访问量  自托管 umami（stats.ai-daedalus.com）的 pageviews，**从 2026-09-15 起算**——
 *           那天才把统计脚本挂上去，之前的访问量不存在，也编不出来。起算日随数字一起
 *           返回（`访问量起算日`），让官网的说明文字只有一个出处，不会和这里说的不一致。
 *   用户数  控制面库里的真人账号数（control.account）。**官网目前不显示它**，
 *           显示与否是首页那边一行数组的事，见 index.html 里的 `要显示的`。
 *   下载数  **只算当前版本那一个 dmg 的下载次数**，不做「历史总下载」。
 *           打包 workflow 用 `--clobber`（删掉重传，计数归零）而且能 workflow_dispatch
 *           手动重跑，历史总量得不出一个站得住的数——那种数只能靠攒，攒的就是假的。
 *
 * 凭证**只从环境变量读**，见文件末尾那张表。一个都没配时这个接口不报错，
 * 只是少一个字段——官网跟着少一格，不会白屏。
 *
 * 自部署的开源版没有控制面、也不该认识我们的 umami，所以 multiTenant() 为假直接 404，
 * 和 admin / gateway 一个规矩。
 */

/* ── 缓存 ────────────────────────────────────────────────────
 * 官网首页每次访问都会打这个接口。没有缓存的话，umami、GitHub、控制面库
 * 会跟着首页流量一起被打——GitHub 匿名调用一小时只有 60 次，一阵小流量就打穿了。
 * 按数据源分别缓存：一个源挂了不该把另外两个也拖成陈旧值。
 * 失败缓存得短一些，让它能自己恢复，而不是错一次就错十分钟。 */
const 成功TTL = 10 * 60_000;
const 失败TTL = 60_000;
const 缓存 = new Map<string, { 值: unknown; 到期: number }>();

async function 取<T>(键: string, 现取: () => Promise<T | undefined>): Promise<T | undefined> {
  const 有 = 缓存.get(键);
  if (有 && 有.到期 > Date.now()) return 有.值 as T | undefined;
  let 值: T | undefined;
  try {
    值 = await 现取();
  } catch (e) {
    console.error(`[public/stats] ${键} 取不到：`, e instanceof Error ? e.message : e);
    值 = undefined;
  }
  缓存.set(键, { 值, 到期: Date.now() + (值 === undefined ? 失败TTL : 成功TTL) });
  return 值;
}

/* ── 访问量：自托管 umami ─────────────────────────────────── */

/** 官网每页 <script> 标签上的 data-website-id，本来就印在公开的 HTML 里，不是秘密 */
const 默认站点 = "58fa34cd-7485-44ff-ac3c-c9d147a9f14d";
const 默认基址 = "https://stats.ai-daedalus.com";
/** 统计脚本上线那天。这之前没有数据，所以首页的说明文字必须注明起算日 */
const 默认起算日 = "2026-09-15";

const umami基址 = () => (process.env.UMAMI_BASE_URL?.trim() || 默认基址).replace(/\/+$/, "");
const umami站点 = () => process.env.UMAMI_WEBSITE_ID?.trim() || 默认站点;
const 起算日 = () => process.env.UMAMI_SINCE?.trim() || 默认起算日;

/** 用户名密码换来的令牌。umami 的令牌不短期过期，但也别一直用同一个，几小时换一次 */
let umami令牌: { 值: string; 到期: number } | null = null;

/**
 * 三种配法，按这个顺序认：
 *   UMAMI_API_KEY               新版 umami 的 API key（最省事，不用登录）
 *   UMAMI_TOKEN                 已经拿到的 Bearer 令牌
 *   UMAMI_USERNAME + PASSWORD   自己登录换一个令牌，缓存在内存里
 * 一个都没配就返回 null——这不是错误，是「这台机器没有这个数」。
 */
async function umami鉴权头(): Promise<Record<string, string> | null> {
  const key = process.env.UMAMI_API_KEY?.trim();
  if (key) return { "x-umami-api-key": key };

  const 现成令牌 = process.env.UMAMI_TOKEN?.trim();
  if (现成令牌) return { Authorization: `Bearer ${现成令牌}` };

  const username = process.env.UMAMI_USERNAME?.trim();
  const password = process.env.UMAMI_PASSWORD;
  if (!username || !password) return null;

  if (umami令牌 && umami令牌.到期 > Date.now()) return { Authorization: `Bearer ${umami令牌.值}` };

  const r = await fetch(`${umami基址()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`umami 登录回了 ${r.status}`);
  const d = (await r.json()) as { token?: string };
  if (!d?.token) throw new Error("umami 登录没给 token");
  umami令牌 = { 值: d.token, 到期: Date.now() + 6 * 3600_000 };
  return { Authorization: `Bearer ${d.token}` };
}

async function 取访问量(): Promise<number | undefined> {
  const 头 = await umami鉴权头();
  if (!头) return undefined; // 凭证没配。少一个字段，不报错

  const startAt = Date.parse(`${起算日()}T00:00:00Z`);
  if (!Number.isFinite(startAt)) throw new Error(`UMAMI_SINCE 不是个日期：${起算日()}`);
  const url = `${umami基址()}/api/websites/${encodeURIComponent(umami站点())}/stats?startAt=${startAt}&endAt=${Date.now()}`;

  const r = await fetch(url, {
    headers: { ...头, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`umami stats 回了 ${r.status}`);
  // v2 回 {pageviews:{value,prev},...}；更老的版本直接回一个数。两种都认
  const d = (await r.json()) as { pageviews?: number | { value?: number } };
  const v = typeof d?.pageviews === "object" ? d.pageviews?.value : d?.pageviews;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/* ── 下载数：GitHub 上当前版本那一个 dmg ─────────────────── */

const 仓库 = "https://api.github.com/repos/BeckY824/daedalus-crm";
/** 小版本的包都挂在这个滚动 Release 上，理由见 website/deploy/latest-json.py 的文件头 */
const 滚动 = "desktop-updates";
/** 「当前版本」以官网正在发的那个 feed 为准——下载按钮下的就是它，说的才是同一件事 */
const 默认feed = "https://ai-daedalus.com/desktop/latest.json";

type 资产 = { name?: string; download_count?: number };

async function gh(路径: string): Promise<{ assets?: 资产[] }> {
  const 头: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "daedalus-public-stats",
  };
  // 匿名一小时 60 次。有缓存本来够用，配了 token 更稳（也让重启后的冷启动不至于撞上限）
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) 头.Authorization = `Bearer ${token}`;
  const r = await fetch(`${仓库}/${路径}`, { headers: 头, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!r.ok) throw new Error(`GitHub ${路径} 回了 ${r.status}`);
  return (await r.json()) as { assets?: 资产[] };
}

/** 官网正在发哪一版。不从本仓库的 package.json 读：托管版的版本号常常落后于桌面端发版 */
async function 当前版本(): Promise<string> {
  const feed = process.env.DESKTOP_FEED_URL?.trim() || 默认feed;
  const r = await fetch(feed, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!r.ok) throw new Error(`版本 feed 回了 ${r.status}`);
  const d = (await r.json()) as { version?: unknown };
  const v = String(d?.version ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`版本 feed 里的 version 不像版本号：${v}`);
  return v;
}

async function 取下载(): Promise<{ 版本: string; 次数: number } | undefined> {
  const 版本 = await 当前版本();
  // 和 latest-json.py 的 找资产() 一样：先看这一版自己的 Release，没有再去滚动 Release 里按文件名认
  for (const 路径 of [`releases/tags/v${版本}`, `releases/tags/${滚动}`]) {
    let rel: { assets?: 资产[] };
    try {
      rel = await gh(路径);
    } catch {
      continue; // 大版本没有独立 Release 时第一条必然 404，这是正常的
    }
    const dmg = (rel.assets ?? []).filter((a) => a.name?.includes(`-${版本}-`) && a.name?.endsWith(".dmg"));
    const 挑 = dmg.find((a) => a.name?.includes("arm64")) ?? dmg[0];
    if (挑 && typeof 挑.download_count === "number") return { 版本, 次数: 挑.download_count };
  }
  return undefined;
}

/* ── 用户数 ───────────────────────────────────────────────── */

async function 取用户数(): Promise<number | undefined> {
  const n = await control.account.count();
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/* ── HTTP ─────────────────────────────────────────────────── */

/** 和 api/lead 同一套跨域头，白名单也是同一份（lib/lead.ts 的 允许来源） */
function 跨域头(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: Request) {
  if (!multiTenant()) return new NextResponse(null, { status: 404 });
  const origin = req.headers.get("origin");
  if (!来源允许(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: 跨域头(origin!) });
}

export async function GET(req: Request) {
  // 自部署版没有控制面，也不该认识我们的统计后台。和 admin / gateway 一个规矩
  if (!multiTenant()) return NextResponse.json({ error: "not found" }, { status: 404 });

  const origin = req.headers.get("origin");
  // **和 api/lead 有意差一点**：lead 是会花我们邮件额度的写接口，没 Origin 一律 403；
  // 这里是只读的公开聚合数字，直接打开地址（没有 Origin）也照给，好让人一眼看出它有没有配好。
  // 跨域头只发给白名单里的来源，所以浏览器那边的约束一点没松。
  if (origin && !来源允许(origin)) return NextResponse.json({ error: "来源不允许" }, { status: 403 });

  const [访问量, 用户数, 下载] = await Promise.all([
    取("umami:pageviews", 取访问量),
    取("control:accounts", 取用户数),
    取("github:downloads", 取下载),
  ]);

  // 取不到的字段一个都不放进来：宁可官网少一格，也不让它显示一个假数
  const 数: Record<string, unknown> = {};
  if (访问量 !== undefined) {
    数.访问量 = 访问量;
    数.访问量起算日 = 起算日();
  }
  if (用户数 !== undefined) 数.用户数 = 用户数;
  if (下载 !== undefined) {
    数.下载数 = 下载.次数;
    数.下载版本 = 下载.版本;
  }

  return NextResponse.json(数, {
    status: 200,
    headers: {
      ...(origin && 来源允许(origin) ? 跨域头(origin) : {}),
      // 浏览器和中间层也帮着挡一层。比服务端缓存短，免得改了 env 之后半天不生效
      "Cache-Control": "public, max-age=300",
    },
  });
}

/* ── 要往 /opt/crm/.env 里加的变量（都可省，省了就少那个字段）──
 *   UMAMI_API_KEY      新版 umami 的 API key           ┐ 三选一
 *   UMAMI_TOKEN        现成的 Bearer 令牌               │
 *   UMAMI_USERNAME     umami 登录名                     │
 *   UMAMI_PASSWORD     umami 密码                       ┘
 *   UMAMI_BASE_URL     默认 https://stats.ai-daedalus.com
 *   UMAMI_WEBSITE_ID   默认 58fa34cd-7485-44ff-ac3c-c9d147a9f14d（官网 HTML 里那个）
 *   UMAMI_SINCE        访问量起算日，默认 2026-09-15（统计脚本上线那天）
 *   DESKTOP_FEED_URL   默认 https://ai-daedalus.com/desktop/latest.json
 *   GITHUB_TOKEN       可选，只为抬高 GitHub 的匿名限额
 */
