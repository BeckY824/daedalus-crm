/**
 * 团队同步加密的浏览器版（2026-10-15，手机端）。和 crypto.ts 是同一套格式，一个字节都不能差：
 * 桌面端封的包手机解得开，手机封的包桌面端解得开——tests/sync-crypto-web.test.ts 两个方向逐项对着验。
 *
 * 只用 WebCrypto（globalThis.crypto.subtle）和浏览器自带的 CompressionStream，不碰 node: 模块，
 * 所以手机浏览器、Node 22+ 里都能跑。WebCrypto 全是异步的，函数名照 crypto.ts、都返回 Promise。
 *
 * 格式对照 crypto.ts：
 *   - AES-256-GCM：iv(12) + 标签(16) + 密文。WebCrypto 吐的是「密文 + 标签」，这里挪一下位置
 *   - 范围包（版本 4）：头（版本 1 字节 + 钥匙编号 4 字节）+ 上面那段；AAD = 头 + `|scoped|团队|设备|事件|sha256(规范串(meta))`
 *   - 版本 3 的包（钥匙环）：AAD = 头 + `|团队|设备`
 *   - 封给 / 拆自：X25519 临时钥匙 + 对方公钥 → HKDF-SHA256（盐为空，info "daedalus-team-key-v1"）→ AES-GCM；
 *     输出：临时公钥长度（2 字节）+ 临时公钥（SPKI DER）+ 密文
 *   - 签名：Ed25519，公钥是 JWK 的 x；签的是 `用途|原文`
 *
 * X25519 / Ed25519 浏览器没内置时（2026-10-15 真机：华为浏览器 17、QQ 浏览器 20.6，内核 Chrome 121–132），
 * 换成 @noble/curves 的纯 JS 实现，算法一样、字节一样。这时私钥是 { raw: 32 字节 }，而不是 CryptoKey。
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { 规范串 } from "./canon";

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("这个浏览器不支持加密（需要 https 打开）");
  return s;
};
const 字 = new TextEncoder();
const 读字 = new TextDecoder();

/* ---------------- base64url / 字节 ---------------- */

export function 转b64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function 解b64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const 补 = t + "=".repeat((4 - (t.length % 4)) % 4);
  const bin = atob(补);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const 拼 = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of xs) { out.set(x, i); i += x.length; }
  return out;
};
/** TS 5.7 起 Uint8Array 带了 buffer 类型参数，WebCrypto 要的是 ArrayBuffer 那种——拷一份成干净的 */
const 纯 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const 头 = (版本: number, 编号: number) => {
  const h = new Uint8Array(5);
  h[0] = 版本;
  new DataView(h.buffer).setUint32(1, 编号);
  return h;
};
const 读编号 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1);

async function 压(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([纯(b)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
async function 解压(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([纯(b)]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
async function sha256hex(s: string) {
  const d = new Uint8Array(await subtle().digest("SHA-256", 字.encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- AES-256-GCM ---------------- */

export type 钥匙环 = Record<string, string>;

async function aes钥(k: string, 用途: KeyUsage[]) {
  const b = 解b64u(k);
  if (b.length !== 32) throw new Error("团队钥匙不对（应是 256 位）");
  return subtle().importKey("raw", 纯(b), "AES-GCM", false, 用途);
}
async function 加密(明: Uint8Array, 钥匙: string, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const 出 = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: 纯(aad) } : {}) }, await aes钥(钥匙, ["encrypt"]), 纯(明)));
  // WebCrypto：密文 + 标签；桌面端的格式：iv + 标签 + 密文
  return 拼(iv, 出.subarray(出.length - 16), 出.subarray(0, 出.length - 16));
}
async function 解密(b: Uint8Array, 钥匙: string, aad?: Uint8Array): Promise<Uint8Array> {
  if (b.length < 28) throw new Error("密文太短");
  const 合 = 拼(b.subarray(28), b.subarray(12, 28));
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: 纯(b.subarray(0, 12)), ...(aad ? { additionalData: 纯(aad) } : {}) }, await aes钥(钥匙, ["decrypt"]), 合));
}

/* ---------------- 版本 1–3 的包（钥匙环用版本 3） ---------------- */

export type 绑定 = { teamId: string; device: string };
const 附加 = (h: Uint8Array, x: 绑定) => 拼(h, 字.encode(`|${x.teamId}|${x.device}`));

export async function 拆<T>(封好: string, 钥匙: string | 钥匙环, 绑?: 绑定): Promise<T> {
  const b = 解b64u(封好);
  let 编号 = 0, 体: Uint8Array, aad: Uint8Array | undefined;
  if (b[0] === 1) 体 = b.subarray(1);
  else if (b[0] === 2 || b[0] === 3) {
    编号 = 读编号(b);
    体 = b.subarray(5);
    if (b[0] === 3) {
      if (!绑) throw new Error("版本 3 的同步包要说明是哪个团队、哪台设备的");
      aad = 附加(b.subarray(0, 5), 绑);
    }
  } else throw new Error(`不认识的同步包版本 ${b[0]}`);
  const k = typeof 钥匙 === "string" ? 钥匙 : 钥匙[String(编号)];
  if (!k) throw new Error(`没有 ${编号} 号钥匙`);
  return JSON.parse(读字.decode(await 解压(await 解密(体, k, aad)))) as T;
}

/** 只给测试和以后的「手机封钥匙环」用：版本 3（给了绑定）或版本 2 */
export async function 封(东西: unknown, 钥匙: string, 编号 = 0, 绑?: 绑定): Promise<string> {
  const h = 头(绑 ? 3 : 2, 编号);
  return 转b64u(拼(h, await 加密(await 压(字.encode(JSON.stringify(东西))), 钥匙, 绑 ? 附加(h, 绑) : undefined)));
}

/* ---------------- 范围同步（v4） ---------------- */

export type 范围绑定 = { teamId: string; device: string; eventId: string; meta: unknown };
const 范围附加 = async (h: Uint8Array, x: 范围绑定) => 拼(h, 字.encode(`|scoped|${x.teamId}|${x.device}|${x.eventId}|${await sha256hex(规范串(x.meta))}`));

export async function 封范围(东西: unknown, 钥匙: string, 编号: number, 绑: 范围绑定): Promise<string> {
  const h = 头(4, 编号);
  return 转b64u(拼(h, await 加密(await 压(字.encode(JSON.stringify(东西))), 钥匙, await 范围附加(h, 绑))));
}
export async function 拆范围<T>(封好: string, 钥匙: string | 钥匙环, 绑: 范围绑定): Promise<T> {
  const b = 解b64u(封好);
  if (b[0] !== 4 || b.length < 33) throw new Error("范围密文版本不对");
  const 编号 = 读编号(b);
  const k = typeof 钥匙 === "string" ? 钥匙 : 钥匙[String(编号)];
  if (!k) throw new Error(`没有 ${编号} 号钥匙`);
  return JSON.parse(读字.decode(await 解压(await 解密(b.subarray(5), k, await 范围附加(b.subarray(0, 5), 绑))))) as T;
}

/** 事件编号：团队钥匙做 HMAC-SHA256（hex），和桌面端 client.ts 的 事件编号 同一算法——同一事件重发得到同一编号 */
export async function 事件编号(团队钥匙: string, 标签: string, 改动: unknown): Promise<string> {
  const k = await subtle().importKey("raw", 纯(解b64u(团队钥匙)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const d = new Uint8Array(await subtle().sign("HMAC", k, 字.encode(`${标签}|${规范串(改动)}`)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- 老板的签名：新钥匙只认老板发的 ---------------- */

export async function 验(签好: string, 用途: string, 公钥: string): Promise<string | null> {
  const i = 签好.lastIndexOf(".");
  if (i <= 0) return null;
  const 原文 = 签好.slice(0, i);
  try {
    const 签 = 解b64u(签好.slice(i + 1)), 文 = 字.encode(`${用途}|${原文}`);
    // 纯 JS 那边按 RFC 8032 严格验（zip215: false），和 WebCrypto / Node 一样
    if (!(await 有内置("Ed25519"))) return ed25519.verify(签, 文, 解b64u(公钥), { zip215: false }) ? 原文 : null;
    const k = await subtle().importKey("jwk", { kty: "OKP", crv: "Ed25519", x: 公钥 }, { name: "Ed25519" }, false, ["verify"]);
    return (await subtle().verify({ name: "Ed25519" }, k, 纯(签), 文)) ? 原文 : null;
  } catch {
    return null;
  }
}

/* ---------------- 设备钥匙对：电脑授权时把团队钥匙封给这台手机 ---------------- */

/** 设备私钥：浏览器内置 X25519 时是 CryptoKey；没内置时是原始 32 字节（纯 JS 实现用） */
export type 设备私钥 = CryptoKey | { raw: Uint8Array };

const 内置: Partial<Record<"X25519" | "Ed25519", Promise<boolean>>> = {};
/** 浏览器内置这个算法吗：试生成一把钥匙，结果记住（一个页面只试一次） */
export function 有内置(算法: "X25519" | "Ed25519"): Promise<boolean> {
  return (内置[算法] ??= subtle().generateKey({ name: 算法 }, false, 算法 === "X25519" ? ["deriveBits"] : ["sign", "verify"]).then(() => true, () => false));
}

/** X25519 公钥的 SPKI DER = 固定 12 字节头 + 32 字节原始公钥（和 Node / 桌面端导出的一样） */
const X25519头 = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);
const 包公钥 = (raw: Uint8Array) => 拼(X25519头, raw);
function 拆公钥(spki: Uint8Array): Uint8Array {
  if (spki.length !== 44 || X25519头.some((b, i) => spki[i] !== b)) throw new Error("公钥格式不对");
  return spki.subarray(12);
}

/**
 * 手机自己的 X25519 钥匙对。公钥导成 SPKI DER 的 base64url，和桌面端 设备钥匙对 的格式一样。
 * 内置时私钥默认**不可导出**（方案 3.3）；手机端传 可导出 = true，本地库要把它封起来再存（store.ts）
 */
export async function 设备钥匙对(可导出 = false): Promise<{ 公钥: string; 私钥: 设备私钥 }> {
  if (!(await 有内置("X25519"))) {
    const raw = x25519.utils.randomSecretKey();
    return { 公钥: 转b64u(包公钥(x25519.getPublicKey(raw))), 私钥: { raw } };
  }
  const p = (await subtle().generateKey({ name: "X25519" }, 可导出, ["deriveBits"])) as CryptoKeyPair;
  return { 公钥: 转b64u(new Uint8Array(await subtle().exportKey("spki", p.publicKey))), 私钥: p.privateKey };
}
/** 测试用：把桌面端格式的私钥（PKCS8 DER base64url）导进来 */
export async function 导入设备私钥(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", 纯(解b64u(pkcs8)), { name: "X25519" }, false, ["deriveBits"]);
}

async function 派生(共享: Uint8Array): Promise<string> {
  const ikm = await subtle().importKey("raw", 纯(共享), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: 字.encode("daedalus-team-key-v1") }, ikm, 256);
  return 转b64u(new Uint8Array(bits));
}
async function 共享密钥(私: 设备私钥, 公spki: Uint8Array): Promise<Uint8Array> {
  // 纯 JS 那边对全零结果（对方给了小阶点）会抛错，和 WebCrypto 一样拦下
  if (!(私 instanceof CryptoKey)) return x25519.getSharedSecret(私.raw, 拆公钥(公spki));
  const pub = await subtle().importKey("spki", 纯(公spki), { name: "X25519" }, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: pub }, 私, 256));
}

export async function 封给(对方公钥: string, 明文: string): Promise<string> {
  let 临时公: Uint8Array, 共享: Uint8Array;
  if (await 有内置("X25519")) {
    const 临时 = (await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    临时公 = new Uint8Array(await subtle().exportKey("spki", 临时.publicKey));
    共享 = await 共享密钥(临时.privateKey, 解b64u(对方公钥));
  } else {
    const raw = x25519.utils.randomSecretKey();
    临时公 = 包公钥(x25519.getPublicKey(raw));
    共享 = await 共享密钥({ raw }, 解b64u(对方公钥));
  }
  const k = await 派生(共享);
  const 长 = new Uint8Array(2);
  new DataView(长.buffer).setUint16(0, 临时公.length);
  return 转b64u(拼(长, 临时公, await 加密(字.encode(明文), k)));
}
export async function 拆自(我的私钥: 设备私钥, 封好: string): Promise<string> {
  const b = 解b64u(封好);
  const 长 = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(0);
  const k = await 派生(await 共享密钥(我的私钥, b.subarray(2, 2 + 长)));
  return 读字.decode(await 解密(b.subarray(2 + 长), k));
}

/**
 * 配对数字：手机公钥的 sha256 取前 4 字节、模一百万，补成 6 位。手机和电脑各算一遍显示出来，用户对一眼——
 * 中转被人动了、把手机的公钥换成别人的，两边数字就对不上，电脑那边别点允许（方案 3.2）。
 */
export async function 配对数字(公钥: string): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", 字.encode(`daedalus-mobile-pair|${公钥}`)));
  const n = new DataView(d.buffer).getUint32(0) % 1_000_000;
  return String(n).padStart(6, "0");
}
