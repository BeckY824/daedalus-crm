/**
 * 团队同步的加密（2026-10-03）：一批改动 → JSON → gzip → AES-256-GCM。**先压缩再加密**：密文压不动。
 * 钥匙只在团队成员的电脑上（.team.json、邀请码里），我们的中转只见得到密文、团队编号、设备、序号、大小。
 * 认证标签不对（钥匙错了、密文被改过）就抛错，不回放半截东西。
 *
 * 2026-10-04 换钥匙（移除成员后旧钥匙作废）：
 *   - 批次带钥匙编号（版本 2）：拆的时候按编号从钥匙环里取；版本 1 的老批次算编号 0
 *   - 每台设备一对 X25519 钥匙：新团队钥匙用每台留下的设备的公钥分别封一份（封给 / 拆自），经中转转交，中转解不开
 */
import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { 改动 } from "./local";

export function 新钥匙(): string {
  return randomBytes(32).toString("base64url");
}

function 钥(k: string): Buffer {
  const b = Buffer.from(k, "base64url");
  if (b.length !== 32) throw new Error("团队钥匙不对（应是 256 位）");
  return b;
}

/** 钥匙环：编号 → 钥匙。当前那把也在里面 */
export type 钥匙环 = Record<string, string>;

function 加密(明: Buffer, 钥匙: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", 钥(钥匙), iv);
  const 密 = Buffer.concat([c.update(明), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), 密]);
}
function 解密(b: Buffer, 钥匙: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", 钥(钥匙), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

/** 封：版本 2（1 字节）+ 钥匙编号（4 字节）+ iv + 标签 + 密文，base64url */
export function 封(东西: 改动[] | unknown, 钥匙: string, 编号 = 0): string {
  const 头 = Buffer.alloc(5);
  头[0] = 2;
  头.writeUInt32BE(编号, 1);
  return Buffer.concat([头, 加密(gzipSync(Buffer.from(JSON.stringify(东西), "utf8")), 钥匙)]).toString("base64url");
}

/** 这一包用的是几号钥匙（不用解开就看得到；中转据此拒收用旧钥匙封的推送） */
export function 包的编号(封好: string): number {
  const b = Buffer.from(封好.slice(0, 8), "base64url");
  if (b[0] === 1) return 0;
  if (b[0] === 2 && b.length >= 5) return b.readUInt32BE(1);
  throw new Error(`不认识的同步包版本 ${b[0]}`);
}

/** 拆：给一把钥匙（老用法）或一个钥匙环 */
export function 拆<T = 改动[]>(封好: string, 钥匙: string | 钥匙环): T {
  const b = Buffer.from(封好, "base64url");
  let 编号 = 0;
  let 体: Buffer;
  if (b[0] === 1) 体 = b.subarray(1);
  else if (b[0] === 2) {
    编号 = b.readUInt32BE(1);
    体 = b.subarray(5);
  } else throw new Error(`不认识的同步包版本 ${b[0]}`);
  const k = typeof 钥匙 === "string" ? 钥匙 : 钥匙[String(编号)];
  if (!k) throw new Error(`没有 ${编号} 号钥匙`);
  return JSON.parse(gunzipSync(解密(体, k)).toString("utf8")) as T;
}

/* ---------------- 设备钥匙对：转交新钥匙用 ---------------- */

/** 一台设备的 X25519 钥匙对（DER 转 base64url）。私钥只留在本机 .team.json */
export function 设备钥匙对(): { 公钥: string; 私钥: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    公钥: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    私钥: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

const 公 = (s: string) => createPublicKey({ key: Buffer.from(s, "base64url"), format: "der", type: "spki" });
const 私 = (s: string) => createPrivateKey({ key: Buffer.from(s, "base64url"), format: "der", type: "pkcs8" });
const 派生 = (共享: Buffer) => Buffer.from(hkdfSync("sha256", 共享, Buffer.alloc(0), "daedalus-team-key-v1", 32)).toString("base64url");

/** 封给某台设备：临时钥匙对 + 对方公钥 → 共享密钥 → AES-GCM。输出：临时公钥长度（2 字节）+ 临时公钥 + 密文 */
export function 封给(对方公钥: string, 明文: string): string {
  const 临时 = generateKeyPairSync("x25519");
  const 共享 = diffieHellman({ privateKey: 临时.privateKey, publicKey: 公(对方公钥) });
  const 临时公 = 临时.publicKey.export({ type: "spki", format: "der" });
  const 长 = Buffer.alloc(2);
  长.writeUInt16BE(临时公.length);
  return Buffer.concat([长, 临时公, 加密(Buffer.from(明文, "utf8"), 派生(共享))]).toString("base64url");
}

export function 拆自(我的私钥: string, 封好: string): string {
  const b = Buffer.from(封好, "base64url");
  const 长 = b.readUInt16BE(0);
  const 临时公 = createPublicKey({ key: b.subarray(2, 2 + 长), format: "der", type: "spki" });
  const 共享 = diffieHellman({ privateKey: 私(我的私钥), publicKey: 临时公 });
  return 解密(b.subarray(2 + 长), 派生(共享)).toString("utf8");
}
