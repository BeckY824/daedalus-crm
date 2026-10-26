/**
 * 从某天的自动备份里只捞回被删掉的客户（2026-10-26，0.46.28）。
 *
 * 回收站（trash.ts）只管装了这一版以后、在老板这台回放的删除。更早删的、或者回收站过了 30 天的，
 * 原来只能整库恢复那天的备份，老板这两天自己录的就没了。现在：打开那份备份（只读），
 * 列出「备份里有、本机现在没有」的客户，按谁删的分组；选几位捞回来，走 trash.ts 的 插回：
 * 只插回本机没有的行，老板自己的数据一行不动；插回的进同步日志，推出去全队都放回来。
 *
 * 取的是这位客户连同挂在下面的（外键 ON DELETE CASCADE 的子孙，按备份自己的外键图），商机、订单下的附件行也带上，
 * 文件本机没有就从附件池（backups/attachments，auto-backup.js 每天硬链接进去的）拷回来（trash.ts 补附件文件）。
 * 被删时置空的引用（推荐人、线索……外键 SET NULL）在备份里还指着他，恢复时那一格还空着就接回去。
 *
 * 不列合并掉的（本机 CustomerMerge 里有：并进了别的客户，不是删）。
 * 只给老板 / 个人版：业务员那台的客户转给别人后本机本来就会删掉，从备份捞回等于把转走的复活。
 *
 * 备份是 VACUUM INTO 出来的 SQLite 文件，用 node:sqlite 打开（桌面端本地服务跑在 Electron 自带的 Node 22 里）。
 * 用 process.getBuiltinModule 取：打包时不去解析它。
 */
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma";
import { 建回收站表, 插回, 补附件文件, 附件挂在 } from "./trash";

type 语句 = { all(...p: unknown[]): Record<string, unknown>[] };
type 只读库 = { prepare(sql: string): 语句; close(): void };
type Sqlite = { DatabaseSync: new (f: string, o: { readOnly: boolean }) => 只读库 };

const 引 = (s: string) => `"${s.replace(/"/g, '""')}"`;
const 数 = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const 备份名 = /^daily-(\d{4}-\d{2}-\d{2})\.db$/;

function 打开(文件: string): 只读库 {
  const m = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
  if (!m) throw new Error("这台电脑上读不了备份文件");
  return new m.DatabaseSync(文件, { readOnly: true });
}

function 备份目录(数据目录 = process.env.CRM_DATA_DIR): string | null {
  return 数据目录 ? path.join(数据目录, "backups") : null;
}

export type 一份备份 = { 文件: string; 日期: string };

/** 每天的自动备份（最近 7 份），新的在前 */
export function 列出每日备份(数据目录 = process.env.CRM_DATA_DIR): 一份备份[] {
  const 目录 = 备份目录(数据目录);
  if (!目录 || !fs.existsSync(目录)) return [];
  return fs.readdirSync(目录).flatMap((f) => { const m = 备份名.exec(f); return m ? [{ 文件: f, 日期: m[1] }] : []; }).sort((a, b) => b.日期.localeCompare(a.日期)).slice(0, 7);
}

/** 文件名只认列出来的那几份，不接路径 */
function 备份文件(文件: string, 数据目录 = process.env.CRM_DATA_DIR): string {
  const 目录 = 备份目录(数据目录);
  if (!目录 || !备份名.test(文件) || !fs.existsSync(path.join(目录, 文件))) throw new Error("找不到这份备份");
  return path.join(目录, 文件);
}

type 外键 = { 子表: string; 列: string; 父表: string; 到: string; 删时: string };

/** 备份自己的外键图（备份可能是老版本的库，表和列以它为准） */
function 备份图(b: 只读库) {
  const 表们 = b.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'").all().map((r) => String(r.name));
  const 键们: 外键[] = [];
  for (const t of 表们) for (const f of b.prepare(`PRAGMA foreign_key_list(${引(t)})`).all()) 键们.push({ 子表: t, 列: String(f.from), 父表: String(f.table), 到: f.to == null ? "" : String(f.to), 删时: String(f.on_delete).toUpperCase() });
  const 信息 = new Map<string, { 列: string[]; 主键: string }>();
  const 表 = (t: string) => {
    if (!信息.has(t)) {
      const cs = b.prepare(`PRAGMA table_info(${引(t)})`).all();
      信息.set(t, { 列: cs.map((c) => String(c.name)), 主键: String(cs.find((c) => 数(c.pk) === 1)?.name ?? "id") });
    }
    return 信息.get(t)!;
  };
  const 有 = new Set(表们);
  return { 有: (t: string) => 有.has(t), 子: (t: string) => 键们.filter((f) => f.父表 === t), 表 };
}

function 整行(b: 只读库, 图: ReturnType<typeof 备份图>, t: string, 列: string, 值: unknown): { pk: string; row: Record<string, unknown> }[] {
  const { 列: cs, 主键 } = 图.表(t);
  return b.prepare(`SELECT CAST(${引(主键)} AS TEXT) AS pk, json_object(${cs.map((c) => `'${c.replace(/'/g, "''")}', ${引(c)}`).join(", ")}) AS row FROM ${引(t)} WHERE ${引(列)} = ?`).all(值)
    .map((r) => ({ pk: String(r.pk), row: JSON.parse(String(r.row)) as Record<string, unknown> }));
}

/** 这几位客户在备份里的整棵树：行们（含客户本身）、被删时会置空的引用 */
function 取树(b: 只读库, ids: string[]) {
  const 图 = 备份图(b);
  const 行们: { tbl: string; row: Record<string, unknown> }[] = [];
  const 引用们: { tbl: string; pk: string; 列: string; 到: unknown }[] = [];
  const 见过 = new Set<string>();
  const 走 = (t: string, x: { pk: string; row: Record<string, unknown> }) => {
    if (见过.has(`${t}:${x.pk}`)) return;
    见过.add(`${t}:${x.pk}`);
    行们.push({ tbl: t, row: x.row });
    for (const f of 图.子(t)) {
      const 到 = x.row[f.到 || 图.表(t).主键];
      if (到 == null || !图.有(f.子表)) continue;
      if (f.删时 === "CASCADE") for (const 子 of 整行(b, 图, f.子表, f.列, 到)) 走(f.子表, 子);
      else if (f.删时 === "SET NULL") for (const 子 of 整行(b, 图, f.子表, f.列, 到)) if (!(f.子表 === t && 子.pk === x.pk)) 引用们.push({ tbl: f.子表, pk: 子.pk, 列: f.列, 到 });
    }
    const 列 = 附件挂在[t];
    if (列 && 图.有("Attachment") && 图.表("Attachment").列.includes(列)) for (const a of 整行(b, 图, "Attachment", 列, x.pk)) 走("Attachment", a);
  };
  if (图.有("Customer")) for (const id of ids) for (const c of 整行(b, 图, "Customer", 图.表("Customer").主键, id)) 走("Customer", c);
  // 树里自己的行之间的引用插回时本来就在行里，不用再接
  return { 行们, 引用们: 引用们.filter((l) => !见过.has(`${l.tbl}:${l.pk}`)) };
}

export type 备份里删了的 = {
  id: string;
  名称: string;
  /** 下面挂了几条（联系人、跟进、商机、签约……，不含客户本身） */
  条数: number;
  /** 删的人（User.id）：本机记着删除那条改动是哪台设备的、对得上人；对不上按客户原来的负责人 */
  删的人: string | null;
  按负责人猜的: boolean;
  /** 删的时间（本机记着删除那条改动的时钟才有） */
  删的时间: string | null;
};

/** 这份备份里有、本机现在没有的客户（合并掉的不算） */
export async function 列出备份里删了的(db: PrismaClient, 文件: string, 数据目录 = process.env.CRM_DATA_DIR): Promise<备份里删了的[]> {
  const b = 打开(备份文件(文件, 数据目录));
  try {
    const 图 = 备份图(b);
    if (!图.有("Customer")) return [];
    const 备份客户 = b.prepare('SELECT id, name, salesOwnerId, channelOwnerId FROM "Customer"').all();
    const 本机 = new Set((await db.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM "Customer"')).map((r) => r.id));
    const 并掉 = new Set((await db.$queryRawUnsafe<{ fromId: string }[]>('SELECT fromId FROM "CustomerMerge"').catch(() => [])).map((r) => r.fromId));
    const 没了 = 备份客户.filter((c) => !本机.has(String(c.id)) && !并掉.has(String(c.id)));
    if (!没了.length) return [];
    await 建回收站表(db);
    const 主人 = new Map((await db.$queryRawUnsafe<{ device: string; accountId: string }[]>("SELECT device, accountId FROM _sync_device_owner")).map((r) => [r.device, `acct_${r.accountId}`]));
    const 墓 = new Map<string, string>();
    const 墓表 = (await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sync_tomb'")).length > 0;
    const ids = 没了.map((c) => String(c.id));
    for (let i = 0; 墓表 && i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      for (const r of await db.$queryRawUnsafe<{ pk: string; hlc: string }[]>(`SELECT pk, hlc FROM _sync_tomb WHERE tbl = 'Customer' AND pk IN (${part.map(() => "?").join(",")})`, ...part)) 墓.set(r.pk, r.hlc);
    }
    return 没了.map((c) => {
      const id = String(c.id);
      const h = 墓.get(id);
      const 设备人 = h ? 主人.get(h.split("-").pop() ?? "") ?? null : null;
      const 负责人 = (c.salesOwnerId ?? c.channelOwnerId ?? null) as string | null;
      const 毫秒 = h ? Number(h.split("-")[0]) : NaN;
      return {
        id, 名称: String(c.name ?? "") || "（没名字的客户）", 条数: 取树(b, [id]).行们.length - 1,
        删的人: 设备人 ?? 负责人, 按负责人猜的: !设备人 && !!负责人, 删的时间: Number.isFinite(毫秒) && 毫秒 > 0 ? new Date(毫秒).toISOString() : null,
      };
    });
  } finally {
    b.close();
  }
}

/** 从这份备份捞回这几位（只插回本机没有的行）；附件文件本机没有的从附件池拷回来 */
export async function 从备份捞回(db: PrismaClient, 文件: string, ids: string[], 数据目录 = process.env.CRM_DATA_DIR): Promise<{ 插回: number; 跳过: number; 客户们: string[]; 附件补了: number }> {
  const 要 = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (!要.length) return { 插回: 0, 跳过: 0, 客户们: [], 附件补了: 0 };
  const b = 打开(备份文件(文件, 数据目录));
  let 树: ReturnType<typeof 取树>;
  try { 树 = 取树(b, 要); } finally { b.close(); }
  // 合并掉的不捞（列表里本来就不出现；这里再挡一次，防止页面开着的时候刚合并）
  const 并掉 = new Set((await db.$queryRawUnsafe<{ fromId: string }[]>('SELECT fromId FROM "CustomerMerge"').catch(() => [])).map((r) => r.fromId));
  const 行们 = 树.行们.filter((r) => !(r.tbl === "Customer" && 并掉.has(String(r.row.id))) && !(typeof r.row.customerId === "string" && 并掉.has(r.row.customerId)));
  const r = await db.$transaction((tx) => 插回(tx, 行们, 树.引用们), { timeout: 60_000 });
  const 附件们 = 行们.filter((x) => x.tbl === "Attachment").map((x) => String(x.row.id));
  return { ...r, 附件补了: 补附件文件(附件们, 数据目录) };
}
