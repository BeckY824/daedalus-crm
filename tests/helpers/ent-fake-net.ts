/**
 * 企业版导入适配器测试共用的假网：fetch 按录好的响应一条条给，等待只记账不真等，钟跟着等走。
 * 录好的响应在 tests/fixtures/ent-feishu.json / ent-dingtalk.json（按官方文档的响应结构）。
 */
import type { 联网 } from "@/lib/enterprise-import/net";

/** 一次响应；给了 抛 就当 fetch 自己报错（断网、DNS 解析不了、超时），不回任何东西；读体抛 = 响应头回了、读内容时才断；拨 = 给完这条把钟往后拨（翻页翻到一半令牌到期） */
export type 响应 = { status?: number; body?: unknown; 抛?: unknown; 拨?: number; 读体抛?: unknown };
export type 录制 = { 路由: Record<string, 响应[]> };
export type 调用 = { 键: string; url: string; body?: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal | null };

export const 起始钟 = 1792810800000; // 北京时间 2026-10-24 11:00

/** 路由键 = 方法 + 路径 + 认页 / 认对象的参数（query 和 body 里的都算） */
export function 键(method: string, url: string, body?: string): string {
  const u = new URL(url);
  const b = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const 选: string[] = [];
  for (const k of ["relationType", "department_id", "page_token", "nextToken"]) if (u.searchParams.get(k)) 选.push(`${k}=${u.searchParams.get(k)}`);
  for (const k of ["dept_id", "nextToken", "cursor", "name", "userid"]) if (b[k] !== undefined) 选.push(`${k}=${String(b[k])}`);
  return `${method} ${u.pathname}${选.length ? `?${选.join("&")}` : ""}`;
}

/** 断网时 Node 的 fetch 抛的样子：TypeError("fetch failed")，cause 带系统错误码 */
export const 断网 = (code = "ENOTFOUND"): 响应 => ({ 抛: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }) });
/** AbortSignal.timeout 到点时 fetch 抛的样子 */
export const 超时: 响应 = { 抛: new DOMException("The operation was aborted due to timeout", "TimeoutError") };

/**
 * 假网：每个键一队响应，一条条给，最后一条一直给；先给 = 插到队头（限流、令牌过期、没权限、断网）。
 * 改 = 整条换掉某个键的录制（字段改名之类），先给 照样插在它前面。
 */
export function 假网(录: 录制, 先给: Record<string, 响应[]> = {}, 改: Record<string, 响应[]> = {}) {
  const 队 = new Map<string, 响应[]>();
  for (const [k, v] of Object.entries({ ...录.路由, ...改 })) 队.set(k, [...v]);
  for (const [k, v] of Object.entries(先给)) 队.set(k, [...v, ...(队.get(k) ?? [])]);
  const 调用们: 调用[] = [];
  const 等过: number[] = [];
  let 钟 = 起始钟;
  const 网: 联网 = {
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const 体 = typeof init?.body === "string" ? init.body : undefined;
      const k = 键(method, url, 体);
      调用们.push({ 键: k, url, body: 体 ? JSON.parse(体) : undefined, headers: { ...(init?.headers as Record<string, string>) }, signal: init?.signal });
      const q = 队.get(k);
      if (!q?.length) throw new Error(`没录这个接口：${k}`);
      const r = q.length > 1 ? q.shift()! : q[0];
      if (r.拨) 钟 += r.拨;
      if (r.抛 !== undefined) throw r.抛;
      if (r.读体抛 !== undefined) {
        const 错 = r.读体抛;
        return new Response(new ReadableStream({ start: (c) => c.error(错) }), { status: r.status ?? 200 });
      }
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
    },
    等: async (ms) => {
      等过.push(ms);
      钟 += ms;
    },
    现在: () => 钟,
  };
  const 调过 = (前缀: string) => 调用们.filter((c) => c.键.startsWith(前缀));
  /** 往后拨钟（令牌到期之类），不算在 等过 里 */
  const 拨钟 = (ms: number) => {
    钟 += ms;
  };
  return { 网, 调用们, 等过, 调过, 拨钟 };
}
