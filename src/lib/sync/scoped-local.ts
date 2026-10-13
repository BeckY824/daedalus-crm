/** 按字段钟导出当前起点；只清理失权的本地副本，不产生同步删除事件。 */
import { Prisma, type PrismaClient } from "@/generated/prisma";
import { 同步表, 不同步列, 同步的设置 } from "./tables";
import { 行键, type 范围索引 } from "./scope-policy";
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
/** 失去权限后不仅删客户，也清除同步日志、相关导入撤销快照里的旧副本。
 * 若有未上传的失权记录先报冲突，绝不静默丢弃；调用方须在显示待处理状态时阻止备份宣称隔离已完成。
 */
export async function 清理失权副本(db: PrismaClient, allowed: Set<string>) {
  const pending = await db.$queryRawUnsafe<{ tbl: string; pk: string }[]>("SELECT tbl, pk FROM _sync_log WHERE seq > COALESCE((SELECT v FROM _sync_cursor WHERE k = 'pushed'),0)");
  const lost: Array<{ t: string; k: string }> = [];
  for (const t of 同步表) {
    if (['User', 'Setting', 'Channel', 'Supplier'].includes(t)) continue;
    for (const r of await db.$queryRawUnsafe<{ k: string }[]>(`SELECT ${q(主字段(t))} AS k FROM ${q(t)}`)) if (!allowed.has(行键(t, r.k))) lost.push({ t, k: r.k });
  }
  // 已删除的客户可能仍藏在旧同步日志整行里，也要收走。
  for (const aux of ['_sync_log', '_sync_field', '_sync_tomb', '_sync_skip']) for (const r of await db.$queryRawUnsafe<{ tbl: string; pk: string }[]>(`SELECT DISTINCT tbl, pk FROM ${aux}`)) {
    if ((同步表 as readonly string[]).includes(r.tbl) && !['User', 'Setting', 'Channel', 'Supplier'].includes(r.tbl) && !allowed.has(行键(r.tbl, r.pk)) && !lost.some(x => x.t === r.tbl && x.k === r.pk)) lost.push({ t: r.tbl, k: r.pk });
  }
  const gone = new Set(lost.map(r => 行键(r.t, r.k)));
  if (pending.some(p => gone.has(行键(p.tbl, p.pk)))) throw Error('失权资料仍有未上传改动，范围迁移尚未完成；请由老板核对这些改动后继续');
  if (!lost.length) return 0;
  await db.$executeRawUnsafe('PRAGMA secure_delete = ON');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('UPDATE _sync_state SET applying = 1 WHERE id = 1');
    await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
    // 先断开可空的推荐关系，避免可见客户因推荐人失权触发外键错误。
    for (const c of ['referrerCustomerId', 'attributionCustomerId']) for (const r of lost.filter(x => x.t === 'Customer')) await tx.$executeRawUnsafe(`UPDATE Customer SET ${q(c)} = NULL WHERE ${q(c)} = ?`, r.k);
    for (const t of [...同步表].reverse()) for (const r of lost.filter(x => x.t === t)) {
      await tx.$executeRawUnsafe(`DELETE FROM ${q(t)} WHERE ${q(主字段(t))} = ?`, r.k);
      for (const aux of ['_sync_log', '_sync_field', '_sync_tomb', '_sync_skip']) await tx.$executeRawUnsafe(`DELETE FROM ${aux} WHERE tbl = ? AND pk = ?`, t, r.k);
    }
    for (const r of lost.filter(x => x.t === 'Customer')) await tx.importRow.deleteMany({ where: { customerId: r.k } });
    await tx.$executeRawUnsafe('UPDATE _sync_state SET applying = 0 WHERE id = 1');
  }, { timeout: 180_000 });
  await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
  return lost.length;
}
/** 服务端当前路由覆盖历史包中的过期路由；隐藏推荐人只置空 FK，不复制隐藏客户来满足外键。 */
export function 归一化范围行(e: 改动, current: 范围索引, authorized: Set<string>): 改动 {
  if (e.o === 'D') return e;
  if (!e.r || String(e.r[主字段(e.t)]) !== e.k) throw Error('密文的记录编号与授权编号不一致');
  const r = { ...e.r, ...current.fields };
  if (e.t === 'Customer') for (const field of ['referrerCustomerId', 'attributionCustomerId']) if (r[field] && !authorized.has(行键('Customer', String(r[field])))) r[field] = null;
  return { ...e, r };
}
