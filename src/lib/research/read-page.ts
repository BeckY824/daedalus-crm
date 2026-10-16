import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import type { 读页结果 } from "./types";

/**
 * 背调读网页（服务器这一头，api/gateway/v1/research/read 用）。
 *
 * 这是**替别人去取任意网址**：网址是模型挑的、桌面端传上来的，等于外面的人能让我们的服务器去连任何地方。
 * 不设防的话，一句「读一下 http://169.254.169.254/…」或者 http://100.100.100.200（阿里云元数据）
 * 就能把云主机的临时凭证读出来，或者摸进同机的其它容器（Luxe Ops、Caddy 后台）。所以：
 *
 *   1. 只认 http / https、只认 80 / 443 端口、网址里不许带账号密码
 *   2. 域名先自己解析，**解析出来的每一个地址**都得是公网地址（内网、回环、链路本地、CGNAT、
 *      保留段、IPv4 映射的 IPv6 一律不行）——只查一个的话，A 记录里混一个 127.0.0.1 就过去了
 *   3. **连接钉在刚查过的那个地址上**（http.request 的 lookup），不让 fetch 自己再解析一遍：
 *      查的时候是公网、连的时候变成 127.0.0.1（DNS rebinding）这一招就没用了
 *   4. 跳转自己跟（最多 3 跳），每一跳重新走一遍 1–3：公网页面 302 到内网地址是最常见的绕法
 *   5. 15 秒超时、最多读 2 MB、只收网页和纯文本
 *
 * 出错一律抛 读页出错，message 是给用户看的中文（「这个网址读不了：…」）。
 */

export class 读页出错 extends Error {
  constructor(原因: string) {
    super(`这个网址读不了：${原因}`);
    this.name = "读页出错";
  }
}

export const 读页超时毫秒 = 15_000;
export const 最多字节 = 2 * 1024 * 1024;
export const 最多字数 = 12_000;
const 最多跳转 = 3;
const 收的类型 = ["text/html", "text/plain", "application/xhtml+xml"];

type 取页 = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;
type 解析 = (host: string) => Promise<{ address: string; family: number }[]>;

/* ---------------- 地址是不是公网 ---------------- */

function v4转数(ip: string): number {
  return ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
}

/** 不能连的 IPv4 段：私网、回环、链路本地（含 169.254.169.254 元数据）、CGNAT（含阿里云 100.100.100.200）、文档 / 测试 / 保留 / 组播 */
const 内网v4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4是内网(ip: string): boolean {
  const n = v4转数(ip);
  return 内网v4.some(([网, 位]) => {
    const 掩 = 位 === 0 ? 0 : (0xffffffff << (32 - 位)) >>> 0;
    return ((n & 掩) >>> 0) === ((v4转数(网) & 掩) >>> 0);
  });
}

/** IPv6 展开成 8 段数字。带 IPv4 尾巴的（::ffff:1.2.3.4）先把尾巴换成两段 */
function v6展开(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const 尾 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (尾) {
    const n = v4转数(尾[1]);
    s = s.slice(0, -尾[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [前, 后, 多] = s.split("::");
  if (多 !== undefined) return null;
  const a = 前 ? 前.split(":") : [];
  const b = 后 !== undefined ? (后 ? 后.split(":") : []) : null;
  const 段 = b ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  if (段.length !== 8) return null;
  const 数 = 段.map((x) => parseInt(x, 16));
  return 数.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff) ? null : 数;
}

function v6是内网(ip: string): boolean {
  const g = v6展开(ip);
  if (!g) return true; // 认不出来的一律当不能连
  const 嵌的v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // ::ffff:a.b.c.d（IPv4 映射）和 ::a.b.c.d（已废弃的兼容格式）：按里面那个 IPv4 判。:: 和 ::1 也在这一支里
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0) return true; // ::、::1
    return v4是内网(嵌的v4(g[6], g[7]));
  }
  // 64:ff9b::/96（NAT64）里嵌的也是 IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4是内网(嵌的v4(g[6], g[7]));
  // 2002::/16（6to4）：第 2、3 段是 IPv4
  if (g[0] === 0x2002) return v4是内网(嵌的v4(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（废弃但还有人用）
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 文档
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 丢弃
  return false;
}

/** 这个 IP 能不能连。导出给测试用 */
export function 是内网地址(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ""));
  if (v === 4) return v4是内网(ip);
  if (v === 6) return v6是内网(ip);
  return true;
}

/* ---------------- 一跳 ---------------- */

/** 查这一跳的网址能不能连，能连就返回要钉住的地址 */
/**
 * 代理软件「假 IP」模式（Clash / Surge 的 fake-ip）给的地址：198.18.0.0/15。开着这类代理的电脑上，
 * 每个外网域名都解析到这一段，真正的连接由代理去打——内网防护照规矩会把它们全挡掉。
 * **只有本机跑对比实验时才放行**（scripts/research-bench.ts，BENCH_ALLOW_FAKE_IP=1）；服务器上的读页从不传这个选项：
 * 服务器没有这种代理，那一段在服务器上出现就是有人在探内网。
 */
export function 是代理假IP(ip: string): boolean {
  const m = ip.replace(/^::ffff:/i, "").match(/^198\.(18|19)\.\d{1,3}\.\d{1,3}$/);
  return Boolean(m);
}

async function 查网址(raw: string, resolve: 解析, 放行代理假IP = false): Promise<{ url: URL; 地址: { address: string; family: number } }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new 读页出错("网址格式不对");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new 读页出错("只支持 http / https 网址");
  if (url.username || url.password) throw new 读页出错("网址里不能带账号密码");
  if (url.port && url.port !== "80" && url.port !== "443") throw new 读页出错("只读 80 / 443 端口的网页");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new 读页出错("不能读内网地址");
  }
  let 地址们: { address: string; family: number }[];
  if (isIP(host)) 地址们 = [{ address: host, family: isIP(host) }];
  else {
    try {
      地址们 = await resolve(host);
    } catch {
      throw new 读页出错("域名解析不到");
    }
  }
  if (地址们.length === 0) throw new 读页出错("域名解析不到");
  if (地址们.some((a) => 是内网地址(a.address) && !(放行代理假IP && 是代理假IP(a.address)))) throw new 读页出错("不能读内网地址");
  return { url, 地址: 地址们[0] };
}

const 默认解析: 解析 = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/**
 * 默认的取页：node:http(s) 发请求，连接钉在 查网址 查过的那个地址上（见文件头第 3 条）。
 * 不用全局 fetch：它会自己再解析一遍域名，钉不住。SNI 和 Host 头照旧是原来的域名，https 证书照常校验。
 * 导出给测试用（它本身不查地址，查地址在 查网址 里）
 */
export function 钉住地址取(地址: { address: string; family: number }): 取页 {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        u,
        {
          method: "GET",
          headers: init.headers,
          signal: init.signal,
          lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            if (opts?.all) cb(null, [地址]);
            else cb(null, 地址.address, 地址.family);
          }) as unknown as http.RequestOptions["lookup"],
        },
        (res) => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 502;
          if ([101, 204, 205, 304].includes(status) || (status >= 300 && status < 400)) {
            res.resume();
            resolve(new Response(null, { status: status === 101 ? 502 : status, headers }));
            return;
          }
          // 对方压缩了就在这儿解开；解不开的编码交给后面按「不是网页」处理
          const 编码 = (res.headers["content-encoding"] ?? "").toLowerCase();
          const 流 =
            编码 === "gzip" || 编码 === "x-gzip" ? res.pipe(zlib.createGunzip())
              : 编码 === "deflate" ? res.pipe(zlib.createInflate())
                : 编码 === "br" ? res.pipe(zlib.createBrotliDecompress())
                  : res;
          headers.delete("content-encoding");
          headers.delete("content-length");
          resolve(new Response(Readable.toWeb(流 as Readable) as ReadableStream<Uint8Array>, { status, headers }));
        },
      );
      req.on("error", reject);
      req.end();
    });
}

/** 读到 最多字节 为止，多的不要（读到的部分照样用，记一笔截断） */
async function 读正文(res: Response): Promise<{ bytes: Uint8Array; 截断了: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), 截断了: false };
  const 块们: Uint8Array[] = [];
  let 共 = 0;
  let 截断了 = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (共 + value.byteLength > 最多字节) {
      块们.push(value.subarray(0, 最多字节 - 共));
      共 = 最多字节;
      截断了 = true;
      await reader.cancel().catch(() => {});
      break;
    }
    块们.push(value);
    共 += value.byteLength;
  }
  const out = new Uint8Array(共);
  let o = 0;
  for (const b of 块们) {
    out.set(b, o);
    o += b.byteLength;
  }
  return { bytes: out, 截断了 };
}

/** 按响应头或 <meta charset> 解码。国内不少公司官网还是 GBK，按 UTF-8 硬解出来是一屏乱码 */
function 解码(bytes: Uint8Array, contentType: string): string {
  const 头 = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const 前段 = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const meta = 前段.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  for (const label of [头, meta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 认不得的编码名，换下一个
    }
  }
  return new TextDecoder().decode(bytes);
}

/* ---------------- HTML → 正文 ---------------- */

const 实体: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };

function 解实体(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return 实体[e.toLowerCase()] ?? m;
  });
}

/**
 * 网页转成给模型读的正文：去掉脚本、样式、导航、页脚、图形，块级标签换行，空白合并。
 * 不求排版好看，只求模型读到的是正文而不是一堆菜单和 JS。导出给测试用
 */
export function 网页转文字(html: string): { title: string; text: string } {
  const title = 解实体((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|template|iframe|head|title|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|header|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt|dl|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  s = 解实体(s);
  const 行们 = s.split("\n").map((l) => l.replace(/[ \t\f\v 　]+/g, " ").trim()).filter(Boolean);
  return { title, text: 行们.join("\n") };
}

/* ---------------- 对外 ---------------- */

/**
 * 读一页。opts.fetchImpl / resolveImpl 是给测试换掉网络用的；
 * **换了 fetchImpl 就钉不住地址了**（钉地址靠默认那份 http.request），线上不传
 */
export async function 读网页(
  url: string,
  opts: { signal?: AbortSignal; fetchImpl?: 取页; resolveImpl?: 解析; /** 只给本机对比实验：见 是代理假IP */ 放行代理假IP?: boolean } = {},
): Promise<读页结果> {
  const resolve = opts.resolveImpl ?? 默认解析;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(读页超时毫秒)]) : AbortSignal.timeout(读页超时毫秒);
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; DaedalusCRM-Research/1.0)",
    Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  let 当前 = url;
  let res: Response | null = null;
  try {
    for (let 跳 = 0; ; 跳++) {
      const { url: u, 地址 } = await 查网址(当前, resolve, opts.放行代理假IP);
      const 取 = opts.fetchImpl ?? 钉住地址取(地址);
      res = await 取(u.toString(), { signal, headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (跳 >= 最多跳转) throw new 读页出错("跳转次数太多");
        当前 = new URL(res.headers.get("location")!, u).toString();
        continue;
      }
      当前 = u.toString();
      break;
    }
  } catch (e) {
    if (e instanceof 读页出错) throw e;
    const 超时 = signal.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
    throw new 读页出错(超时 ? "等了 15 秒没打开" : "连不上对方网站");
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new 读页出错(`对方网站返回 ${res.status}`);
  }
  const 类型 = (res.headers.get("content-type") ?? "").toLowerCase();
  const 主类型 = 类型.split(";")[0].trim();
  // 没写类型的按网页试一试（不少老站不带这个头）；写了别的（PDF、图片、压缩包）就不读
  if (主类型 && !收的类型.includes(主类型)) {
    await res.body?.cancel().catch(() => {});
    throw new 读页出错(`不是网页（${主类型}）`);
  }

  let 正文: { bytes: Uint8Array; 截断了: boolean };
  try {
    正文 = await 读正文(res);
  } catch {
    throw new 读页出错(signal.aborted ? "等了 15 秒没读完" : "读到一半断了");
  }
  const raw = 解码(正文.bytes, 类型);
  const { title, text } = 主类型 === "text/plain" ? { title: "", text: raw.replace(/[ \t]+/g, " ").trim() } : 网页转文字(raw);
  if (!text) throw new 读页出错("页面上没有文字内容（可能要登录，或者内容是脚本画出来的）");
  const 太长 = text.length > 最多字数;
  return {
    url: 当前,
    title: title || new URL(当前).hostname,
    text: 太长 ? text.slice(0, 最多字数) : text,
    截断了: 太长 || 正文.截断了,
  };
}
