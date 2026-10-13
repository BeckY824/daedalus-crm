/** 按字段钟导出当前起点；只清理失权的本地副本，不产生同步删除事件。 */
import { Prisma, type PrismaClient } from "@/generated/prisma";
import { 同步表, 不同步列, 同步的设置 } from "./tables";
import { 行键, 核对范围, 范围父表, type 范围索引, type 范围元数据 } from "./scope-policy";
import { 拆范围, 规范串, type 钥匙环 } from "./crypto";
import type { 改动 } from "./local";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const models = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name, m]));
export const 主字段 = (table: string) => models.get(table)!.fields.find(f => f.isId)!.name;
type Db = PrismaClient | Prisma.TransactionClient;
async function row(db: Db, table: string) {
  const columns = models.get(table)!.fields.filter(f => f.kind !== 'object' && !(不同步列[table] ?? []).includes(f.name)).map(f => f.name);
  // SQLite 的 json_object 保留毫秒数/布尔整数，和触发器里的编码相同，避免 BigInt/Date JSON 改变语义。
  const where = table === 'Setting' ? ` WHERE key IN (${同步的设置.map(() => '?').join(',')})` : '';
  const rows = await db.$queryRawUnsafe<{ value: string }[]>(`SELECT json_object(${columns.map(c => `'${c}', ${q(c)}`).join(',')}) AS value FROM ${q(table)}${where}`, ...(table === 'Setting' ? 同步的设置 : []));
  return rows.map(r => JSON.parse(r.value) as Record<string, unknown>);
}
export async function 范围快照(db: PrismaClient) {
  return db.$transaction(async tx => {
    const cutoff = Number((await tx.$queryRawUnsafe<{ n: bigint }[]>('SELECT COALESCE(MAX(seq),0) AS n FROM _sync_log'))[0].n);
    const clocks = await tx.$queryRawUnsafe<{ tbl: string; pk: string; col: string; hlc: string }[]>('SELECT * FROM _sync_field');
    const perRow = new Map<string, Map<string, string>>();
    for (const c of clocks) { const k = 行键(c.tbl, c.pk); const cols = perRow.get(k) ?? new Map(); cols.set(c.col, c.hlc); perRow.set(k, cols); }
    const events: 改动[] = [];
    for (const t of 同步表) for (const r of await row(tx, t)) {
      const k = String(r[主字段(t)]);
      events.push({ t, k, r, o: 'I', c: Object.keys(r), h: '0000000000000-snapshot' });
      const groups = new Map<string, string[]>();
      for (const [col, h] of perRow.get(行键(t, k)) ?? []) { const cols = groups.get(h) ?? []; cols.push(col); groups.set(h, cols); }
      for (const [h, c] of [...groups].sort(([a], [b]) => a.localeCompare(b))) events.push({ t, k, r, o: 'U', c, h });
    }
    for (const tomb of await tx.$queryRawUnsafe<{ tbl: string; pk: string; hlc: string }[]>('SELECT * FROM _sync_tomb')) {
      if ((同步表 as readonly string[]).includes(tomb.tbl)) events.push({ t: tomb.tbl, k: tomb.pk, o: 'D', r: null, c: [], h: tomb.hlc });
    }
    return { cutoff, events };
  }, { timeout: 180_000 });
}
/** 失权的本机未上传改动不丢：整行副本和改动列表搬进这张表，界面显示「待老板核对」，由人决定怎么处理。 */
export async function 建范围冲突表(db: Db) {
  await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _sync_scope_conflict (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL, row TEXT, changed TEXT NOT NULL, at BIGINT NOT NULL, reason TEXT NOT NULL, createdAt BIGINT NOT NULL)");
}
/** 把指定的待推日志行转成显式冲突：复制到 _sync_scope_conflict 后才从 _sync_log 移走，同一事务内完成。 */
export async function 转为范围冲突(db: PrismaClient, seqs: number[], reason: string) {
  if (!seqs.length) return 0;
  await 建范围冲突表(db);
  return db.$transaction(async tx => {
    let n = 0;
    for (const seq of seqs) {
      const l = (await tx.$queryRawUnsafe<{ tbl: string; pk: string; op: string; row: string | null; changed: string; at: bigint }[]>("SELECT * FROM _sync_log WHERE seq = ?", seq))[0];
      if (!l) continue;
      // 改动（U）只留本人改的那几列：日志里是整行，其余列是失权记录（可能是老板私客）的资料，不能借冲突表留下
      let row = l.row;
      if (l.op === "U" && row && l.changed !== "*") {
        const full = JSON.parse(row) as Record<string, unknown>;
        row = JSON.stringify(Object.fromEntries(l.changed.split(",").filter(c => c in full).map(c => [c, full[c]])));
      }
      await tx.$executeRawUnsafe("INSERT INTO _sync_scope_conflict (tbl, pk, op, row, changed, at, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", l.tbl, l.pk, l.op, row, l.changed, l.at, reason.slice(0, 300), Date.now());
      await tx.$executeRawUnsafe("DELETE FROM _sync_log WHERE seq = ?", seq);
      n++;
    }
    return n;
  });
}
export async function 范围冲突数(db: Db): Promise<number> {
  try { return Number((await db.$queryRawUnsafe<{ n: bigint | number }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict"))[0]?.n ?? 0); } catch { return 0; }
}
const 全队表 = ['User', 'Setting', 'Channel', 'Supplier'];
/** 失去权限后不仅删客户，也清除同步日志、相关导入撤销快照里的旧副本。
 * 失权记录若仍有未上传改动：先转成显式冲突（_sync_scope_conflict），绝不静默丢弃，也不推给云端。
 * 边界：只处理本账号 crm.db；不删备份文件、不删 AI 对话（只统计可能涉及失权客户的条数供界面提示）。
 * 调用方须确认待推队列已推完（或已逐条转冲突），否则刚建、尚未进服务端目录的本人记录会被误判失权。
 */
export async function 清理失权副本(db: PrismaClient, allowed: Set<string>) {
  await 建范围冲突表(db);
  const pending = await db.$queryRawUnsafe<{ seq: bigint | number; tbl: string; pk: string }[]>("SELECT seq, tbl, pk FROM _sync_log WHERE seq > COALESCE((SELECT v FROM _sync_cursor WHERE k = 'pushed'),0)");
  const lost: Array<{ t: string; k: string }> = [];
  const seen = new Set<string>();
  const add = (t: string, k: string) => { const key = 行键(t, k); if (!seen.has(key) && !allowed.has(key)) { seen.add(key); lost.push({ t, k }); } };
  for (const t of 同步表) {
    if (全队表.includes(t)) continue;
    for (const r of await db.$queryRawUnsafe<{ k: string }[]>(`SELECT ${q(主字段(t))} AS k FROM ${q(t)}`)) add(t, String(r.k));
  }
  // 已删除的客户可能仍藏在旧同步日志整行里，也要收走。
  for (const aux of ['_sync_log', '_sync_field', '_sync_tomb', '_sync_skip']) for (const r of await db.$queryRawUnsafe<{ tbl: string; pk: string }[]>(`SELECT DISTINCT tbl, pk FROM ${aux}`)) {
    if ((同步表 as readonly string[]).includes(r.tbl) && !全队表.includes(r.tbl)) add(r.tbl, r.pk);
  }
  const conflicts = await 转为范围冲突(db, pending.filter(p => seen.has(行键(p.tbl, p.pk))).map(p => Number(p.seq)), '该记录已不在本机同步范围内（转交、领取或权限变化）；未上传改动已保留，请与老板核对');
  const lostCustomers = lost.filter(x => x.t === 'Customer').map(x => x.k);
  let ai = 0;
  for (const id of lostCustomers.slice(0, 500)) ai += Number((await db.$queryRawUnsafe<{ n: bigint | number }[]>("SELECT COUNT(*) AS n FROM AiMessage WHERE refs LIKE ? OR steps LIKE ?", `%${id}%`, `%${id}%`).catch(() => [{ n: 0 }]))[0]?.n ?? 0);
  if (!lost.length) return { 删: 0, 冲突: conflicts, AI残留: 0 };
  // PRAGMA secure_delete 会返回一行结果，只能用 queryRaw（草稿用 executeRaw，业务员首轮清理必然失败）
  await db.$queryRawUnsafe('PRAGMA secure_delete = ON');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('UPDATE _sync_state SET applying = 1 WHERE id = 1');
    await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
    // 先断开可空的推荐关系，避免可见客户因推荐人失权触发外键错误。
    for (const c of ['referrerCustomerId', 'attributionCustomerId']) for (const k of lostCustomers) await tx.$executeRawUnsafe(`UPDATE Customer SET ${q(c)} = NULL WHERE ${q(c)} = ?`, k);
    for (const t of [...同步表].reverse()) for (const r of lost.filter(x => x.t === t)) {
      await tx.$executeRawUnsafe(`DELETE FROM ${q(t)} WHERE ${q(主字段(t))} = ?`, r.k);
      for (const aux of ['_sync_log', '_sync_field', '_sync_tomb', '_sync_skip']) await tx.$executeRawUnsafe(`DELETE FROM ${aux} WHERE tbl = ? AND pk = ?`, t, r.k);
    }
    // 导入撤销快照（ImportRow.before）可能存着失权客户原来的格子，一并删除；批次本身留着，计数不改。
    for (const k of lostCustomers) await tx.$executeRawUnsafe('DELETE FROM ImportRow WHERE customerId = ?', k);
    await tx.$executeRawUnsafe('UPDATE _sync_state SET applying = 0 WHERE id = 1');
  }, { timeout: 180_000 });
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
  return { 删: lost.length, 冲突: conflicts, AI残留: ai };
}
/** 服务端当前路由覆盖历史包中的过期路由；隐藏推荐人只置空 FK，不复制隐藏客户来满足外键。 */
export function 归一化范围行(e: 改动, current: 范围索引, authorized: Set<string>): 改动 {
  if (e.o === 'D') return e;
  if (!e.r || String(e.r[主字段(e.t)]) !== e.k) throw Error('密文的记录编号与授权编号不一致');
  const r = { ...e.r, ...current.fields };
  if (e.t === 'Customer') for (const field of ['referrerCustomerId', 'attributionCustomerId']) if (r[field] && !authorized.has(行键('Customer', String(r[field])))) r[field] = null;
  return { ...e, r };
}

/** 一包范围密文不合规（元数据对不上、关系链指向不可见记录）：确定性错误，重试也不会好，接收端跳过并记下。 */
export class 范围包错误 extends Error {}
export type 拉到的范围包 = { seq: number; device: string; eventId: string; meta: 范围元数据; data: string };
/**
 * 接收端逐项核对（服务端没有钥匙，只能在这里验）：
 *  1. AAD 绑定团队/推送设备/eventId/外层元数据摘要，解得开 = 中转没改过外层；
 *  2. 内层声明的元数据与外层一致，且与改动本身重新提取的路由字段一致（推送者不能外层写本人客户、内层改老板客户）；
 *  3. 该记录在本机当前目录里、且属于本机有权的范围；
 *  4. 按服务端当前路由归一化后，所有父链引用都指向本机有权的记录（不能借外键逼本机收隐藏客户）。
 */
export function 验收范围包(b: 拉到的范围包, keys: 钥匙环, teamId: string, current: 范围索引 | undefined, allowed: Set<string>): 改动 {
  let inner: { meta: 范围元数据; change: 改动 };
  try {
    inner = 拆范围(b.data, keys, { teamId, device: b.device, eventId: b.eventId, meta: b.meta });
  } catch (e) {
    if (e instanceof Error && /^没有 \d+ 号钥匙/.test(e.message)) throw e;
    throw new 范围包错误('范围密文与外层元数据不符或已损坏');
  }
  if (!inner || 规范串(inner.meta) !== 规范串(b.meta) || !核对范围(b.meta, inner.change)) throw new 范围包错误('密文内容与授权元数据不一致');
  const key = 行键(b.meta.t, b.meta.k);
  if (!current || !allowed.has(key)) throw new 范围包错误('该记录不在本机同步范围内');
  const e = 归一化范围行(inner.change, current, allowed);
  if (e.o !== 'D' && e.r) for (const [field, table] of Object.entries(范围父表[e.t] ?? {})) {
    const v = e.r[field];
    if (v != null && !allowed.has(行键(table, String(v)))) throw new 范围包错误(`关联的${table}不在本机同步范围内`);
  }
  return e;
}
