import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@/generated/prisma";
import { currentTenant } from "./context";

/**
 * 每个工作区一个 PrismaClient，按需创建、闲置回收。
 *
 * 为什么要回收：每个客户端持一个 SQLite 连接与一份 query engine 内存。几十个试用
 * 工作区里多数时候只有几个在用，全留着会把 2G 的机器吃光。闲置超过 IDLE_MS 就断开，
 * 下次用到再建——SQLite 建连接是毫秒级的，代价可以忽略。
 *
 * 为什么不做上限淘汰：上限会在高峰期把正在用的连接踢掉，表现为随机的查询失败。
 * 按闲置时间回收不会碰到正在用的。真到了连接数撑不住的规模，该换 Postgres 了。
 */
type Entry = { client: PrismaClient; lastUsed: number };

const globalForTenants = globalThis as unknown as { tenantClients: Map<string, Entry> | undefined };
const clients = (globalForTenants.tenantClients ??= new Map<string, Entry>());

/** 闲置多久后断开。比会话短、比一次页面浏览长 */
const IDLE_MS = 10 * 60 * 1000;
let sweeper: NodeJS.Timeout | null = null;

/** 业务库放哪。容器里是 /data/ws */
export function workspaceDir(): string {
  return process.env.WORKSPACE_DIR ?? path.resolve("prisma/ws");
}

export function workspaceDbPath(dbFile: string): string {
  // dbFile 来自控制面库，但仍然只取 basename：一旦哪里被注入 ../ 就会读到别的租户的库
  return path.join(workspaceDir(), path.basename(dbFile));
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, e] of clients) {
      if (now - e.lastUsed < IDLE_MS) continue;
      clients.delete(key);
      void e.client.$disconnect().catch(() => {});
    }
  }, 60_000);
  // 别让这个定时器拖住进程退出
  sweeper.unref?.();
}

async function applyPragmas(client: PrismaClient) {
  // 与单租户库同样的设置：WAL 让读写互不阻塞，busy_timeout 兜并发
  await client.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await client.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
}

/** 取（或建）某个工作区的客户端 */
export function workspaceClient(dbFile: string): PrismaClient {
  const key = path.basename(dbFile);
  const hit = clients.get(key);
  if (hit) {
    hit.lastUsed = Date.now();
    return hit.client;
  }
  const file = workspaceDbPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const client = new PrismaClient({
    datasources: { db: { url: `file:${file}` } },
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  void applyPragmas(client).catch((e) => console.error(`工作区 ${key} 设置 pragma 失败：`, e));
  clients.set(key, { client, lastUsed: Date.now() });
  startSweeper();
  return client;
}

/** 当前请求该用哪个客户端；没有工作区上下文就返回 null，由调用方落回默认库 */
export function tenantClient(): PrismaClient | null {
  const t = currentTenant();
  return t ? workspaceClient(t.dbFile) : null;
}

/** 删掉缓存里的某个工作区客户端（删除工作区、或库文件被换掉时用） */
export async function dropWorkspaceClient(dbFile: string): Promise<void> {
  const key = path.basename(dbFile);
  const e = clients.get(key);
  if (!e) return;
  clients.delete(key);
  await e.client.$disconnect().catch(() => {});
}
