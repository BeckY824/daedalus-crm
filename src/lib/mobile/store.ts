/**
 * 手机上的本地库（2026-10-15，手机端方案 3.3）：浏览器的 IndexedDB。
 *
 *   - 业务数据每一行再用一把 **不可导出** 的 AES-GCM 钥匙加密一层：钥匙是 WebCrypto 生成的 CryptoKey，原样存进 IndexedDB，
 *     页面脚本也拿不出原始字节；直接翻浏览器存储文件看到的只有密文
 *   - 打开时整库读进内存（一个人能看的客户也就几千行），读写都在内存里；改过的行攒着，存盘() 一个事务写回
 *   - 还存几样小东西（kv）：登录令牌、设备号和私钥、团队身份、同步状态
 *   - kv 里带「私钥」的值（设备、团队身份）：私钥导成 PKCS8、用上面那把行钥匙加密后再存，读时解开导回 CryptoKey。
 *     因为 Safari（WebKit）存 X25519 的 CryptoKey 不报错、读回来却是 undefined（整条丢掉）——2026-10-15 真 iPhone 上
 *     配对数字每 30 秒变一次、电脑点了允许手机也收不到，就是它。老格式（私钥是 CryptoKey 本身，安卓上已有的）照认。
 *     浏览器没内置 X25519 时私钥本来就是原始 32 字节（crypto-web.ts），同样封起来存
 *
 * 只在浏览器里用（window.indexedDB）。测试用 sync.ts 的 内存库。
 */
import type { 设备私钥 } from "@/lib/sync/crypto-web";
import { 行键 } from "@/lib/sync/scope-policy";
import { 内存库, type 记录 } from "./sync";

const 库名 = "daedalus-mobile";
const 版本 = 1;

function 开库(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(库名, 版本);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("rows")) db.createObjectStore("rows");
      if (!db.objectStoreNames.contains("tombs")) db.createObjectStore("tombs");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error ?? new Error("打不开手机上的本地库"));
  });
}
const 等 = <T>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const 等完 = (t: IDBTransaction) => new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error ?? new Error("写本地库被中断")); });

const 字 = new TextEncoder();
const 读字 = new TextDecoder();
type 密行 = { iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer };
type 带私钥 = { 私钥: 设备私钥 };
/** 形：没有 = PKCS8（内置 X25519 导出的）；"raw" = 原始 32 字节（纯 JS 实现的） */
type 封私钥 = { 私钥封: 密行 & { 形?: "raw" } };
const 原始吗 = (k: unknown): k is { raw: Uint8Array } => typeof k === "object" && k !== null && (k as { raw?: unknown }).raw instanceof Uint8Array;
const 带私钥吗 = (v: unknown): v is 带私钥 => typeof v === "object" && v !== null && ((v as 带私钥).私钥 instanceof CryptoKey || 原始吗((v as 带私钥).私钥));
const 封私钥吗 = (v: unknown): v is 封私钥 => typeof v === "object" && v !== null && "私钥封" in v;
const 新行钥匙 = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

export class 本地库 extends 内存库 {
  private 脏 = new Set<string>();
  private 墓脏 = new Set<string>();
  private constructor(private db: IDBDatabase, private 钥: CryptoKey) { super(); }

  static async 打开(): Promise<本地库> {
    const db = await 开库();
    let 钥 = await 等(db.transaction("kv").objectStore("kv").get("rowKey")) as CryptoKey | undefined;
    if (!钥) {
      钥 = await 新行钥匙();
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(钥, "rowKey");
      await 等完(t);
    }
    const 库 = new 本地库(db, 钥);
    const t = db.transaction(["rows", "tombs"]);
    const [键们, 值们, 墓键, 墓值] = await Promise.all([
      等(t.objectStore("rows").getAllKeys()), 等(t.objectStore("rows").getAll()),
      等(t.objectStore("tombs").getAllKeys()), 等(t.objectStore("tombs").getAll()),
    ]);
    for (let i = 0; i < 键们.length; i++) {
      try {
        const v = 值们[i] as 密行;
        const 明 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: v.iv }, 钥, v.ct);
        库.行.set(String(键们[i]), JSON.parse(读字.decode(明)) as 记录);
      } catch { /* 解不开的一行（钥匙换过、存坏了）：丢掉，下一轮同步会补回来 */ }
    }
    for (let i = 0; i < 墓键.length; i++) 库.墓碑.set(String(墓键[i]), String(墓值[i]));
    return 库;
  }

  override async 放(x: 记录) { await super.放(x); this.脏.add(行键(x.t, x.k)); }
  override async 删(t: string, k: string) { await super.删(t, k); this.脏.add(行键(t, k)); }
  override async 记墓(t: string, k: string, h: string) { await super.记墓(t, k, h); this.墓脏.add(行键(t, k)); }

  /** 把攒着的改动一次写回。先在事务外把要写的都加密好（事务里不能 await 别的） */
  async 存盘(): Promise<void> {
    if (!this.脏.size && !this.墓脏.size) return;
    const 脏 = [...this.脏], 墓脏 = [...this.墓脏];
    this.脏.clear(); this.墓脏.clear();
    const 写: [string, 密行 | null][] = [];
    for (const k of 脏) {
      const x = this.行.get(k);
      if (!x) { 写.push([k, null]); continue; }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      写.push([k, { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.钥, 字.encode(JSON.stringify(x))) }]);
    }
    const t = this.db.transaction(["rows", "tombs"], "readwrite");
    for (const [k, v] of 写) { if (v) t.objectStore("rows").put(v, k); else t.objectStore("rows").delete(k); }
    for (const k of 墓脏) { const h = this.墓碑.get(k); if (h) t.objectStore("tombs").put(h, k); }
    await 等完(t);
  }

  async 读(名: string): Promise<unknown> {
    const v = await 等(this.db.transaction("kv").objectStore("kv").get(名));
    if (!封私钥吗(v)) return v;
    const { 私钥封, ...其余 } = v;
    try {
      const pk = await crypto.subtle.decrypt({ name: "AES-GCM", iv: 私钥封.iv }, this.钥, 私钥封.ct);
      if (私钥封.形 === "raw") return { ...其余, 私钥: { raw: new Uint8Array(pk) } };
      // 导回来仍可导出：之后 写 团队身份 时要再封一次
      return { ...其余, 私钥: await crypto.subtle.importKey("pkcs8", pk, { name: "X25519" }, true, ["deriveBits"]) };
    } catch {
      return undefined; // 行钥匙换过 / 存坏了：当没有，重新登录授权
    }
  }
  async 写(名: string, 值: unknown): Promise<void> {
    let 存 = 值;
    // 不可导出的老私钥（安卓上已有的）没法封，原样存——Chrome 存得住
    if (带私钥吗(值) && (原始吗(值.私钥) || 值.私钥.extractable)) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const 原始 = 原始吗(值.私钥);
      const pk = 原始吗(值.私钥) ? new Uint8Array(值.私钥.raw) : await crypto.subtle.exportKey("pkcs8", 值.私钥);
      const { 私钥: _, ...其余 } = 值;
      const 封 = { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.钥, pk) };
      存 = { ...其余, 私钥封: 原始 ? { ...封, 形: "raw" as const } : 封 };
    }
    const t = this.db.transaction("kv", "readwrite");
    if (存 === undefined) t.objectStore("kv").delete(名); else t.objectStore("kv").put(存, 名);
    await 等完(t);
  }

  /** 退出登录 / 被移除：业务数据、团队身份、令牌全清（行钥匙也换一把） */
  async 清空(): Promise<void> {
    this.行.clear(); this.墓碑.clear(); this.脏.clear(); this.墓脏.clear();
    // 新钥匙同一个事务里存回去：不然下次打开又生成一把，清空后才存的设备私钥就解不开了
    const 新 = await 新行钥匙();
    const t = this.db.transaction(["rows", "tombs", "kv"], "readwrite");
    t.objectStore("rows").clear(); t.objectStore("tombs").clear(); t.objectStore("kv").clear();
    t.objectStore("kv").put(新, "rowKey");
    await 等完(t);
    this.钥 = 新;
  }
}

/** 请浏览器别在空间紧张时清掉这个站的数据（装到主屏幕后基本都会给；不给也不影响用） */
export async function 申请长期保存(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
