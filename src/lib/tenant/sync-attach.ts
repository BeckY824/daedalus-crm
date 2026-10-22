/**
 * 团队版附件的文件通道（2026-10-22 D-24：商机 / 订单的产品图片）。
 *
 * 行（Attachment 表）走范围同步；文件走这里。桌面端用团队钥匙把整张图加密（crypto.ts 封附件：AES-GCM，
 * AAD 绑团队、附件编号、sha256），分块传上来；云端只存密文：<附件根>/<团队>/<编号>。
 *   - 谁能传、谁能取：看得到这条附件行的人（范围同步同一份索引、同一个 范围可读）。行还没推上来、已经删了的回 404
 *   - 只写一次：传齐了就不再收（同一编号永远是同一份密文）；接收端解开以后再核一遍 sha256
 *   - 续传：没传齐的放 <编号>.part。每块带 offset，对不上回 409 + 已收多少，客户端从那儿接着传；
 *     每块还带 head（密文头 33 字节：版本、钥匙编号、iv、标签），和已收那段的头不一样（中途换了钥匙）就扔掉从 0 来
 *   - 额度：单张 附件上限字节（密文多 33 字节）；团队按席位每位 1 GB 合用，没设席位按在队人数
 *   - 限速：整台服务器上传 + 下载合计 15 MB/s（ATTACH_MBPS 可调），先到先排
 *   - 删：收范围推送接受了附件行的删除，就删文件，编号记进 .deleted/<北京日期>.txt，异地备份第二天照单删
 */
import fs from "node:fs";
import path from "node:path";
import { control } from "./control";
import { workspaceDir } from "./clients";
import { 拉取前提, 范围错误 } from "./sync-scoped";
import { 团队索引 } from "./scoped-index";
import { 范围可读, 范围可写, 行键 } from "../sync/scope-policy";
import { 是附件编号, 附件上限字节 } from "../attachment-rules";

const GB = 1024 ** 3;
/** 每位席位多少空间（团队合用）：默认 1 GB，ATTACH_SEAT_GB 可调 */
export function 每席位字节(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ATTACH_SEAT_GB);
  return Math.round((Number.isFinite(n) && n > 0 ? n : 1) * GB);
}
/** 密文比原图多的：版本 1 + 钥匙编号 4 + iv 12 + 标签 16 */
export const 密文头长 = 33;
/** 一块最多多大（客户端按 1 MB 切，留点余量） */
export const 一块上限 = 2 * 1024 * 1024;

function fail(状态: number, 话: string): never { throw new 范围错误(状态, 话); }
/** 带补充说明的错：have = 云端已收多少（续传从这儿接），uploading = 行在、文件还没传齐 */
export class 附件错误 extends 范围错误 {
  constructor(状态: number, 话: string, public 补充: { have?: number; uploading?: boolean }) { super(状态, 话); }
}

/** 放哪：ATTACH_DIR；没设放工作区目录旁边（线上 WORKSPACE_DIR=/data/ws → /data/attach）；测试设了 SYNC_DIR 就放它里面 */
export function 附件根(): string {
  if (process.env.ATTACH_DIR) return process.env.ATTACH_DIR;
  if (process.env.SYNC_DIR) return path.join(process.env.SYNC_DIR, "attach");
  return path.join(path.dirname(workspaceDir()), "attach");
}
const 团队编号对 = (s: string) => /^[\w-]{1,100}$/.test(s);
function 团队目录(teamId: string): string {
  if (!团队编号对(teamId)) fail(400, "请求格式不对");
  return path.join(附件根(), teamId);
}

/* ---------------- 限速：全服务器一个桶 ---------------- */

export function 每秒字节(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ATTACH_MBPS);
  return (Number.isFinite(n) && n > 0 ? n : 15) * 1024 * 1024;
}
const g = globalThis as unknown as { 附件限速?: { 到: number } };
const 桶 = (g.附件限速 ??= { 到: 0 });
/**
 * 排队：每次要 n 字节，就把「排到的时刻」往后推 n / 速度，返回这一份要等多少毫秒（允许 1 秒的突发）。
 * 上传、下载、所有团队排同一条队，谁先来谁先走
 */
export function 排队(n: number, 现在 = Date.now(), 速 = 每秒字节()): number {
  桶.到 = Math.max(桶.到, 现在) + (n / 速) * 1000;
  return Math.max(0, 桶.到 - 现在 - 1000);
}
export function 重置限速() { 桶.到 = 0; }
async function 限速(n: number): Promise<void> {
  const 等 = 排队(n);
  if (等 > 0) await new Promise((r) => setTimeout(r, 等));
}

/* ---------------- 权限、额度 ---------------- */

/**
 * 看得到这条附件行才能取，改得了它才能传（和拉取、推送同一道：成员、开通、迁移完成；同一份范围索引）。
 * 传要「改得了」：互看时同事只读得到，不让他抢先替别人传一份（内容不对接收端核 sha256 也拿不到图，但这张就坏了）
 */
async function 认附件(accountId: string, teamId: string, id: string, 要传 = false) {
  if (!是附件编号(id)) fail(404, "找不到这张图");
  const c = await 拉取前提(control, accountId, teamId);
  const e = await 团队索引(teamId);
  const key = 行键("Attachment", id);
  const row = e.rows.get(key);
  if (!row || row.deleted) fail(404, "这张图还没同步上来，或者已经删了");
  if (!范围可读(e.归.get(key) ?? null, accountId, c.owner, c.share || c.manager)) fail(403, "这张图不在你的同步权限内");
  if (要传 && !范围可写(row, row, e.rows, accountId, c.owner, false, c.manager)) fail(403, "这张图不在你的同步权限内");
}

function 目录大小(dir: string): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile()) { try { n += fs.statSync(path.join(dir, f.name)).size; } catch { /* 刚被删 */ } }
    }
  } catch { /* 还没有目录 */ }
  return n;
}

export async function 团队额度(teamId: string): Promise<number> {
  const seats = (await control.syncTeamPlan.findUnique({ where: { teamId }, select: { seats: true } }))?.seats;
  const n = seats ?? (await control.syncMember.count({ where: { teamId, leftAt: null } }));
  return Math.max(1, n) * 每席位字节();
}
const 写GB = (n: number) => (n >= GB ? `${Math.round((n / GB) * 10) / 10} GB` : `${Math.round(n / 1024 / 1024)} MB`);

/* ---------------- 上传 ---------------- */

/**
 * 同一张图的块排队一个一个收（质量审 #93 A）：断线重传时旧请求可能还在限速里排着，两个同一 offset 的块同时追加，
 * .part 就多出一截、被改名成「传齐了」的坏文件。整台服务器一个进程，内存里排队就够
 */
const 锁 = globalThis as unknown as { 附件锁?: Map<string, Promise<void>>; 附件删代?: Map<string, number> };
const 锁们 = (锁.附件锁 ??= new Map());
async function 排着<T>(key: string, f: () => Promise<T>): Promise<T> {
  const 前 = 锁们.get(key) ?? Promise.resolve();
  let 放!: () => void;
  const 我 = new Promise<void>((r) => { 放 = r; });
  const 链 = 前.then(() => 我);
  锁们.set(key, 链);
  await 前;
  try {
    return await f();
  } finally {
    放();
    if (锁们.get(key) === 链) 锁们.delete(key);
  }
}
/** 每删一次加一：收块时在限速里排着、这张图被删了，排完就别再写（不然删掉的又冒出一个 .part） */
const 删代 = (锁.附件删代 ??= new Map());

export type 收块结果 = { ok: true; have: number; done: boolean };

/**
 * 收一块。offset 必须正好接在已收的后面；传齐了改名到位。
 * 已经传齐的直接回 done（别的成员也有这张图、或者上次传完没收到回话）
 */
export async function 收附件块(accountId: string, teamId: string, q: { id: string; offset: number; total: number; head: string }, 块: Uint8Array): Promise<收块结果> {
  const dir = 团队目录(teamId);
  // 认权限之前就记下：认完、排队、限速这一路上这张图被删了，都不再写
  const 代 = 删代.get(`${teamId}/${q.id}`) ?? 0;
  await 认附件(accountId, teamId, q.id, true);
  const { offset, total } = q;
  if (!Number.isSafeInteger(total) || total <= 密文头长 || total > 附件上限字节 + 密文头长) fail(413, `单张最多 ${Math.round(附件上限字节 / 1024 / 1024)} MB`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total || 块.byteLength === 0 || 块.byteLength > 一块上限 || offset + 块.byteLength > total) fail(400, "请求格式不对");
  const head = Buffer.from(q.head, "base64url");
  if (head.length !== 密文头长) fail(400, "请求格式不对");
  const 成 = path.join(dir, q.id), 半 = `${成}.part`;
  return 排着(`${teamId}/${q.id}`, async () => {
    if (fs.existsSync(成)) return { ok: true, have: fs.statSync(成).size, done: true };
    let have = 0;
    try { have = fs.statSync(半).size; } catch { /* 没有 = 从头 */ }
    // 已收的比这张还长（坏了，或者是另一份内容）：扔掉，从 0 来（质量审 #93 B：只置 0 不删，会接着追加出坏文件）
    if (have > total) { fs.rmSync(半, { force: true }); have = 0; }
    // 已收那段的头和这次不一样（换了钥匙、换了内容）：扔掉，从 0 来
    if (have > 0) {
      const fd = fs.openSync(半, "r");
      const 旧头 = Buffer.alloc(Math.min(密文头长, have));
      try { fs.readSync(fd, 旧头, 0, 旧头.length, 0); } finally { fs.closeSync(fd); }
      if (!旧头.equals(head.subarray(0, 旧头.length))) { fs.rmSync(半, { force: true }); have = 0; }
    }
    if (offset !== have) throw new 附件错误(409, "从已收的地方接着传", { have });
    if (offset === 0) {
      if (!Buffer.from(块.subarray(0, 密文头长)).equals(head.subarray(0, Math.min(密文头长, 块.byteLength)))) fail(400, "请求格式不对");
      const 额度 = await 团队额度(teamId);
      if (目录大小(dir) + total > 额度) fail(507, `团队的图片空间满了（共 ${写GB(额度)}，按席位每位 ${写GB(每席位字节())}），删掉一些不用的图片再传`);
    }
    await 限速(块.byteLength);
    if ((删代.get(`${teamId}/${q.id}`) ?? 0) !== 代) { fs.rmSync(半, { force: true }); fail(404, "这张图已经删了"); }
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(半, 块, { mode: 0o600 });
    have = offset + 块.byteLength;
    // 写完核一遍实际多长：和算的对不上（上次写到一半进程没了之类），这份不要了，从 0 来
    const 实际 = fs.statSync(半).size;
    if (实际 !== have) { fs.rmSync(半, { force: true }); throw new 附件错误(409, "已收的对不上，从头传", { have: 0 }); }
    if (have === total) { fs.renameSync(半, 成); return { ok: true, have, done: true }; }
    return { ok: true, have, done: false };
  });
}

/* ---------------- 下载 ---------------- */

/** 取一张：传齐了才给（没传齐回 404「还在上传」）。按 256 KB 一段限速往外流 */
export async function 给附件(accountId: string, teamId: string, id: string): Promise<{ 大小: number; 流: ReadableStream<Uint8Array> }> {
  const dir = 团队目录(teamId);
  await 认附件(accountId, teamId, id);
  const f = path.join(dir, id);
  let 大小: number;
  try { 大小 = fs.statSync(f).size; } catch { throw new 附件错误(404, "对方还在上传，稍后再看", { uploading: true }); }
  const fd = fs.openSync(f, "r");
  let 读到 = 0;
  const 流 = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (读到 >= 大小) { fs.closeSync(fd); ctl.close(); return; }
      const n = Math.min(256 * 1024, 大小 - 读到);
      await 限速(n);
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, 读到);
      读到 += n;
      ctl.enqueue(b);
    },
    cancel() { try { fs.closeSync(fd); } catch { /* 已关 */ } },
  });
  return { 大小, 流 };
}

/** 这些里哪几张云端已经传齐（桌面端隔几个小时核一次，没了的重传）。看不到的不回 */
export async function 有哪些附件(accountId: string, teamId: string, ids: unknown): Promise<{ ok: true; have: string[] }> {
  const dir = 团队目录(teamId);
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string" && 是附件编号(x))) fail(400, "请求格式不对");
  const c = await 拉取前提(control, accountId, teamId);
  const e = await 团队索引(teamId);
  const have = (ids as string[]).filter((id) => {
    const key = 行键("Attachment", id);
    const row = e.rows.get(key);
    return row && !row.deleted && 范围可读(e.归.get(key) ?? null, accountId, c.owner, c.share || c.manager) && fs.existsSync(path.join(dir, id));
  });
  return { ok: true, have };
}

/* ---------------- 删除 ---------------- */

const 北京日期 = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

/** 附件行删掉了：删文件（含没传齐的），传齐过的编号记进当天的删除清单，给异地备份照单删 */
export function 删云端附件(teamId: string, ids: string[], 现在 = new Date()): number {
  if (!团队编号对(teamId)) return 0;
  const dir = path.join(附件根(), teamId);
  // 先记「删过」再看目录：这张图的第一块可能还在限速里排着、目录都还没建
  for (const id of ids) if (是附件编号(id)) 删代.set(`${teamId}/${id}`, (删代.get(`${teamId}/${id}`) ?? 0) + 1);
  if (!fs.existsSync(dir)) return 0;
  const 删了: string[] = [];
  for (const id of ids) {
    if (!是附件编号(id)) continue;
    fs.rmSync(path.join(dir, `${id}.part`), { force: true });
    try { fs.rmSync(path.join(dir, id)); 删了.push(id); } catch { /* 本来就没有 */ }
  }
  if (删了.length) {
    const d = path.join(dir, ".deleted");
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, `${北京日期(现在)}.txt`), 删了.map((x) => `${x}\n`).join(""));
  }
  return 删了.length;
}

/* ---------------- 运营台：磁盘 ---------------- */

const 缓 = globalThis as unknown as { 附件磁盘?: { at: number; v: { 剩: number; 用: number } } };
/** 附件所在盘还剩多少、附件一共占多少（十分钟算一次：要把所有团队目录走一遍） */
export function 附件磁盘(现在 = Date.now()): { 剩: number; 用: number } | null {
  if (缓.附件磁盘 && 现在 - 缓.附件磁盘.at < 10 * 60_000) return 缓.附件磁盘.v;
  const root = 附件根();
  try {
    const s = fs.statfsSync(fs.existsSync(root) ? root : path.dirname(root));
    let 用 = 0;
    if (fs.existsSync(root)) for (const t of fs.readdirSync(root, { withFileTypes: true })) if (t.isDirectory()) 用 += 目录大小(path.join(root, t.name));
    const v = { 剩: s.bavail * s.bsize, 用 };
    缓.附件磁盘 = { at: 现在, v };
    return v;
  } catch {
    return null;
  }
}
