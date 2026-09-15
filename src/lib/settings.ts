/**
 * 系统设置的读写。
 *
 * 一张键值表，每个 key 存一段 JSON。读取走进程内缓存，写入时整体失效——
 * 设置改动极少、读取却在每个请求里都有（术语、AI 是否可用），
 * 不缓存的话每次渲染都多一次查库；而缓存粒度做到"整体"就够了，
 * 没必要为几个 key 维护逐项失效。
 *
 * **缓存必须按工作区分开。** 托管版是一个进程伺候所有工作区，
 * 而 `prisma.setting.findMany()` 那一行才按租户路由——缓存命中时它根本跑不到。
 * 曾经这里是一个全局 Map：谁先访问谁把缓存填上，之后**所有**工作区读到的
 * 都是那一份，业务术语串、AI 接口地址串，连加密的 Key 也串（同一个进程、
 * 同一把 AUTH_SECRET，解得开）。隔离做在了数据库层，读取却在数据库层之前
 * 就被缓存截胡了。
 *
 * 敏感值（API Key）不能明文落库：数据库备份文件会被拷来拷去，
 * 备份里带着明文 key 等于把 key 发出去。这里用 AUTH_SECRET 派生的密钥
 * 做 AES-256-GCM 加密，换了 AUTH_SECRET 旧 key 就解不出来——这是预期行为，
 * 重填一次即可。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { readSecret } from "./secret";
import { multiTenant, currentTenant } from "./tenant/context";

const g = globalThis as unknown as { __settingsCache?: Map<string, Map<string, string>> };

/**
 * 这一次读取该用哪一格缓存。
 *
 * 自部署版只有一个库，固定一格。托管版按工作区分格——解析不出工作区时
 * 用一格谁也读不到的 `:未知`，而不是退回公用那一格：
 * 那正是串库的来路。（真解析不出来时 prisma 自己会抛，见 lib/prisma.ts。）
 */
async function 缓存格(): Promise<string> {
  if (!multiTenant()) return ":single";
  const ctx = currentTenant();
  if (ctx) return ctx.workspaceId;
  const { resolveCurrentTenant } = await import("./tenant/resolve");
  return (await resolveCurrentTenant())?.workspaceId ?? ":未知";
}

async function loadAll(): Promise<Map<string, string>> {
  const 格 = await 缓存格();
  const 全部 = (g.__settingsCache ??= new Map());
  const 命中 = 全部.get(格);
  if (命中) return 命中;
  const rows = await prisma.setting.findMany();
  const m = new Map(rows.map((r) => [r.key, r.value]));
  全部.set(格, m);
  return m;
}

/**
 * 测试与写入后调用：让下一次读取重新查库。
 * 整个清掉而不是只清当前那一格——写设置是极少发生的动作，
 * 多查几次库换一个「不会漏清」的简单规则，划算。
 */
export function invalidateSettingsCache() {
  g.__settingsCache = new Map();
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const all = await loadAll();
  const raw = all.get(key);
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: raw },
    create: { key, value: raw },
  });
  invalidateSettingsCache();
}

/* ---------- 敏感值加解密 ---------- */

function derivedKey(): Buffer {
  // 与会话密钥同源但不相同：加个用途前缀再哈希，避免一把钥匙两处用
  return createHash("sha256").update(`setting-secret:${readSecret()}`).digest();
}

const PREFIX = "enc:v1:";

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString("base64");
}

/** 解不出来（密钥换了、数据损坏）返回 null，调用方按"没配"处理 */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return null;
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** 界面回显用：只露尾 4 位 */
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return "****";
  return `****${plain.slice(-4)}`;
}
