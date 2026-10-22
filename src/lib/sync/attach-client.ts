/**
 * 团队版附件的桌面端（2026-10-22 D-24）：行走范围同步，文件走云端的附件通道（lib/tenant/sync-attach.ts）。
 *
 *   - 传：每轮范围同步跑完以后在后台另跑（不占着同步那一轮：立即同步、退出团队不用等它），把本机有文件、
 *     还没确认传上去的附件加密分块传上去（1 MB 一块，一块失败等一下再试，连着 3 次不行留到下一轮；
 *     断了从云端说的位置接着传）。传完记进本机 _sync_attach_up；本机没有文件的（同事的图）也记上，不归我传
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
import { 读团队, 写团队, 全部钥匙, type 团队配置 } from "./client";

/** 一块多大 */
export const 块大小 = 1024 * 1024;
/** 一轮最多碰几张（传完、等行、失败都算；剩下的下一轮接着传） */
const 每轮最多 = 20;
/** 云端还没有这一行（行还没推上去）：先等这么久再试，每次翻倍，最多等半小时 */
const 等行起步 = 60_000, 等行最多 = 30 * 60_000;
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
  const 现在 = Date.now();
  // 一次可能几百张（同事的图）：一个事务里写完
  await prisma.$transaction(ids.map((id) => prisma.$executeRawUnsafe('INSERT OR REPLACE INTO "_sync_attach_up" ("id", "at") VALUES (?, ?)', id, 现在)));
}

/* ---------------- 传 ---------------- */
/** 这次启动里传到哪了（断了下一轮直接从这儿接；重启以后不记得，第一块云端回 409 + 已收多少，再从那儿接） */
const 传到 = new Map<string, number>();
/** 等行的：下次什么时候再试、这次等了多久（只在这次启动里记） */
const 等行 = new Map<string, { 到: number; 隔: number }>();
/**
 * 本机文件和行上的 sha256 对不上的（这次启动里记）：不传坏的，也别让它挡着后面的新图（质量复审 #93 建议 1）。
 * 它的 createdAt 最老、每轮最先碰到，原来回「失败」整轮就停了，这台电脑以后的图都传不上去
 */
const 坏图 = new Set<string>();
/** 一张图一次最多跟着云端的 409 改几回位置：一直对不上就当等行，退避着下一轮再来（质量复审 #93 建议 2） */
const 改位置最多 = 3;
/** 退出团队时叫停：传完手上这一块就不传了 */
let 停 = false;
type 传一张结果 = "传完" | "等行" | "看不到" | "满了" | "失败" | "停了" | "坏了";
async function 传一张(c: 团队配置, a: { id: string; sha256: string }, 记满: (话: string) => void): Promise<传一张结果> {
  const 明 = fs.readFileSync(附件文件(a.id));
  if (crypto.createHash("sha256").update(明).digest("hex") !== a.sha256) return "坏了";
  const 密 = 封附件(明, c.key, c.epoch ?? 0, { teamId: c.teamId, id: a.id, sha256: a.sha256 });
  const head = 密.subarray(0, 33).toString("base64url");
  let offset = 传到.get(a.id) ?? 0, 失败 = 0, 改位置 = 0;
  if (offset >= 密.length) offset = 0;
  for (;;) {
    if (停) return "停了";
    传到.set(a.id, offset);
    const q = new URLSearchParams({ teamId: c.teamId, id: a.id, device: c.device, offset: String(offset), total: String(密.length), head });
    const r = await 传("PUT", `/api/sync/attach?${q}`, 密.subarray(offset, Math.min(密.length, offset + 块大小)));
    const have = Number(r.json.have);
    if (r.状态 === 200 && Number.isSafeInteger(have)) {
      if (r.json.done === true) { 传到.delete(a.id); return "传完"; }
      offset = have; 失败 = 0; continue;
    }
    // 对不上：云端已收的和我以为的不一样，从它说的位置接着
    if (r.状态 === 409 && Number.isSafeInteger(have) && have >= 0 && have < 密.length) {
      if (++改位置 > 改位置最多) return "等行";
      offset = have; continue;
    }
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
export async function 附件通道一轮(c0?: 团队配置 | null, 现在 = Date.now()): Promise<{ 传了: number; 满了?: string }> {
  const c = c0 ?? 读团队();
  if (!能用(c)) return { 传了: 0 };
  await 建记号表();
  let 满了: string | undefined;
  let 传了 = 0, 碰了 = 0;
  // 本机没有文件的（同事的、还没下载的）不归我传，也记上（质量审 #93 C）：不然攒过 500 张就把本机自己的新图挤出这一页。
  // 文件总是先于行写进本机，所以没文件的以后也不会冒出来要我传；要是从备份恢复出来了，核云端 那一步会去掉记号重传
  let 待: { id: string; sha256: string }[] = [];
  for (let 页 = 0; 页 < 20; 页++) {
    const 这页 = await prisma.$queryRawUnsafe<{ id: string; sha256: string }[]>(
      'SELECT a."id", a."sha256" FROM "Attachment" a LEFT JOIN "_sync_attach_up" u ON u."id" = a."id" WHERE u."id" IS NULL ORDER BY a."createdAt" LIMIT 500',
    );
    const 别人的 = 这页.filter((a) => !有文件(a.id)).map((a) => a.id);
    if (别人的.length) await 记上(别人的);
    待 = 这页.filter((a) => 有文件(a.id));
    // 这一页全是别人的、而且是满页：记上以后后面可能还有我的，再取一页
    if (待.length || 这页.length < 500) break;
  }
  // 本机自己的图超过 500 张、又全在等行或坏图里，会占满这一页，后面的要等它们退避到期（极少，先记着；质量复审 #93 建议 4）
  for (const a of 待) {
    if (碰了 >= 每轮最多 || 满了 || 停) break;
    if (坏图.has(a.id)) continue;
    const 等 = 等行.get(a.id);
    if (等 && 等.到 > 现在) continue;
    碰了++;
    const r = await 传一张(c, a, (话) => { 满了 = 话; });
    if (r === "等行") { const 隔 = Math.min(等行最多, 等 ? 等.隔 * 2 : 等行起步); 等行.set(a.id, { 到: 现在 + 隔, 隔 }); continue; }
    等行.delete(a.id);
    if (r === "坏了") { 坏图.add(a.id); console.warn(`[团队图片] 本机这张图和记录对不上，先不传：${a.id}`); continue; }
    // 看不到的（权限变了）也记上：不然每一轮都去碰一次
    if (r === "传完" || r === "看不到") { await 记上([a.id]); if (r === "传完") 传了++; }
    if (r === "失败" || r === "停了") break; // 网络不好：这一轮先不传了
  }
  if (!停) await 核云端(c).catch(() => undefined);
  return { 传了, ...(满了 ? { 满了 } : {}) };
}

/* ---------------- 后台跑：不占着同步那一轮（质量审 #93 D） ---------------- */
let 在跑: Promise<void> | null = null;
let 再来 = false;

/**
 * 范围同步一轮跑完调：没在跑就在后台开一轮；正在跑就记一下，跑完再来一轮。
 * 空间满了要人处理（删图、加席位），记进同步状态的 lastError；下一轮同步成功会清掉，满着的话这里又记上
 */
export function 后台传附件(): void {
  if (在跑) { 再来 = true; return; }
  停 = false;
  在跑 = (async () => {
    do {
      再来 = false;
      const c = 读团队();
      const r = await 附件通道一轮(c).catch(() => null);
      const 现 = 读团队();
      if (r?.满了 && 现 && 现.teamId === c?.teamId) 写团队({ ...现, lastError: `图片没传上去：${r.满了}` });
    } while (再来 && !停);
  })().finally(() => { 在跑 = null; });
}
/** 等后台这一轮跑完（测试、退出团队用） */
export function 等附件通道(): Promise<void> {
  return 在跑 ?? Promise.resolve();
}
/** 退出团队：叫停后台在传的（传完手上这一块就停），等它停下 */
export async function 停附件通道(): Promise<void> {
  停 = true;
  再来 = false;
  await 等附件通道();
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
