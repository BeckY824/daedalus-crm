/**
 * r4 兼容性审查的台子：**哪个版本的桌面端 × 哪个版本的网关**。
 *
 * 在 tests/r2-ai-harness.ts（桌面端 llm.ts → 进程内网关路由 → 假上游）的基础上多两样：
 *
 *   1. 网关可选「新」（本分支的 src/app/api/gateway/…/route.ts）或「旧」（v0.46.13，线上正在跑的那份，
 *      原样取在 tests/r4-compat-fixtures/v0.46.13-gateway/ 下，只改了相对 import）
 *   2. **时间缩放**：AbortSignal.timeout 统一按 1/缩放 走，假上游的延迟也用「真实秒数」写。
 *      客户端 60 / 90 / 120 秒、网关 120 秒这些数之间的先后关系原样保留，测试几秒跑完。
 *
 * 旧桌面端（0.46.14）的 llm.ts / agent/run.ts / ai/stream 路由同样原样取在 tests/r4-compat-fixtures/v0.46.14/ 下，
 * 由各测试文件自己 vi.mock 换进去（只换这三样：工具表 / schemas / 调用方在 0.46.14 → 953a7b2 之间协议上没变）。
 */
import { vi } from "vitest";
import { 云, 上游, type 上游请求, type 线路 } from "./r2-ai-harness";

export * from "./r2-ai-harness";

/** 1 真实秒 = 1000/缩放 毫秒 */
export const 缩放 = 200;
export const 秒 = (s: number) => (s * 1000) / 缩放;

const 原timeout = AbortSignal.timeout.bind(AbortSignal);
export function 时间缩放() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => 原timeout(Math.max(1, ms / 缩放)));
}

export type 网关版本 = "新" | "旧";

async function 网关POST(版本: 网关版本): Promise<(r: Request) => Promise<Response>> {
  return 版本 === "新"
    ? (await import("@/app/api/gateway/v1/chat/completions/route")).POST
    : (await import("./r4-compat-fixtures/v0.46.13-gateway/route")).POST;
}

export type 网关记录 = 线路["网关"][number] & { 完成?: boolean; 客户端放弃?: boolean };

/**
 * 接线。和 r2 的 接线 一样，多了：
 *   - 选网关版本
 *   - 上游剧本可以返回 { 等: 真实秒数, 回: Response }：在网关那一侧真的挂着，网关自己的 120 秒超时会把它掐断
 *   - 线.后台：网关那一侧还在跑的请求（客户端已经超时走了），断言扣次数之前要 await 它们
 */
export function 接线到(
  版本: 网关版本,
  opts: { 上游: (r: 上游请求) => Response | { 等: number; 回: () => Response } | Promise<Response> },
) {
  const 线 = { 上游: [] as 上游请求[], 网关: [] as 网关记录[], 后台: [] as Promise<unknown>[] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    new URL(url);
    if (init.signal?.aborted) throw init.signal.reason;

    if (url.startsWith(上游)) {
      const r = { body: JSON.parse(String(init.body ?? "{}")), 第几次: 线.上游.length + 1 };
      线.上游.push(r);
      const 剧本 = await opts.上游(r);
      if (剧本 instanceof Response) return 剧本;
      // 挂着：要么等够了回，要么被网关的超时掐断（和真 fetch 一样抛 signal.reason）
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(剧本.回()), 秒(剧本.等));
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason);
        }, { once: true });
      });
    }
    if (url.startsWith(云)) {
      const headers = new Headers(init.headers);
      // 桌面端那头的断开要传到网关的 req.signal（真实环境里 Next 在客户端断开时会 abort 它）
      const req = new Request(url, { method: init.method ?? "GET", headers, body: init.body as BodyInit | undefined, signal: init.signal ?? undefined });
      const 记: 网关记录 | null = url.includes("/chat/completions")
        ? 线.网关[线.网关.push({ url, questionId: headers.get("x-question-id"), feature: headers.get("x-feature") }) - 1]
        : null;
      const 处理 = url.includes("/api/gateway/v1/chat/completions")
        ? await 网关POST(版本)
        : url.includes("/api/gateway/v1/models")
          ? (await import("@/app/api/gateway/v1/models/route")).GET
          : url.includes("/api/gateway/v1/credits")
            ? (await import("@/app/api/gateway/v1/credits/route")).GET
            : null;
      const 原 = process.env.MULTI_TENANT;
      process.env.MULTI_TENANT = "1";
      let p: Promise<Response>;
      try {
        p = 处理 ? (处理 as (r: Request) => Promise<Response>)(req) : Promise.resolve(new Response("not found", { status: 404 }));
      } finally {
        if (原 === undefined) delete process.env.MULTI_TENANT;
        else process.env.MULTI_TENANT = 原;
      }
      // 网关那一侧跑到底（读完正文：流式的也要读完，才算这条请求结束）
      const 跑完 = p.then(async (res) => {
        if (记) 记.status = res.status;
        const 副本 = res.clone();
        await 副本.text().catch(() => {});
        if (记) 记.完成 = true;
        return res;
      });
      线.后台.push(跑完.catch(() => {}));
      const 等 = init.signal
        ? Promise.race([
            跑完,
            new Promise<never>((_, rej) =>
              init.signal!.addEventListener("abort", () => {
                if (记) 记.客户端放弃 = true;
                rej(init.signal!.reason);
              }, { once: true }),
            ),
          ])
        : 跑完;
      return 等;
    }
    throw new TypeError(`fetch failed（测试里没接这个地址：${url}）`);
  });
  return 线;
}

/** 等网关那一侧所有请求都跑完（包括客户端已经放弃的那些） */
export async function 等后台(线: { 后台: Promise<unknown>[] }) {
  let n = -1;
  while (n !== 线.后台.length) {
    n = 线.后台.length;
    await Promise.allSettled(线.后台);
  }
}
