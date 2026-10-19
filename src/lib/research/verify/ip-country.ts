/**
 * 发件 IP → 国家：离线 IP 库（DB-IP 的 IP to Country Lite，CC BY 4.0，免费，每月 1 号更新）。
 * 背调补充方案第二期（2026-10-18）。
 *
 * **在桌面端本机查**：库文件下到本机数据目录（约 4.5 MB），IP 不发给任何人。第一次用时下载，
 * 之后用缓存；超过 40 天再试着换新的（换不成就接着用旧的）。下不下来就是「查不了」，不挡背调。
 * 授权要求署名：真实性那一项的链接里写「IP 国家：DB-IP」。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { 标识 } from "./net";

export { IP库署名 } from "./mail";

/** 桌面端：数据目录下（跟着用户数据走）；服务器 / 实验：RESEARCH_CACHE_DIR；都没有放临时目录 */
export function IP库目录(env: Record<string, string | undefined> = process.env): string {
  if (env.RESEARCH_CACHE_DIR?.trim()) return env.RESEARCH_CACHE_DIR.trim();
  if (env.CRM_DATA_DIR?.trim()) return path.join(env.CRM_DATA_DIR.trim(), "research-cache");
  return path.join(tmpdir(), "crm-research-cache");
}

const 文件名 = "dbip-country-lite.csv.gz";
const 老了 = 40 * 86400_000;

/** 这个月和上个月的下载地址（月初几个小时里这个月的可能还没出） */
export function 下载地址(今: Date = new Date()): string[] {
  const 月 = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const 上 = new Date(Date.UTC(今.getUTCFullYear(), 今.getUTCMonth() - 1, 1));
  return [月(今), 月(上)].map((m) => `https://download.db-ip.com/free/dbip-country-lite-${m}.csv.gz`);
}

export type IP库 = {
  v4始: Uint32Array;
  v4终: Uint32Array;
  v4码: Uint16Array;
  v6始: bigint[];
  v6终: bigint[];
  v6码: Uint16Array;
  码表: string[];
};

export function v4数(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!/^\d{1,3}$/.test(x) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function v6数(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const 尾4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (尾4) {
    const n = v4数(尾4[1]);
    if (n === null) return null;
    s = s.slice(0, -尾4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const 两半 = s.split("::");
  if (两半.length > 2) return null;
  const 左 = 两半[0] ? 两半[0].split(":") : [];
  const 右 = 两半.length === 2 && 两半[1] ? 两半[1].split(":") : [];
  const 缺 = 8 - 左.length - 右.length;
  if ((两半.length === 1 && 缺 !== 0) || 缺 < 0) return null;
  const 段 = [...左, ...Array(两半.length === 2 ? 缺 : 0).fill("0"), ...右];
  let n = BigInt(0);
  for (const x of 段) {
    if (!/^[0-9a-f]{1,4}$/.test(x)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(x, 16));
  }
  return n;
}

/** 解 DB-IP 的 CSV：每行 起始IP,结束IP,国家码（已按起始排好） */
export function 解IP库(csv: string): IP库 {
  const 码表: string[] = [];
  const 码号 = new Map<string, number>();
  const 号 = (c: string) => {
    let i = 码号.get(c);
    if (i === undefined) {
      i = 码表.length;
      码表.push(c);
      码号.set(c, i);
    }
    return i;
  };
  const v4: [number, number, number][] = [];
  const v6始: bigint[] = [];
  const v6终: bigint[] = [];
  const v6码: number[] = [];
  for (const l of csv.split("\n")) {
    const [a, b, c] = l.trim().split(",");
    if (!a || !b || !c || !/^[A-Z]{2}$/.test(c)) continue;
    if (a.includes(":")) {
      const x = v6数(a);
      const y = v6数(b);
      if (x !== null && y !== null) {
        v6始.push(x);
        v6终.push(y);
        v6码.push(号(c));
      }
    } else {
      const x = v4数(a);
      const y = v4数(b);
      if (x !== null && y !== null) v4.push([x, y, 号(c)]);
    }
  }
  v4.sort((p, q) => p[0] - q[0]);
  return {
    v4始: Uint32Array.from(v4.map((x) => x[0])),
    v4终: Uint32Array.from(v4.map((x) => x[1])),
    v4码: Uint16Array.from(v4.map((x) => x[2])),
    v6始,
    v6终,
    v6码: Uint16Array.from(v6码),
    码表,
  };
}

function 二分<T extends number | bigint>(始: ArrayLike<T>, 终: ArrayLike<T>, x: T): number {
  let lo = 0;
  let hi = 始.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (始[mid] > x) hi = mid - 1;
    else if (终[mid] < x) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** 查国家：ISO 两位码；库里没有 / 不是 IP → null。ZZ（DB-IP 里的「保留地址」）也当没有 */
export function 查IP(库: IP库, ip: string): string | null {
  const v4 = v4数(ip.replace(/^::ffff:/i, ""));
  let c: string | undefined;
  if (v4 !== null) {
    const i = 二分(库.v4始, 库.v4终, v4);
    c = i >= 0 ? 库.码表[库.v4码[i]] : undefined;
  } else {
    const v6 = v6数(ip);
    if (v6 === null) return null;
    const i = 二分(库.v6始, 库.v6终, v6);
    c = i >= 0 ? 库.码表[库.v6码[i]] : undefined;
  }
  return c && c !== "ZZ" ? c : null;
}

let 内存: { 库: IP库; 文件时间: number } | null = null;
let 在下: Promise<IP库 | null> | null = null;

async function 下载(目录: string, fetch_: typeof fetch): Promise<boolean> {
  for (const url of 下载地址()) {
    try {
      const res = await fetch_(url, { headers: { "User-Agent": 标识 }, signal: AbortSignal.timeout(60_000), redirect: "follow" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // 先解一遍确认是好的再落盘：下了一半的文件别覆盖掉能用的旧库
      const 库 = 解IP库(gunzipSync(buf).toString("utf8"));
      if (库.v4始.length < 10_000) continue;
      mkdirSync(目录, { recursive: true });
      writeFileSync(path.join(目录, 文件名), buf);
      内存 = { 库, 文件时间: Date.now() };
      return true;
    } catch (e) {
      console.warn("[research/ip] IP 库没下下来：", url, e instanceof Error ? e.message : e);
    }
  }
  return false;
}

/**
 * 拿 IP 库：内存里有就用；本机有文件就读；没有就下载。老了在后台换新的，这一次先用旧的。
 * 开背调时先调一次（不等），真要查的时候已经好了
 */
export function 取IP库(opts: { 目录?: string; fetch?: typeof fetch } = {}): Promise<IP库 | null> {
  const 目录 = opts.目录 ?? IP库目录();
  const f = path.join(目录, 文件名);
  const 换新 = () => {
    if (!在下) 在下 = 下载(目录, opts.fetch ?? fetch).then(() => 内存?.库 ?? null).finally(() => (在下 = null));
    return 在下;
  };
  if (内存) {
    if (Date.now() - 内存.文件时间 > 老了) void 换新();
    return Promise.resolve(内存.库);
  }
  if (existsSync(f)) {
    try {
      const t = statSync(f).mtimeMs;
      内存 = { 库: 解IP库(gunzipSync(readFileSync(f)).toString("utf8")), 文件时间: t };
      if (Date.now() - t > 老了) void 换新();
      return Promise.resolve(内存.库);
    } catch (e) {
      console.warn("[research/ip] 本机的 IP 库读不了，重新下：", e instanceof Error ? e.message : e);
    }
  }
  return 换新();
}

/** 测试用：清掉内存里的库 */
export function 清IP库内存() {
  内存 = null;
  在下 = null;
}
