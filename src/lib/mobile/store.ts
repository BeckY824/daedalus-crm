/**
 * 手机上的本地库（2026-10-15，手机端方案 3.3）：浏览器的 IndexedDB。
 *
 *   - 业务数据每一行再用一把 **不可导出** 的 AES-GCM 钥匙加密一层：钥匙是 WebCrypto 生成的 CryptoKey，原样存进 IndexedDB，
 *     页面脚本也拿不出原始字节；直接翻浏览器存储文件看到的只有密文
 *   - 打开时整库读进内存（一个人能看的客户也就几千行），读写都在内存里；改过的行攒着，存盘() 一个事务写回
 *   - 还存几样小东西（kv）：登录令牌、设备号和私钥、团队身份、同步状态
 *
 * 只在浏览器里用（window.indexedDB）。测试用 sync.ts 的 内存库。
 */
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

export class 本地库 extends 内存库 {
  private 脏 = new Set<string>();
  private 墓脏 = new Set<string>();
  private constructor(private db: IDBDatabase, private 钥: CryptoKey) { super(); }

  static async 打开(): Promise<本地库> {
    const db = await 开库();
    let 钥 = await 等(db.transaction("kv").objectStore("kv").get("rowKey")) as CryptoKey | undefined;
    if (!钥) {
      钥 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
    return 等(this.db.transaction("kv").objectStore("kv").get(名));
  }
  async 写(名: string, 值: unknown): Promise<void> {
    const t = this.db.transaction("kv", "readwrite");
    if (值 === undefined) t.objectStore("kv").delete(名); else t.objectStore("kv").put(值, 名);
    await 等完(t);
  }

  /** 退出登录 / 被移除：业务数据、团队身份、令牌全清（行钥匙也换一把） */
  async 清空(): Promise<void> {
    this.行.clear(); this.墓碑.clear(); this.脏.clear(); this.墓脏.clear();
    const t = this.db.transaction(["rows", "tombs", "kv"], "readwrite");
    t.objectStore("rows").clear(); t.objectStore("tombs").clear(); t.objectStore("kv").clear();
    await 等完(t);
  }
}

/** 请浏览器别在空间紧张时清掉这个站的数据（装到主屏幕后基本都会给；不给也不影响用） */
export async function 申请长期保存(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
