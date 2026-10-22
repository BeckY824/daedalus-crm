/**
 * 团队版附件的桌面端（2026-10-22 D-24）：行走范围同步，文件走云端的附件通道（lib/tenant/sync-attach.ts）。
 *
 *   - 传：每轮范围同步推完、拉完以后，把本机有文件、还没确认传上去的附件加密分块传上去（1 MB 一块，一块失败等一下再试，
 *     连着 3 次不行留到下一轮；断了从云端说的位置接着传）。传完记进本机 _sync_attach_up
 *   - 取：界面要看一张本机没有的图（attachments.ts 确保文件），按需下载、解开、核 sha256 再落盘
 *   - 云端没了（磁盘恢复、误删）：隔几个小时问一次「这些还在吗」，不在的去掉记号，下一轮重传
 *
 * 只在范围同步（stage = ready）下用：附件的权限跟着商机 / 订单走，云端靠范围索引判。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "../prisma";
import { 读 as 读云端凭据, 云端地址 } from "../desktop/cloud";
import { 附件目录, 附件文件, 有文件 } from "../attachments";
import { 封附件, 拆附件 } from "./crypto";
import { 读团队, 全部钥匙, type 团队配置 } from "./client";

/** 一块多大 */
export const 块大小 = 1024 * 1024;
/** 一轮最多传几张（别让一轮同步拖太久，剩下的下一轮接着传） */
const 每轮最多 = 20;
/** 多久核一次云端还在不在 */
const 核对间隔 = 6 * 3600_000;

/* ---------------- 和云端说话：二进制，测试里换掉 ---------------- */
export type 附件回话 = { 状态: number; json: Record<string, unknown>; 字节?: Buffer };
export type 附件传输 = (方法: "GET" | "PUT" | "POST", 路径: string, body?: Uint8Array | Record<string, unknown>) => Promise<附件回话>;
const HTTP: 附件传输 = async (方法, 路径, body) => {
  const c = 读云端凭据();
  if (!c) return { 状态: 401, json: { error: "还没登录云端账号" } };
  try {
    const 二进制 = body instanceof Uint8Array;
    const r = await fetch(`${云端地址()}${路径}`, {
      method: 方法,
      headers: { Authorization: `Bearer ${c.token}`, ...(body ? { "Content-Type": 二进制 ? "application/octet-stream" : "application/json" } : {}) },
      body: body ? (二进制 ? new Uint8Array(body) : JSON.stringify(body)) : undefined,
      // 一张 20 MB、限速时排队：给足两分钟
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
    if (r.ok && 方法 === "GET") return { 状态: r.status, json: {}, 字节: Buffer.from(await r.arrayBuffer()) };
    return { 状态: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
  }
};
let 传: 附件传输 = HTTP;
export function 设附件传输(t: 附件传输 | null) { 传 = t ?? HTTP; }

const 等 = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 一块失败后等多久再试（1 秒、3 秒）；测试里调短 */
let 重试基数 = 1000;
export function 设重试基数(ms: number) { 重试基数 = ms; }
const 能用 = (c: 团队配置 | null): c is 团队配置 => !!c && c.scoped?.stage === "ready";

/* ---------------- 本机记号：哪些已经确认在云端 ---------------- */
async function 建记号表() {
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_sync_attach_up" ("id" TEXT PRIMARY KEY, "at" INTEGER NOT NULL)');
}
async function 记上(ids: string[]) {
  for (const id of ids) await prisma.$executeRawUnsafe('INSERT OR REPLACE INTO "_sync_attach_up" ("id", "at") VALUES (?, ?)', id, Date.now());
}

/* ---------------- 传 ---------------- */
/** 这次启动里传到哪了（断了下一轮直接从这儿接；重启以后不记得，第一块云端回 409 + 已收多少，再从那儿接） */
const 传到 = new Map<string, number>();
type 传一张结果 = "传完" | "等行" | "看不到" | "满了" | "失败";
async function 传一张(c: 团队配置, a: { id: string; sha256: string }, 记满: (话: string) => void): Promise<传一张结果> {
  const 明 = fs.readFileSync(附件文件(a.id));
  if (crypto.createHash("sha256").update(明).digest("hex") !== a.sha256) return "失败"; // 本机这份坏了，不传坏的
  const 密 = 封附件(明, c.key, c.epoch ?? 0, { teamId: c.teamId, id: a.id, sha256: a.sha256 });
  const head = 密.subarray(0, 33).toString("base64url");
  let offset = 传到.get(a.id) ?? 0, 失败 = 0;
  if (offset >= 密.length) offset = 0;
  for (;;) {
    传到.set(a.id, offset);
    const q = new URLSearchParams({ teamId: c.teamId, id: a.id, device: c.device, offset: String(offset), total: String(密.length), head });
    const r = await 传("PUT", `/api/sync/attach?${q}`, 密.subarray(offset, Math.min(密.length, offset + 块大小)));
    const have = Number(r.json.have);
    if (r.状态 === 200 && Number.isSafeInteger(have)) {
      if (r.json.done === true) { 传到.delete(a.id); return "传完"; }
      offset = have; 失败 = 0; continue;
    }
    // 对不上：云端已收的和我以为的不一样，从它说的位置接着
    if (r.状态 === 409 && Number.isSafeInteger(have) && have >= 0 && have < 密.length) { offset = have; continue; }
    if (r.状态 === 507) { 记满(String(r.json.error ?? "团队的图片空间满了")); return "满了"; }
    if (r.状态 === 404) return "等行";
    if (r.状态 === 403) return "看不到";
    if (++失败 >= 3) return "失败";
    await 等(重试基数 * 3 ** (失败 - 1));
  }
}

/**
 * 范围同步一轮的最后调：传没传的、到点了核一次云端。出什么错都不让这一轮同步算失败；
 * 只有空间满了回一句话（要人去删图、或者加席位），由调用的人记进 lastError
 */
export async function 附件通道一轮(c0?: 团队配置 | null): Promise<{ 传了: number; 满了?: string }> {
  const c = c0 ?? 读团队();
  if (!能用(c)) return { 传了: 0 };
  await 建记号表();
  let 满了: string | undefined;
  let 传了 = 0;
  const 待 = await prisma.$queryRawUnsafe<{ id: string; sha256: string }[]>(
    'SELECT a."id", a."sha256" FROM "Attachment" a LEFT JOIN "_sync_attach_up" u ON u."id" = a."id" WHERE u."id" IS NULL ORDER BY a."createdAt" LIMIT 500',
  );
  for (const a of 待) {
    if (传了 >= 每轮最多 || 满了) break;
    if (!有文件(a.id)) continue; // 别人的、还没下载的：不归我传
    const r = await 传一张(c, a, (话) => { 满了 = 话; });
    // 看不到的（权限变了）也记上：不然每一轮都去碰一次
    if (r === "传完" || r === "看不到") { await 记上([a.id]); if (r === "传完") 传了++; }
    if (r === "失败") break; // 网络不好：这一轮先不传了
  }
  await 核云端(c).catch(() => undefined);
  return { 传了, ...(满了 ? { 满了 } : {}) };
}

const g = globalThis as unknown as { 附件核对?: Record<string, number> };
/** 隔几个小时问一次：我记着传上去了的那些，云端还在吗（服务器换盘、从备份恢复以后可能少了）。不在的去掉记号，下一轮重传 */
async function 核云端(c: 团队配置, 现在 = Date.now()) {
  const 上次 = (g.附件核对 ??= {})[c.teamId] ?? 0;
  if (现在 - 上次 < 核对间隔) return;
  g.附件核对[c.teamId] = 现在;
  const 记着 = await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT u."id" FROM "_sync_attach_up" u JOIN "Attachment" a ON a."id" = u."id"');
  const ids = 记着.map((x) => x.id).filter((id) => 有文件(id));
  for (let i = 0; i < ids.length; i += 500) {
    const 这批 = ids.slice(i, i + 500);
    const r = await 传("POST", "/api/sync/attach", { teamId: c.teamId, device: c.device, action: "have", ids: 这批 });
    if (r.状态 !== 200 || !Array.isArray(r.json.have)) return;
    const 在 = new Set(r.json.have as string[]);
    const 没了 = 这批.filter((id) => !在.has(id));
    for (const id of 没了) await prisma.$executeRawUnsafe('DELETE FROM "_sync_attach_up" WHERE "id" = ?', id);
  }
}

/* ---------------- 取 ---------------- */
const 在取 = new Map<string, Promise<"有" | "还在上传" | "没有">>();

/**
 * 本机没有这张图：去云端取。传齐了 → 解开、核 sha256、落盘，回「有」；对方还没传齐 → 「还在上传」；
 * 看不到、连不上、解不开 → 「没有」（界面说「文件不在这台电脑上」，下次打开再试）
 */
export function 下载附件(id: string, 目录 = 附件目录()): Promise<"有" | "还在上传" | "没有"> {
  const 已在 = 在取.get(id);
  if (已在) return 已在;
  const p = 取一张(id, 目录).finally(() => 在取.delete(id));
  在取.set(id, p);
  return p;
}
async function 取一张(id: string, 目录: string): Promise<"有" | "还在上传" | "没有"> {
  const c = 读团队();
  if (!能用(c)) return "没有";
  const 行 = (await prisma.$queryRawUnsafe<{ sha256: string }[]>('SELECT "sha256" FROM "Attachment" WHERE "id" = ?', id))[0];
  if (!行) return "没有";
  const q = new URLSearchParams({ teamId: c.teamId, id, device: c.device });
  const r = await 传("GET", `/api/sync/attach?${q}`);
  if (r.状态 === 404 && r.json.uploading === true) return "还在上传";
  if (r.状态 !== 200 || !r.字节) return "没有";
  let 明: Buffer;
  try {
    明 = 拆附件(r.字节, 全部钥匙(c), { teamId: c.teamId, id, sha256: 行.sha256 });
  } catch {
    return "没有";
  }
  if (crypto.createHash("sha256").update(明).digest("hex") !== 行.sha256) return "没有";
  fs.mkdirSync(目录, { recursive: true });
  const 临时 = path.join(目录, `.tmp-${id}`);
  fs.writeFileSync(临时, 明);
  fs.renameSync(临时, 附件文件(id, 目录));
  // 是从云端取来的：云端当然有，不用再传
  await 建记号表();
  await 记上([id]);
  return "有";
}
