/**
 * 背调各层的超时和「卡住就重发一次」（10-16 下午 ABC 试跑：A 第 2 步、B 第 1 步都是一次模型调用干等 180 秒超时，整次报废）。
 *
 * 中转站约五分之一的请求会卡住（lib/llm.ts 记过），原样重发通常几秒就回来——所以办法是「每次给够、卡了重发一次」，
 * 不是把一次的等待拉得更长。产品（gateway-model.ts、providers.ts）和对比实验（scripts/research-bench.ts）用同一份，
 * 实验量出来的就是上线以后的。
 *
 * **服务器那一层要比桌面端那一层先到点**：网关等上游 90 秒、桌面端每次等 100 秒。上游卡住时是服务器先认出
 * 「上游超时」、记一笔我们这边的失败（退不退次数看它，见 credits.ts 的 收尾背调）、回 504，桌面端收到 504 再重发；
 * 反过来的话桌面端先断开，服务器只看到「客户端走了」，分不清是我们慢还是用户自己停的。
 */
export const 背调超时 = {
  /** 网关等上游一次模型调用（api/gateway/v1/chat/completions 的背调那一笔）。gpt-5.5 写 2000 token 的结论约 40–60 秒 */
  上游模型: 90_000,
  /** 桌面端等网关一次模型调用：比 上游模型 多 10 秒 */
  模型每次: 100_000,
  /** 服务器等中转站一次带联网搜索的调用（providers.ts）。5.5 带搜索一次可能要 60 秒以上 */
  搜索每次: 90_000,
  /** 桌面端等 /research/search 一次：服务器那头最多两趟（卡住重搜一次，或换备用那家），再加 20 秒余量 */
  搜索接口: 200_000,
} as const;

/** 该不该重发：超时、上游 5xx。调用方自己停的（signal 已经 abort）不重发 */
export function 该重发(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (e instanceof Error && e.name === "TimeoutError") return true;
  const st = (e as { status?: number } | null)?.status;
  return st !== undefined && st >= 500;
}

/**
 * 做一次，碰上 该重发 的错再做一次（只一次：连卡两次多半是真出事了，不来回烧钱）。
 * `做` 拿到的是这一趟的 signal：调用方的 signal 和这一趟的超时合在一起。
 */
export async function 重发一次<T>(做: (signal: AbortSignal) => Promise<T>, 每次毫秒: number, signal?: AbortSignal, 可重发: (e: unknown) => boolean = (e) => 该重发(e, signal)): Promise<T> {
  const 一趟 = () => {
    const 超时 = AbortSignal.timeout(每次毫秒);
    return 做(signal ? AbortSignal.any([signal, 超时]) : 超时);
  };
  try {
    return await 一趟();
  } catch (e) {
    if (!可重发(e)) throw e;
    console.warn(`[research] ${e instanceof Error && e.name === "TimeoutError" ? `${Math.round(每次毫秒 / 1000)} 秒没回音` : "上游出错"}，重发一次`);
    return 一趟();
  }
}

/** 按字符截（不切坏汉字和表情），截了就带省略号。给人看的结论、标签都走它 */
export function 截(s: unknown, n: number): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  const 字 = Array.from(t);
  return 字.length > n ? 字.slice(0, n - 1).join("").trimEnd() + "…" : t;
}
