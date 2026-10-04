/**
 * 团队同步的加密（2026-10-03）：一批改动 → JSON → gzip → AES-256-GCM。**先压缩再加密**：密文压不动。
 * 钥匙只在团队成员的电脑上（.team.json、邀请码里），我们的中转只见得到密文、团队编号、设备、序号、大小。
 * 认证标签不对（钥匙错了、密文被改过）就抛错，不回放半截东西。
 *
 * 2026-10-04 换钥匙（移除成员后旧钥匙作废）：
 *   - 批次带钥匙编号（版本 2）：拆的时候按编号从钥匙环里取；版本 1 的老批次算编号 0
 *   - 每台设备一对 X25519 钥匙：新团队钥匙用每台留下的设备的公钥分别封一份（封给 / 拆自），经中转转交，中转解不开
 *
 * 2026-10-04 换钥匙复查（中 1：中转被攻破时能塞自己的钥匙）：
 *   - 批次版本 3：GCM 的附加数据（AAD）里绑上头（版本、钥匙编号）、团队编号、设备——中转改不了「这一批是谁推的、哪个团队的」
 *   - 老板（建团队的人）一对 Ed25519 签名钥匙：公钥在邀请码里（DT2），信封、钥匙环都带老板的签名，
 *     成员只收签名对得上的新钥匙。中转手里没有私钥，伪造不了
 */
import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
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

function 加密(明: Buffer, 钥匙: string, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", 钥(钥匙), iv);
  if (aad) c.setAAD(aad);
  const 密 = Buffer.concat([c.update(明), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), 密]);
}
function 解密(b: Buffer, 钥匙: string, aad?: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", 钥(钥匙), b.subarray(0, 12));
  if (aad) d.setAAD(aad);
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

/** 这一包绑在哪个团队、哪台设备上（进 AAD，改了就解不开）。钥匙环的 device 写 "ring" */
export type 绑定 = { teamId: string; device: string };
const 附加 = (头: Buffer, x: 绑定) => Buffer.concat([头, Buffer.from(`|${x.teamId}|${x.device}`, "utf8")]);

/**
 * 封：版本（1 字节）+ 钥匙编号（4 字节）+ iv + 标签 + 密文，base64url。
 * 给了 绑定 是版本 3（头、团队、设备进 AAD）；没给是版本 2（测试和 0.46.15 之前测试环境里的老批次）
 */
export function 封(东西: 改动[] | unknown, 钥匙: string, 编号 = 0, 绑?: 绑定): string {
  const 头 = Buffer.alloc(5);
  头[0] = 绑 ? 3 : 2;
  头.writeUInt32BE(编号, 1);
  return Buffer.concat([头, 加密(gzipSync(Buffer.from(JSON.stringify(东西), "utf8")), 钥匙, 绑 ? 附加(头, 绑) : undefined)]).toString("base64url");
}

/** 这一包用的是几号钥匙（不用解开就看得到；中转据此拒收用旧钥匙封的推送） */
export function 包的编号(封好: string): number {
  const b = Buffer.from(封好.slice(0, 8), "base64url");
  if (b[0] === 1) return 0;
  if ((b[0] === 2 || b[0] === 3) && b.length >= 5) return b.readUInt32BE(1);
  throw new Error(`不认识的同步包版本 ${b[0]}`);
}

/** 拆：给一把钥匙（老用法）或一个钥匙环。版本 3 必须给 绑定，对不上（换了团队、换了设备编号）就解不开 */
export function 拆<T = 改动[]>(封好: string, 钥匙: string | 钥匙环, 绑?: 绑定): T {
  const b = Buffer.from(封好, "base64url");
  let 编号 = 0;
  let 体: Buffer;
  let aad: Buffer | undefined;
  if (b[0] === 1) 体 = b.subarray(1);
  else if (b[0] === 2 || b[0] === 3) {
    编号 = b.readUInt32BE(1);
    体 = b.subarray(5);
    if (b[0] === 3) {
      if (!绑) throw new Error("版本 3 的同步包要说明是哪个团队、哪台设备的");
      aad = 附加(b.subarray(0, 5), 绑);
    }
  } else throw new Error(`不认识的同步包版本 ${b[0]}`);
  const k = typeof 钥匙 === "string" ? 钥匙 : 钥匙[String(编号)];
  if (!k) throw new Error(`没有 ${编号} 号钥匙`);
  return JSON.parse(gunzipSync(解密(体, k, aad)).toString("utf8")) as T;
}

/* ---------------- 老板的签名钥匙：新钥匙只认老板发的 ---------------- */

/** Ed25519 钥匙对，都是 32 字节 base64url（JWK 的 x / d）。公钥进邀请码，私钥只在老板那台 .team.json */
export function 签名钥匙对(): { 公钥: string; 私钥: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  void publicKey;
  return { 公钥: j.x, 私钥: j.d };
}

/** 签：返回「原文.签名」——中转当一串不透明的字符串存、原样转交 */
export function 签上(原文: string, 用途: string, 私钥: string, 公钥: string): string {
  const k = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: 私钥, x: 公钥 }, format: "jwk" });
  return `${原文}.${sign(null, Buffer.from(`${用途}|${原文}`, "utf8"), k).toString("base64url")}`;
}

/** 验：签名对得上返回原文，对不上返回 null。用途要和签的时候一样（含团队、编号、设备，挪不到别处用） */
export function 验(签好: string, 用途: string, 公钥: string): string | null {
  const i = 签好.lastIndexOf(".");
  if (i <= 0) return null;
  const 原文 = 签好.slice(0, i);
  try {
    const k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: 公钥 }, format: "jwk" });
    return verify(null, Buffer.from(`${用途}|${原文}`, "utf8"), k, Buffer.from(签好.slice(i + 1), "base64url")) ? 原文 : null;
  } catch {
    return null;
  }
}

/** 中转收设备公钥时验一下：真是一把 X25519 公钥（复查低-中 3：乱写的公钥会让换钥匙永远失败） */
export function 是设备公钥(s: string): boolean {
  try {
    return 公(s).asymmetricKeyType === "x25519";
  } catch {
    return false;
  }
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
