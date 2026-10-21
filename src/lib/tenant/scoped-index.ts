/**
 * 范围同步的团队索引缓存（2026-10-21，客户 Even 30 人压测）。
 *
 * 原来每次取目录、每次拉一个范围都把整队的 SyncScopedRecord 读出来、逐条 JSON.parse、逐条算范围；
 * 老板一轮要拉「每位客户一个范围」，1000 位客户的团队一轮就是 1000 次整表读 —— 本机 30 台时云端一个核打满。
 * 现在每个团队在内存里留一份：记录、每条记录最新的批次号、按范围分好的组。只有收推送改了记录才作废，
 * 而且只重读改过的那几条（推送时记下的键），别的照用；分组在内存里重算。
 *
 * 只有收范围推送写 SyncScopedRecord（开始 / 完成迁移、移除成员都不改它），推送这样告诉缓存（sync-scoped.ts 收范围推送）：
 *   - 开始写之前 推送开始()，提交 / 回滚之后 推送结束()：拉取开始时有推送在途就等它结束（它可能在拉取读批次之前提交）；
 *   - 提交之前 记改过() 一次：拉取在事务结束时核版本，读批次之前提交的推送一定让版本变了，拉取重来；
 *   - 提交之后再 记改过() 一次：提交前那一刻有人重建了缓存（读到的还是旧数据），第二次让它下次再重读这几条。
 * 这样拉取给出去的批次和它用来判「这条记录在不在这个范围」的索引是同一时刻的——转走的客户不会借旧缓存多拉到一条。
 * 云端只有一个 node server.js 进程（Dockerfile），缓存放 globalThis，开发时热重载也不丢。多进程部署要换成库里的版本号。
 * CRM_SCOPED_CACHE_OFF=1：整个回老路——不留缓存、每次现读现算，目录也不发增量、不带 head（和原来一样慢，出了问题先关它，不用回滚版本）。
 */
import { randomUUID } from "node:crypto";
import { control } from "./control";
import { 算范围, type 范围, type 范围索引 } from "../sync/scope-policy";

/** 一个范围：head = 这个范围里所有记录最新的批次号，客户端游标已经到这儿就不用拉；sig 变了 = 这个范围的记录有变化（增量目录用） */
export type 范围组 = { id: string; scope: 范围; revision: number; head: number; records: 范围索引[]; sig: string };
export type 团队索引 = {
  ver: number;
  rows: Map<string, 范围索引>;
  heads: Map<string, number>;
  /** 每条记录现在属于哪个范围（算不出来 = null，不给任何人） */
  归: Map<string, 范围 | null>;
  groups: Map<string, 范围组>;
  /** 老板目录里的 needBaseline 按版本算一次（只跟推送有关，见 sync-scoped.ts 目录里） */
  needBaseline?: string[];
};

type 状态 = { 缓存: Map<string, 团队索引>; 版本: Map<string, number>; 脏: Map<string, Set<string>>; 在建: Map<string, Promise<团队索引>>; 在推: Map<string, number> };
const g = globalThis as unknown as { 范围索引缓存?: 状态 };
const 态 = (g.范围索引缓存 ??= { 缓存: new Map(), 版本: new Map(), 脏: new Map(), 在建: new Map(), 在推: new Map() });

export const 索引版本 = (teamId: string) => 态.版本.get(teamId) ?? 0;
export const 有推送在途 = (teamId: string) => (态.在推.get(teamId) ?? 0) > 0;
export function 推送开始(teamId: string) { 态.在推.set(teamId, (态.在推.get(teamId) ?? 0) + 1); }
export function 推送结束(teamId: string) {
  const n = (态.在推.get(teamId) ?? 0) - 1;
  if (n > 0) 态.在推.set(teamId, n); else 态.在推.delete(teamId);
}
/** CRM_SCOPED_CACHE_OFF=1：回老路——不留缓存、目录发全的、不带 head（客户端没有 head 就照旧每个范围都拉） */
export const 缓存关着 = () => process.env.CRM_SCOPED_CACHE_OFF === "1";
const 关着 = 缓存关着;

/** 收范围推送改了这几条记录（提交前、提交后各调一次） */
export function 记改过(teamId: string, keys: Iterable<string>) {
  const s = 态.脏.get(teamId) ?? new Set<string>();
  for (const k of keys) s.add(k);
  态.脏.set(teamId, s);
  态.版本.set(teamId, 索引版本(teamId) + 1);
}

/** 测试直接改库（模拟老版本留下的索引）后调；不传 = 全清 */
export function 清索引缓存(teamId?: string) {
  if (teamId === undefined) { 态.缓存.clear(); 态.脏.clear(); return; }
  态.缓存.delete(teamId); 态.脏.delete(teamId);
}

export async function 团队索引(teamId: string): Promise<团队索引> {
  if (关着()) { 态.缓存.delete(teamId); return 建(teamId, undefined, false); }
  for (;;) {
    const e = 态.缓存.get(teamId);
    if (e && e.ver === 索引版本(teamId)) return e;
    // 同一个团队同时只建一份：几十台同时来要目录，只读一次库
    const 在建 = 态.在建.get(teamId);
    if (在建) { await 在建.catch(() => undefined); continue; }
    const p = 建(teamId, e).finally(() => 态.在建.delete(teamId));
    态.在建.set(teamId, p);
    return p;
  }
}

async function 建(teamId: string, 旧: 团队索引 | undefined, 存 = true): Promise<团队索引> {
  // 版本和脏键同一刻取走：取走之后再有推送，会重新记脏、加版本，下次再读
  const ver = 索引版本(teamId);
  const 脏 = 存 ? 态.脏.get(teamId) : undefined;
  if (存) 态.脏.delete(teamId);
  let rows: Map<string, 范围索引>, heads: Map<string, number>, e: 团队索引;
  try {
    if (!旧) {
      rows = new Map((await control.syncScopedRecord.findMany({ where: { teamId } })).map((r) => [r.key, JSON.parse(r.metadata) as 范围索引]));
      heads = new Map((await control.syncScopedBatch.groupBy({ by: ["recordKey"], where: { teamId }, _max: { id: true } })).map((x) => [x.recordKey, x._max.id ?? 0]));
    } else {
      // 只重读改过的：不改原来那份（正在用它的请求不受影响），复制一份再改
      rows = new Map(旧.rows); heads = new Map(旧.heads);
      const keys = [...(脏 ?? [])];
      for (let i = 0; i < keys.length; i += 400) {
        const part = keys.slice(i, i + 400);
        for (const r of await control.syncScopedRecord.findMany({ where: { teamId, key: { in: part } } })) rows.set(r.key, JSON.parse(r.metadata) as 范围索引);
        for (const x of await control.syncScopedBatch.groupBy({ by: ["recordKey"], where: { teamId, recordKey: { in: part } }, _max: { id: true } })) heads.set(x.recordKey, x._max.id ?? 0);
      }
    }
    e = { ver, rows, heads, ...分组(rows, heads) };
  } catch (err) {
    // 读库失败：取走的脏键放回去（并上这期间新记的），下次照样重读这几条。不放回的话下次拿旧缓存 + 空脏键建出来、按新版本存下，
    // 转走的客户就一直留在旧范围里，直到这位再被推一次或者云端重启（10-21 质量审 #78 抓到）
    if (脏?.size) { const s = 态.脏.get(teamId) ?? new Set<string>(); for (const k of 脏) s.add(k); 态.脏.set(teamId, s); }
    throw err;
  }
  // 建的这段时间里版本又变了也照样存：下次 团队索引 看到版本不对，再按新的脏键补
  if (存) 态.缓存.set(teamId, e);
  return e;
}

/** 按范围分组：一条记录的范围可能跟着父记录变（跟进换了客户、客户进出公海），所以每次整队重算，只在内存里 */
function 分组(rows: Map<string, 范围索引>, heads: Map<string, number>) {
  const 归 = new Map<string, 范围 | null>(), groups = new Map<string, 范围组>();
  for (const [key, r] of rows) {
    const scope = 算范围(r, rows);
    归.set(key, scope);
    if (!scope) continue;
    let x = groups.get(scope.id);
    if (!x) groups.set(scope.id, (x = { id: scope.id, scope, revision: 0, head: 0, records: [], sig: "" }));
    x.revision = Math.max(x.revision, scope.routeSeq);
    x.head = Math.max(x.head, heads.get(key) ?? 0);
    x.records.push(r);
  }
  /*
    sig：记录的索引只会随它自己的新批次变（head 变），客户进出公海改的 routeSeq 也带着公海那一行的新批次（同一个范围）；
    记录进出一个范围要么带来新批次（进来的那条，head 变），要么条数变（走掉的）。所以 revision + head + 条数 就够认出变化
  */
  for (const x of groups.values()) x.sig = `${x.revision}:${x.head}:${x.records.length}`;
  return { 归, groups };
}

/*
  目录只发变了的（2026-10-21）：每台设备上次拿到的那份按设备记在这里（token + 每个范围的 sig）。
  客户端带着上次的 token 来、和这里记的对得上，就只发 sig 变了的范围和看不到了的范围编号；对不上（回包丢了、云端重启、
  换了电脑、头一次）就发全的。最多记 5000 台，满了丢最早的（那台下次拿全的）
*/
type 上次 = { token: string; sigs: Map<string, string> };
const 目录记 = ((g as unknown as { 范围目录记?: Map<string, 上次> }).范围目录记 ??= new Map());

export function 目录增量(谁: string | null, base: unknown, groups: 范围组[]): { token?: string; delta: boolean; scopes: 范围组[]; removed: string[] } {
  if (!谁) return { delta: false, scopes: groups, removed: [] };
  const 旧 = 目录记.get(谁);
  const token = randomUUID();
  const sigs = new Map(groups.map((x) => [x.id, x.sig]));
  目录记.delete(谁);
  目录记.set(谁, { token, sigs });
  if (目录记.size > 5000) 目录记.delete(目录记.keys().next().value!);
  if (!旧 || typeof base !== "string" || base !== 旧.token) return { token, delta: false, scopes: groups, removed: [] };
  return { token, delta: true, scopes: groups.filter((x) => 旧.sigs.get(x.id) !== x.sig), removed: [...旧.sigs.keys()].filter((id) => !sigs.has(id)) };
}
