/**
 * 团队同步的加密（2026-10-03）：一批改动 → JSON → gzip → AES-256-GCM。**先压缩再加密**：密文压不动。
 * 钥匙只在团队成员的电脑上（.team.json、邀请码里），我们的中转只见得到密文、团队编号、设备、序号、大小。
 * 认证标签不对（钥匙错了、密文被改过）就抛错，不回放半截东西。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { 改动 } from "./local";

const 版本 = 1;

export function 新钥匙(): string {
  return randomBytes(32).toString("base64url");
}

function 钥(k: string): Buffer {
  const b = Buffer.from(k, "base64url");
  if (b.length !== 32) throw new Error("团队钥匙不对（应是 256 位）");
  return b;
}

/** 封：返回一段 base64url（版本 1 字节 + iv 12 字节 + 标签 16 字节 + 密文） */
export function 封(改动们: 改动[], 钥匙: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", 钥(钥匙), iv);
  const 密 = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(改动们), "utf8"))), c.final()]);
  return Buffer.concat([Buffer.from([版本]), iv, c.getAuthTag(), 密]).toString("base64url");
}

export function 拆(封好: string, 钥匙: string): 改动[] {
  const b = Buffer.from(封好, "base64url");
  if (b[0] !== 版本) throw new Error(`不认识的同步包版本 ${b[0]}`);
  const d = createDecipheriv("aes-256-gcm", 钥(钥匙), b.subarray(1, 13));
  d.setAuthTag(b.subarray(13, 29));
  const 明 = Buffer.concat([d.update(b.subarray(29)), d.final()]);
  return JSON.parse(gunzipSync(明).toString("utf8")) as 改动[];
}
