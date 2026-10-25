import fs from "node:fs";
import path from "node:path";
import { 读通道开着 } from "./read-pool";

/**
 * 首页几句重查询的短时缓存（企业版，2026-10-25）。
 *
 * 为什么：企业版 30 人同时开首页，每次首页 37 句查询、库里合计约 340 ms，其中四句「全库一起数」的
 * （近 90 天活跃 / 建档、沉睡客户候选 / 总数）占了 296 ms。这四句不分人（只在不限定时走），
 * 结果只随库里的数据和日子变——同一时刻 30 个人各数一遍是白数。
 *
 * 什么时候作废：
 * - 库里有任何新提交（本进程、别的进程、事务、裸 SQL 都算）→ 下一次立刻重数。
 *   靠读 WAL 索引头（库文件旁边 -shm 的前 48 字节，https://www.sqlite.org/walformat.html）：
 *   每次提交都会改它（iChange / mxFrame / salt），这就是 SQLite 自己告诉读连接「库变了」的那几个字节。
 *   读一次是一次 pread，几微秒。
 * - 最多活 30 秒（兜底：沉睡那句里有「此刻」，跟进时间写在未来的那几个客户会随时间换算法）。
 * - key 里带当天零点，过了零点自然换一份。
 *
 * 同一份正在数的，后来的人直接等它（不各自再数一遍）。
 *
 * 只在企业版开（只读通道开着）；CRM_HOME_CACHE=0 一键关。库路径不是绝对路径、没有 -shm（不是 WAL）、
 * 头读不出来，一律不缓存，照原样每次现数。
 */

const 最长 = 30_000;
const 最多条 = 64;

type 条 = { 指纹: string; 到期: number; 值: Promise<unknown> };
const g = globalThis as unknown as { __首页缓存?: Map<string, 条> };
const 表 = (g.__首页缓存 ??= new Map());

/** 库文件的 -shm 路径：只认 file:/绝对路径（相对路径 Prisma 按 schema 目录解析，猜错了会读到别的库的头） */
export function shm路径(url = process.env.DATABASE_URL ?? ""): string | null {
  if (!url.startsWith("file:")) return null;
  const 库 = url.slice(5).split("?")[0];
  return 库 && path.isAbsolute(库) ? `${库}-shm` : null;
}

/** 库的提交指纹：WAL 索引头第一份拷贝（48 字节）。读不出 / 没初始化回 null */
export function 库指纹(shm = shm路径()): string | null {
  if (!shm) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(shm, "r");
    const b = Buffer.alloc(48);
    if (fs.readSync(fd, b, 0, 48, 0) !== 48) return null;
    // iVersion = 3007000、isInit = 1 才是 SQLite 写好的头
    if (b.readUInt32LE(0) !== 3007000 && b.readUInt32BE(0) !== 3007000) return null;
    if (b[12] !== 1) return null;
    return b.toString("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function 首页缓存开着(): boolean {
  return process.env.CRM_HOME_CACHE !== "0" && 读通道开着();
}

/**
 * 按 key 取缓存，没有 / 库变了 / 过期就现数一次。`算` 必须只依赖 key 里写明的东西和库里的数据。
 * 返回的值是共用的，调用方别改它
 */
export async function 缓存着<T>(key: string, 算: () => Promise<T>): Promise<T> {
  if (!首页缓存开着()) return 算();
  // 先取指纹再数：数的过程中有人提交，存下的是旧指纹，下一次一比就重数
  const 指纹 = 库指纹();
  if (指纹 === null) return 算();
  const 此刻 = Date.now();
  const 有 = 表.get(key);
  if (有 && 有.指纹 === 指纹 && 有.到期 > 此刻) return 有.值 as Promise<T>;

  const 值 = 算();
  const 新 = { 指纹, 到期: 此刻 + 最长, 值 };
  表.set(key, 新);
  值.catch(() => { if (表.get(key) === 新) 表.delete(key); });
  if (表.size > 最多条) for (const [k, v] of 表) if (v.到期 <= 此刻 || 表.size > 最多条) 表.delete(k);
  return 值;
}

/** 测试用 */
export function 清首页缓存(): void {
  表.clear();
}
