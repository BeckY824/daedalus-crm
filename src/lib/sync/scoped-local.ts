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
async function row(db: Db, table: string, pk?: string) {
  const columns = models.get(table)!.fields.filter(f => f.kind !== 'object' && !(不同步列[table] ?? []).includes(f.name)).map(f => f.name);
  // SQLite 的 json_object 保留毫秒数/布尔整数，和触发器里的编码相同，避免 BigInt/Date JSON 改变语义。
  const conds: string[] = [], args: unknown[] = [];
  if (table === 'Setting') { conds.push(`key IN (${同步的设置.map(() => '?').join(',')})`); args.push(...同步的设置); }
  if (pk !== undefined) { conds.push(`${q(主字段(table))} = ?`); args.push(pk); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const rows = await db.$queryRawUnsafe<{ value: string }[]>(`SELECT json_object(${columns.map(c => `'${c}', ${q(c)}`).join(',')}) AS value FROM ${q(table)}${where}`, ...args);
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
/**
 * 改归属后补发的「当前状态起点」：根记录及其所有子记录（按 范围父表 向下展开）各一条整行插入 + 按字段钟分组的改动。
 * 新获权的人只收这份起点和之后的改动，拿不到这条记录不在他范围时的历史密文。
 */
export async function 记录快照(db: Db, roots: string[]) {
  const want = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [t, parents] of Object.entries(范围父表)) for (const [field, table] of Object.entries(parents)) {
      const ids = [...want].filter(k => k.startsWith(`${table}:`)).map(k => k.slice(table.length + 1));
      for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        for (const r of await db.$queryRawUnsafe<{ k: string }[]>(`SELECT ${q(主字段(t))} AS k FROM ${q(t)} WHERE ${q(field)} IN (${part.map(() => '?').join(',')})`, ...part)) {
          const key = 行键(t, String(r.k)); if (!want.has(key)) { want.add(key); grew = true; }
        }
      }
    }
  }
  // 操作日志按 entity / entityId 挂在记录上（不在 范围父表 里）：一并给起点，接手的人看得到这位客户的操作记录
  if ((同步表 as readonly string[]).includes('AuditLog')) {
    const byTable = new Map<string, string[]>();
    for (const key of want) { const i = key.indexOf(':'); const t = key.slice(0, i); if (t !== 'AuditLog') byTable.set(t, [...(byTable.get(t) ?? []), key.slice(i + 1)]); }
    for (const [t, ids] of byTable) for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      for (const r of await db.$queryRawUnsafe<{ k: string }[]>(`SELECT id AS k FROM "AuditLog" WHERE entity = ? AND entityId IN (${part.map(() => '?').join(',')})`, t, ...part)) want.add(行键('AuditLog', String(r.k)));
    }
  }
  const events: 改动[] = [];
  for (const key of want) {
    const i = key.indexOf(':'), t = key.slice(0, i), k = key.slice(i + 1);
    if (!(同步表 as readonly string[]).includes(t)) continue;
    const r = (await row(db, t, k))[0];
    if (!r) continue;
    events.push({ t, k, r, o: 'I', c: Object.keys(r), h: '0000000000000-snapshot' });
    const groups = new Map<string, string[]>();
    for (const c of await db.$queryRawUnsafe<{ col: string; hlc: string }[]>('SELECT col, hlc FROM _sync_field WHERE tbl = ? AND pk = ?', t, k)) { const cols = groups.get(c.hlc) ?? []; cols.push(c.col); groups.set(c.hlc, cols); }
    for (const [h, c] of [...groups].sort(([a], [b]) => a.localeCompare(b))) events.push({ t, k, r, o: 'U', c, h });
  }
  return events;
}
/** 失权的本机未上传改动不丢：整行副本和改动列表搬进这张表，界面显示「待老板核对」，由人决定怎么处理。 */
export async function 建范围冲突表(db: Db) {
  await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _sync_scope_conflict (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL, row TEXT, changed TEXT NOT NULL, at BIGINT NOT NULL, reason TEXT NOT NULL, createdAt BIGINT NOT NULL, resolvedAt BIGINT)");
  // 早期草稿建的表没有 resolvedAt：补一列（本机库，只加列）
  const cols = await db.$queryRawUnsafe<{ name: string }[]>("PRAGMA table_info(_sync_scope_conflict)");
  if (!cols.some(c => c.name === "resolvedAt")) await db.$executeRawUnsafe("ALTER TABLE _sync_scope_conflict ADD COLUMN resolvedAt BIGINT");
}
export type 范围冲突条目 = { id: number; 表: string; 编号: string; 名称: string; 操作: string; 改动列: string[]; 改动时间: string; 原因: string; 已确认: string | null };
const 表名: Record<string, string> = { Customer: "客户", Contact: "联系人", FollowUp: "跟进", Opportunity: "商机", Contract: "签约", Task: "任务", FollowPlan: "跟进计划", Lead: "线索", UnassignedContact: "待归属联系人", TradeOrder: "外贸订单" };
/**
 * 列出失权冲突（默认只列未确认的）。名称：记录仍在本机（仍有权）就用本机的名字；
 * 否则只用冲突里本人改过的值（name/title），都没有就只显示编号——不为显示去找失权记录的资料。
 */
export async function 列出范围冲突(db: Db, 含已确认 = false): Promise<范围冲突条目[]> {
  await 建范围冲突表(db);
  const rows = await db.$queryRawUnsafe<{ id: bigint; tbl: string; pk: string; op: string; row: string | null; changed: string; at: bigint; reason: string; resolvedAt: bigint | null }[]>(`SELECT * FROM _sync_scope_conflict ${含已确认 ? "" : "WHERE resolvedAt IS NULL"} ORDER BY id DESC LIMIT 500`);
  const out: 范围冲突条目[] = [];
  for (const r of rows) {
    let 名称 = "";
    if ((同步表 as readonly string[]).includes(r.tbl)) {
      const cols = models.get(r.tbl)?.fields.map(f => f.name) ?? [];
      const col = ["name", "title"].find(c => cols.includes(c));
      if (col) 名称 = String((await db.$queryRawUnsafe<{ v: string }[]>(`SELECT ${q(col)} AS v FROM ${q(r.tbl)} WHERE ${q(主字段(r.tbl))} = ?`, r.pk))[0]?.v ?? "");
    }
    if (!名称 && r.row) { try { const j = JSON.parse(r.row) as Record<string, unknown>; 名称 = String(j.name ?? j.title ?? ""); } catch { /* 坏行只显示编号 */ } }
    const 改动列 = r.changed === "*" ? ["（整条新建）"] : r.changed.split(",").filter(Boolean);
    out.push({ id: Number(r.id), 表: 表名[r.tbl] ?? r.tbl, 编号: r.pk, 名称: 名称 || r.pk, 操作: r.op === "I" ? "新建" : r.op === "D" ? "删除" : "修改", 改动列, 改动时间: new Date(Number(r.at)).toISOString(), 原因: r.reason, 已确认: r.resolvedAt == null ? null : new Date(Number(r.resolvedAt)).toISOString() });
  }
  return out;
}
/** 确认 = 标记已处理，不删除；导出里仍能看到 */
export async function 确认范围冲突(db: Db, ids: number[]) {
  await 建范围冲突表(db);
  let n = 0;
  for (const id of ids.filter(Number.isSafeInteger)) n += Number(await db.$executeRawUnsafe("UPDATE _sync_scope_conflict SET resolvedAt = ? WHERE id = ? AND resolvedAt IS NULL", Date.now(), id));
  return n;
}
/** 导出全部冲突（含已确认、含本人改动的原值），给老板核对或手工补录 */
export async function 导出范围冲突(db: Db) {
  await 建范围冲突表(db);
  const rows = await db.$queryRawUnsafe<{ id: bigint; tbl: string; pk: string; op: string; row: string | null; changed: string; at: bigint; reason: string; resolvedAt: bigint | null }[]>("SELECT * FROM _sync_scope_conflict ORDER BY id");
  return JSON.stringify({ 说明: "这些是本机在失去同步权限前没来得及上传的改动，只含本人改过的内容。请与老板核对后在 CRM 中手工处理。", 导出时间: new Date().toISOString(), 条目: rows.map(r => ({ id: Number(r.id), 表: r.tbl, 编号: r.pk, 操作: r.op, 改动列: r.changed, 改动内容: r.row ? JSON.parse(r.row) : null, 改动时间: new Date(Number(r.at)).toISOString(), 原因: r.reason, 已确认: r.resolvedAt == null ? null : new Date(Number(r.resolvedAt)).toISOString() })) }, null, 2);
}
/** 把指定的待推日志行转成显式冲突：复制到 _sync_scope_conflict 后才从 _sync_log 移走，同一事务内完成。 */
export async function 转为范围冲突(db: PrismaClient, seqs: number[], reason: string) {
  if (!seqs.length) return 0;
  await 建范围冲突表(db);
  return db.$transaction(tx => 转冲突(tx, seqs, reason));
}
async function 转冲突(tx: Db, seqs: number[], reason: string) {
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
}
export async function 范围冲突数(db: Db): Promise<number> {
  try { await 建范围冲突表(db); return Number((await db.$queryRawUnsafe<{ n: bigint | number }[]>("SELECT COUNT(*) AS n FROM _sync_scope_conflict WHERE resolvedAt IS NULL"))[0]?.n ?? 0); } catch { return 0; }
}
const 全队表 = ['User', 'Setting', 'Channel', 'Supplier'];
/** 失去权限后不仅删客户，也清除同步日志、相关导入撤销快照里的旧副本。
 * 失权记录若仍有未上传改动：先转成显式冲突（_sync_scope_conflict），绝不静默丢弃，也不推给云端。
 * 边界：只处理本账号 crm.db；不删备份文件、不删 AI 对话（只统计可能涉及失权客户的条数供界面提示）。
 *
 * 本机刚建、还没推上去的记录不算失权（2026-10-14，五台实测 migrate 模式抓到）：调用方先推完再取目录，但推完到清理之间人还在录——
 * 刚建的客户服务端还不知道、不在刚取的目录里，原来会被当成失权删掉：有的转了冲突，读完待推之后才建的连冲突都没有、同步日志一起删了，静默丢数据。
 * 所以：待推里有「新建」的记录这一轮不清（下一轮推上去，收下就进目录，被拒就由推送转冲突）；挂在失权记录下的新建照样算失权
 * （推上去也会被拒，留着会违反外键）。读待推、判失权、转冲突、删除放在同一个事务里（本机只有一个连接，这期间别的写排队），中间插不进新改动。
 */
export async function 清理失权副本(db: PrismaClient, allowed: Set<string>) {
  await 建范围冲突表(db);
  // PRAGMA secure_delete 会返回一行结果，只能用 queryRaw（草稿用 executeRaw，业务员首轮清理必然失败）
  await db.$queryRawUnsafe('PRAGMA secure_delete = ON');
  const r = await db.$transaction(async tx => {
    const pending = await tx.$queryRawUnsafe<{ seq: bigint | number; tbl: string; pk: string; op: string }[]>("SELECT seq, tbl, pk, op FROM _sync_log WHERE seq > COALESCE((SELECT v FROM _sync_cursor WHERE k = 'pushed'),0)");
    const 不在目录: Array<{ t: string; k: string }> = [];
    const seen = new Set<string>();
    const add = (t: string, k: string) => { const key = 行键(t, k); if (!seen.has(key) && !allowed.has(key)) { seen.add(key); 不在目录.push({ t, k }); } };
    for (const t of 同步表) {
      if (全队表.includes(t)) continue;
      for (const r of await tx.$queryRawUnsafe<{ k: string }[]>(`SELECT ${q(主字段(t))} AS k FROM ${q(t)}`)) add(t, String(r.k));
    }
    // 已删除的客户可能仍藏在旧同步日志整行里，也要收走。
    for (const aux of ['_sync_log', '_sync_field', '_sync_tomb', '_sync_skip']) for (const r of await tx.$queryRawUnsafe<{ tbl: string; pk: string }[]>(`SELECT DISTINCT tbl, pk FROM ${aux}`)) {
      if ((同步表 as readonly string[]).includes(r.tbl) && !全队表.includes(r.tbl)) add(r.tbl, r.pk);
    }
    // 本机新建还没推的：先都留着，再把父记录（范围父表 / 操作日志的对象）失权的剔出去，直到不再变
    const 留 = new Set(pending.filter(p => p.op === 'I').map(p => 行键(p.tbl, p.pk)).filter(k => seen.has(k)));
    const 父们 = new Map<string, string[]>();
    for (const key of 留) {
      const i = key.indexOf(':'), t = key.slice(0, i), k = key.slice(i + 1);
      const row = (await tx.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${q(t)} WHERE ${q(主字段(t))} = ?`, k))[0];
      const ps: string[] = [];
      if (row && t === 'AuditLog' && row.entity && row.entityId) ps.push(行键(String(row.entity), String(row.entityId)));
      if (row) for (const [field, table] of Object.entries(范围父表[t] ?? {})) if (row[field]) ps.push(行键(table, String(row[field])));
      父们.set(key, ps);
    }
    for (let 变 = true; 变;) {
      变 = false;
      for (const key of [...留]) if ((父们.get(key) ?? []).some(p => seen.has(p) && !留.has(p))) { 留.delete(key); 变 = true; }
    }
    const lost = 不在目录.filter(x => !留.has(行键(x.t, x.k)));
    const lostKeys = new Set(lost.map(x => 行键(x.t, x.k)));
    const conflicts = await 转冲突(tx, pending.filter(p => lostKeys.has(行键(p.tbl, p.pk))).map(p => Number(p.seq)), '该记录已不在本机同步范围内（转交、领取或权限变化）；未上传改动已保留，请与老板核对');
    if (!lost.length) return { 删: 0, 冲突: conflicts, AI残留: 0 };
    const lostCustomers = lost.filter(x => x.t === 'Customer').map(x => x.k);
    let ai = 0;
    for (const id of lostCustomers.slice(0, 500)) ai += Number((await tx.$queryRawUnsafe<{ n: bigint | number }[]>("SELECT COUNT(*) AS n FROM AiMessage WHERE refs LIKE ? OR steps LIKE ?", `%${id}%`, `%${id}%`).catch(() => [{ n: 0 }]))[0]?.n ?? 0);
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
    await 记欠擦(tx);
    return { 删: lost.length, 冲突: conflicts, AI残留: ai };
  }, { timeout: 180_000 });
  // 删了就整库重建；这一轮没删、但上一次没擦净（WAL 被别的读者占着）也补擦
  if (r.删 || await 欠擦(db)) return { ...r, 擦净: await 擦净删除残留(db) };
  return r;
}
/*
  删掉的行不能在库文件里留下可恢复的字节（2026-10-14 加固）：secure_delete 只把「这一次删掉的格子」清零，
  旧协议时期改过的行在页内空隙、空闲页里留下的旧副本、WAL 里的旧页都还在（五台实测：业务员 crm.db 原始字节里搜得到老板私客的电话）。
  所以删完：VACUUM 整库重建（只拷活着的行，空闲页和页内空隙都不带过去），再 wal_checkpoint(TRUNCATE) 把 WAL 写回并截成 0 字节。
  - 本机服务只有一个 Prisma 连接（lib/sqlite-url 单连接），这一句排在别的查询后面执行，不会落在事务里；
  - 别的进程（备份、只读工具）这会儿开着读事务时 checkpoint 截不了：重试几次，还不行就记「欠擦」（_sync_cursor 里一行），下一轮清理先补擦；
  - 备份文件不动：backups/ 里迁移前 / 每日 / 升级前的备份按设计保留（见操作手册），不在这里删。
*/
const 欠擦键 = 'wipe_pending';
async function 记欠擦(db: Db) {
  await db.$executeRawUnsafe("INSERT INTO _sync_cursor (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = 1", 欠擦键);
}
async function 欠擦(db: Db) {
  return !!Number((await db.$queryRawUnsafe<{ v: bigint | number }[]>("SELECT v FROM _sync_cursor WHERE k = ?", 欠擦键).catch(() => []))[0]?.v ?? 0);
}
/*
  Windows 上不许卡住（2026-10-14，候选 7 Windows CI 复查）：杀毒、备份、索引服务常常拿着库文件句柄，
  VACUUM / wal_checkpoint 撞上别人的锁时按连接的等锁时长（Prisma 默认 5 秒）一次次等，四次重试最坏要二十几秒，
  而桌面端只有一个连接——这期间整个软件的读写都排在后面。所以：
  - 擦净期间等锁最多 擦净等锁毫秒，撞上就报 busy，不长等；擦完把连接原来的等锁时长恢复；
  - 重试总共不超过 擦净预算毫秒；还不行就记「欠擦」（wipe_pending 那一行留着），下一轮清理先补擦，并打一行清楚的日志。
  Mac / Linux 上没人占锁时一次就过，行为不变。
*/
export const 擦净等锁毫秒 = 1_000;
export const 擦净预算毫秒 = 5_000;
export async function 擦净删除残留(db: PrismaClient, 预算毫秒 = 擦净预算毫秒): Promise<boolean> {
  const 起 = Date.now();
  let 原等锁: number | null = null;
  try {
    原等锁 = Number((await db.$queryRawUnsafe<{ timeout: bigint | number }[]>('PRAGMA busy_timeout'))[0]?.timeout ?? NaN);
    await db.$queryRawUnsafe(`PRAGMA busy_timeout = ${擦净等锁毫秒}`);
    await db.$queryRawUnsafe('PRAGMA secure_delete = ON');
    await db.$executeRawUnsafe('VACUUM');
    for (let i = 0; i < 4; i++) {
      // 返回 busy / log / checkpointed：busy = 0 才算 WAL 全部写回并截断
      const r = await db.$queryRawUnsafe<{ busy: bigint | number }[]>('PRAGMA wal_checkpoint(TRUNCATE)');
      if (!Number(r[0]?.busy ?? 0)) {
        await db.$executeRawUnsafe("DELETE FROM _sync_cursor WHERE k = ?", 欠擦键).catch(() => undefined);
        // 删这一行本身又写了 WAL（不含业务数据）；再截一次，WAL 里不留任何页
        await db.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => undefined);
        return true;
      }
      if (Date.now() - 起 + 500 > 预算毫秒) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    console.error(`[sync] 清理后截断 WAL 没成功（别的程序占着库文件，${Date.now() - 起}ms 内没等到）：已记下，下一轮再擦`);
  } catch (e) {
    console.error('[sync] 清理后整库重建失败（多半是库文件被别的程序占着），下一轮再试：', e instanceof Error ? e.message.slice(0, 200) : e);
  } finally {
    if (原等锁 !== null && Number.isFinite(原等锁)) await db.$queryRawUnsafe(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(原等锁))}`).catch(() => undefined);
  }
  await 记欠擦(db).catch(() => undefined);
  return false;
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
  // 删除包只是墓碑：不许夹带整行 / 改动列（服务端会把删除包下发给改归属之后才获权的人，见 给范围拉取）
  if (inner.change.o === 'D' && (inner.change.r != null || (inner.change.c ?? []).length)) throw new 范围包错误('删除包不能带内容');
  const key = 行键(b.meta.t, b.meta.k);
  if (!current || !allowed.has(key)) throw new 范围包错误('该记录不在本机同步范围内');
  const e = 归一化范围行(inner.change, current, allowed);
  if (e.o !== 'D' && e.r) for (const [field, table] of Object.entries(范围父表[e.t] ?? {})) {
    const v = e.r[field];
    if (v != null && !allowed.has(行键(table, String(v)))) throw new 范围包错误(`关联的${table}不在本机同步范围内`);
  }
  return e;
}
