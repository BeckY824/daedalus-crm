/**
 * 程序直查用的取数：只打固定的几家官方 / 公益接口（RDAP、工商库、制裁名单……），网址由我们拼，不接外面给的网址。
 * 每次都带超时：对面挂了就是「查不了」，不能拖住整次背调。
 */

export const 标识 = "OpensourceCRM-research-verify/1.0";

export class 查不了 extends Error {}

export async function 取JSON<T = unknown>(url: string, opts: { 秒?: number; headers?: Record<string, string>; signal?: AbortSignal; 方法?: "GET" | "POST"; body?: unknown } = {}): Promise<{ status: number; data: T | null }> {
  const 超时 = AbortSignal.timeout((opts.秒 ?? 8) * 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.方法 ?? "GET",
      headers: { Accept: "application/json", "User-Agent": 标识, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ? AbortSignal.any([opts.signal, 超时]) : 超时,
      redirect: "follow",
    });
  } catch (e) {
    throw new 查不了(e instanceof Error && e.name === "TimeoutError" ? "超时" : "连不上");
  }
  if (res.status === 404) return { status: 404, data: null };
  if (res.status >= 500 || res.status === 429) throw new 查不了(`对方服务出错（${res.status}）`);
  const t = await res.text().catch(() => "");
  try {
    return { status: res.status, data: JSON.parse(t) as T };
  } catch {
    if (res.ok) throw new 查不了("回的不是 JSON");
    return { status: res.status, data: null };
  }
}
