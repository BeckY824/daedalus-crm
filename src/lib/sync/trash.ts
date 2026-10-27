/**
 * 同步删掉的客户：老板那台自动留底（2026-10-26，0.46.28）。
 *
 * 业务员删了客户（离职前、或者恶意删），同步过来老板这台也跟着删了，原来找不回来；从备份整库恢复又会把老板这两天自己录的冲掉。
 * 现在老板那台回放别人的删除时，删之前把这一行连同挂在它下面的（联系人、跟进、商机、签约、订单……外键 ON DELETE CASCADE 的子孙）
 * 原样存一份在 _sync_trash，留 30 天。设置 → 团队里按「谁删的」列出来，能一位一位恢复，也能把某个人删的一次全恢复。
 *
 * 恢复 = 本机按原来的 id 插回去，不在「回放中」：触发器照常记日志、编新的时钟（比当初那条删除晚），推出去全队都放回来，
 * 当初删的那台也一样。只插回本机现在没有的行，老板自己的数据一行不动。
 *
 * 只在老板那台存（回放 的 留底 选项，client.ts 按 能管理团队 传）：别人客户的内容不往业务员那台留。
 * 只存挂在客户下面的（找得到是哪位客户）；渠道、成员、设置这些不存。
 * 被删时置空的引用（别的客户的推荐人指着他、线索挂着他……外键 SET NULL）也记下来，恢复时那一格还空着就接回去。
 *
 * 商机、订单下的附件（没有外键，按 opportunityId / orderId 挂着）也一起存，文件硬链接进 attachments-trash/：
 * 父行没了的附件满 1 天连文件清掉（attachments.ts 清孤儿），过了那一天再恢复，文件从这里拷回来。
 *
 * 从某天的自动备份里只捞回被删掉的客户（恢复整库会冲掉这两天的）也走这里的 插回，见 trash-backup.ts。
 */
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient, Prisma } from "@/generated/prisma";
import { 附件目录 } from "@/lib/attachments";
import { 是附件编号 } from "@/lib/attachment-rules";

type Db = PrismaClient | Prisma.TransactionClient;

const 留几天 = 30;
const 天 = 86_400_000;
const 数 = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const 引 = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function 建回收站表(db: Db) {
  /*
    row：整行（json_object 原样，日期是库里的毫秒数、开关是 0/1）；link 不空时这一条是「被置空的引用」，row 是 {"to": 原来指的值}。
    root：是哪位客户的；device：谁删的（删除那条改动时钟的设备后缀，清孤儿带走的没有）
  */
  await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _sync_trash (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, row TEXT NOT NULL, link TEXT, root TEXT NOT NULL, device TEXT, hlc TEXT, at BIGINT NOT NULL, restoredAt BIGINT)");
  await db.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS _sync_trash_root ON _sync_trash (root)");
  // 删的设备是谁（云端只列在册的设备，人被移出团队后就查不到了）：老板那台同步时顺手记下（client.ts 记设备主人）
  await db.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS _sync_device_owner (device TEXT PRIMARY KEY, accountId TEXT NOT NULL, at BIGINT NOT NULL)");
}

type 外键 = { 子表: string; 列: string; 父表: string; 到: string; 删时: string };

/** 附件没有外键（文件另放）：挂在商机 / 订单下，按这两列认 */
export const 附件挂在: Record<string, string> = { Opportunity: "opportunityId", TradeOrder: "orderId" };

/** 回收站里附件的文件：数据目录下 attachments-trash/<编号>（硬链接，同一个盘上不多占地方） */
function 回收站附件目录(): string | null {
  return process.env.CRM_DATA_DIR ? path.join(process.env.CRM_DATA_DIR, "attachments-trash") : null;
}
function 留附件文件(id: string) {
  const 目录 = 回收站附件目录();
  if (!目录 || !是附件编号(id)) return;
  const 从 = path.join(附件目录(), id), 到 = path.join(目录, id);
  try {
    if (fs.existsSync(到) || !fs.existsSync(从)) return;
    fs.mkdirSync(目录, { recursive: true });
    try { fs.linkSync(从, 到); } catch { fs.copyFileSync(从, 到); }
  } catch { /* 存不下文件：附件行照样留，恢复后显示「文件不在这台」 */ }
}

/** 附件行插回了、本机没有文件的：先找回收站里的，再找自动备份的附件池（backups/attachments）。返回补了几个 */
export function 补附件文件(ids: string[], 数据目录 = process.env.CRM_DATA_DIR): number {
  if (!数据目录) return 0;
  const 本机 = 附件目录();
  const 源们 = [path.join(数据目录, "attachments-trash"), path.join(数据目录, "backups", "attachments")];
  let n = 0;
  for (const id of ids) {
    if (!是附件编号(id) || fs.existsSync(path.join(本机, id))) continue;
    const 从 = 源们.map((d) => path.join(d, id)).find((f) => fs.existsSync(f));
    if (!从) continue;
    try {
      fs.mkdirSync(本机, { recursive: true });
      try { fs.linkSync(从, path.join(本机, id)); } catch { fs.copyFileSync(从, path.join(本机, id)); }
      n++;
    } catch { /* 拷不过来：附件行在，界面上显示「文件不在这台」 */ }
  }
  return n;
}

/** 本机的外键图（一次回放 / 一次恢复里算一回） */
export function 外键图(db: Db) {
  let 图: Promise<外键[]> | null = null;
  const 全部 = () => (图 ??= (async () => {
    const 表们 = (await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'")).map((r) => r.name);
    const out: 外键[] = [];
    for (const t of 表们) {
      for (const f of await db.$queryRawUnsafe<{ table: string; from: string; to: string | null; on_delete: string }[]>(`PRAGMA foreign_key_list(${引(t)})`)) {
        out.push({ 子表: t, 列: f.from, 父表: f.table, 到: f.to ?? "", 删时: String(f.on_delete).toUpperCase() });
      }
    }
    return out;
  })());
  const 主键们 = new Map<string, string>();
  const 主键 = async (t: string) => {
    if (!主键们.has(t)) {
      const 列 = await db.$queryRawUnsafe<{ name: string; pk: bigint | number }[]>(`PRAGMA table_info(${引(t)})`);
      主键们.set(t, 列.find((c) => 数(c.pk) === 1)?.name ?? "id");
    }
    return 主键们.get(t)!;
  };
  const 列们 = new Map<string, string[]>();
  const 列 = async (t: string) => 列们.get(t) ?? (列们.set(t, (await db.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${引(t)})`)).map((c) => c.name)), 列们.get(t)!);
  return {
    子: async (t: string) => (await 全部()).filter((f) => f.父表 === t),
    父: async (t: string) => (await 全部()).filter((f) => f.子表 === t && f.父表 !== t),
    主键,
    列,
    /** 表的深度：父表都排在前面（恢复时先插父后插子：分批推出去时同事那边不会先收到子行变孤儿） */
    深度: async (t: string) => {
      const 记 = new Map<string, number>();
      const 算 = async (x: string, 路: Set<string>): Promise<number> => {
        if (记.has(x)) return 记.get(x)!;
        if (路.has(x)) return 0;
        路.add(x);
        let d = 0;
        for (const f of (await 全部()).filter((f) => f.子表 === x && f.父表 !== x)) d = Math.max(d, 1 + (await 算(f.父表, 路)));
        路.delete(x);
        记.set(x, d);
        return d;
      };
      return 算(t, new Set());
    },
  };
}

type 图 = ReturnType<typeof 外键图>;

async function 整行(db: Db, 图: 图, t: string, 条件: string, ...参: unknown[]): Promise<{ pk: string; row: string }[]> {
  const pk = await 图.主键(t);
  const cs = await 图.列(t);
  return db.$queryRawUnsafe<{ pk: string; row: string }[]>(`SELECT CAST(${引(pk)} AS TEXT) AS pk, json_object(${cs.map((c) => `'${c.replace(/'/g, "''")}', ${引(c)}`).join(", ")}) AS row FROM ${引(t)} WHERE ${条件}`, ...参);
}

/**
 * 这一行是哪位客户的：客户自己 → 行里的 customerId → 顺外键往上找父行（本机还在的、或者回收站里已经存了的）。找不到 = 不是客户下面的，不存
 */
async function 根客户(db: Db, 图: 图, t: string, 行: Record<string, unknown>, 层 = 0): Promise<string | null> {
  if (t === "Customer") return typeof 行.id === "string" ? 行.id : null;
  if (typeof 行.customerId === "string" && 行.customerId) return 行.customerId;
  if (层 > 6) return null;
  const 虚 = t === "Attachment" ? Object.entries(附件挂在).map(([父表, 列]) => ({ 子表: t, 列, 父表, 到: "", 删时: "" })) : [];
  for (const f of [...(await 图.父(t)), ...虚]) {
    const v = 行[f.列];
    if (v == null) continue;
    if (f.父表 === "Customer") return String(v);
    const 到 = f.到 || (await 图.主键(f.父表));
    const 父 = (await 整行(db, 图, f.父表, `${引(到)} = ?`, v))[0];
    if (父) { const r = await 根客户(db, 图, f.父表, JSON.parse(父.row), 层 + 1); if (r) return r; continue; }
    const 存过 = (await db.$queryRawUnsafe<{ root: string }[]>("SELECT root FROM _sync_trash WHERE tbl = ? AND pk = ? AND link IS NULL ORDER BY id DESC LIMIT 1", f.父表, String(v)))[0];
    if (存过) return 存过.root;
  }
  return null;
}

/**
 * 回放里删一行之前调（local.ts 回放 的 D 分支、清孤儿）：存这一行和挂在下面的子孙；
 * 已存 = 这一次回放里存过的（tbl:pk），父行删的时候连子孙一起存了，子行自己的删除再来就不重复存
 */
export function 留底器(tx: Prisma.TransactionClient) {
  const 图 = 外键图(tx);
  const 已存 = new Set<string>();
  let 建了 = false;
  let 存了 = 0;
  const 现在 = Date.now();
  /*
    回放前先看一眼：这一批要删的行，现在谁指着它（SET NULL 的外键）。
    同事那台删客户时，推荐人指着他的那几位是先置空、后删除，置空那一笔在批里排在删除前面，等回放到删除时本机已经空了，就记不下来
  */
  const 预引用 = new Map<string, { 子表: string; pk: string; 列: string; 到: unknown }[]>();
  const 已链 = new Set<string>();
  async function 记引用(子表: string, pk: string, 列: string, 到: unknown, root: string, device: string | null, hlc: string | null) {
    const 键 = `${子表}:${pk}:${列}`;
    if (已链.has(键)) return;
    已链.add(键);
    await tx.$executeRawUnsafe("INSERT INTO _sync_trash (tbl, pk, row, link, root, device, hlc, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", 子表, pk, JSON.stringify({ to: 到 }), 列, root, device, hlc, 现在);
  }
  async function 存树(t: string, 行: { pk: string; row: string }, root: string, device: string | null, hlc: string | null) {
    const 键 = `${t}:${行.pk}`;
    if (已存.has(键)) return;
    已存.add(键);
    await tx.$executeRawUnsafe("INSERT INTO _sync_trash (tbl, pk, row, root, device, hlc, at) VALUES (?, ?, ?, ?, ?, ?, ?)", t, 行.pk, 行.row, root, device, hlc, 现在);
    存了++;
    const 值 = JSON.parse(行.row) as Record<string, unknown>;
    for (const f of await 图.子(t)) {
      const 到 = 值[f.到 || (await 图.主键(t))];
      if (到 == null) continue;
      if (f.删时 === "CASCADE") {
        for (const 子 of await 整行(tx, 图, f.子表, `${引(f.列)} = ?`, 到)) await 存树(f.子表, 子, root, device, hlc);
      } else if (f.删时 === "SET NULL") {
        const 子pk = await 图.主键(f.子表);
        for (const r of await tx.$queryRawUnsafe<{ pk: string }[]>(`SELECT CAST(${引(子pk)} AS TEXT) AS pk FROM ${引(f.子表)} WHERE ${引(f.列)} = ?`, 到)) {
          if (f.子表 === t && r.pk === 行.pk) continue;
          await 记引用(f.子表, r.pk, f.列, 到, root, device, hlc);
        }
      }
    }
    for (const x of 预引用.get(键) ?? []) if (!(x.子表 === t && x.pk === 行.pk)) await 记引用(x.子表, x.pk, x.列, x.到, root, device, hlc);
    const 挂列 = 附件挂在[t];
    if (挂列 && (await 图.列("Attachment")).includes(挂列)) for (const a of await 整行(tx, 图, "Attachment", `${引(挂列)} = ?`, 行.pk)) await 存树("Attachment", a, root, device, hlc);
    if (t === "Attachment") 留附件文件(行.pk);
  }
  async function 准备() {
    if (建了) return;
    建了 = true;
    await 建回收站表(tx);
    await tx.$executeRawUnsafe("DELETE FROM _sync_trash WHERE at < ?", 现在 - 留几天 * 天);
  }
  return {
    /** 回放开始前：这一批里的删除，先记下现在指着它们的 SET NULL 引用 */
    async 先看(批: { o: string; t: string; k: string }[]) {
      for (const e of 批) {
        if (e.o !== "D") continue;
        const sn = (await 图.子(e.t)).filter((f) => f.删时 === "SET NULL");
        if (!sn.length) continue;
        const pk = await 图.主键(e.t);
        const 行 = (await 整行(tx, 图, e.t, `${引(pk)} = ?`, e.k))[0];
        if (!行) continue;
        const 值 = JSON.parse(行.row) as Record<string, unknown>;
        const 列表: { 子表: string; pk: string; 列: string; 到: unknown }[] = [];
        for (const f of sn) {
          const 到 = 值[f.到 || pk];
          if (到 == null) continue;
          const 子pk = await 图.主键(f.子表);
          for (const r of await tx.$queryRawUnsafe<{ pk: string }[]>(`SELECT CAST(${引(子pk)} AS TEXT) AS pk FROM ${引(f.子表)} WHERE ${引(f.列)} = ?`, 到)) 列表.push({ 子表: f.子表, pk: r.pk, 列: f.列, 到 });
        }
        if (列表.length) 预引用.set(`${e.t}:${行.pk}`, 列表);
      }
    },
    /** 回放一条远端删除之前：t / k 这一行，h 是删除那条改动的时钟（设备是它的后缀） */
    async 删之前(t: string, k: string, h: string) {
      if (已存.has(`${t}:${k}`)) return;
      await 准备();
      const pk = await 图.主键(t);
      const 行 = (await 整行(tx, 图, t, `${引(pk)} = ?`, k))[0];
      if (!行) return;
      const root = await 根客户(tx, 图, t, JSON.parse(行.row));
      if (!root) return;
      await 存树(t, 行, root, h.split("-").pop() || null, h);
    },
    /** 清孤儿要整行删掉之前（父行在本机已经删了：同事删客户的同时别人给他记了跟进，或者老板自己记的） */
    async 孤儿删之前(t: string, rowid: number) {
      await 准备();
      const 行 = (await 整行(tx, 图, t, "rowid = ?", rowid))[0];
      if (!行) return;
      const root = await 根客户(tx, 图, t, JSON.parse(行.row));
      if (root) await 存树(t, 行, root, null, null);
    },
    get 存了() { return 存了; },
  };
}

export type 回收站条目 = {
  root: string;
  名称: string;
  /** 客户本身也删了（不然是这位客户下面的几条：跟进、联系人……） */
  客户也删了: boolean;
  条数: number;
  删的时间: string;
  /** 删的人（User.id）：设备对得上人就是那个人；对不上按客户原来的负责人 */
  删的人: string | null;
  按负责人猜的: boolean;
  /** 本机现在又有这位客户了（恢复过、或者别人又建了同 id 的）：只插回还没有的那几行 */
  客户还在: boolean;
};

/** 设置 → 团队「同步删掉的」：没恢复的，按客户合在一起，最近删的在前 */
export async function 列出回收站(db: Db): Promise<回收站条目[]> {
  await 建回收站表(db);
  await db.$executeRawUnsafe("DELETE FROM _sync_trash WHERE at < ?", Date.now() - 留几天 * 天);
  await 清回收站附件(db);
  const rows = await db.$queryRawUnsafe<{ root: string; n: bigint; at: bigint; device: string | null; cust: string | null }[]>(
    `SELECT root, COUNT(*) AS n, MAX(at) AS at,
       (SELECT device FROM _sync_trash d WHERE d.root = t.root AND d.restoredAt IS NULL AND d.device IS NOT NULL ORDER BY d.id DESC LIMIT 1) AS device,
       (SELECT row FROM _sync_trash c WHERE c.root = t.root AND c.restoredAt IS NULL AND c.tbl = 'Customer' AND c.link IS NULL ORDER BY c.id DESC LIMIT 1) AS cust
     FROM _sync_trash t WHERE restoredAt IS NULL AND link IS NULL GROUP BY root ORDER BY MAX(id) DESC LIMIT 500`,
  );
  const 主人 = new Map((await db.$queryRawUnsafe<{ device: string; accountId: string }[]>("SELECT device, accountId FROM _sync_device_owner")).map((r) => [r.device, `acct_${r.accountId}`]));
  const out: 回收站条目[] = [];
  for (const r of rows) {
    const 客户行 = r.cust ? (JSON.parse(r.cust) as Record<string, unknown>) : null;
    const 本机 = (await db.$queryRawUnsafe<{ name: string; salesOwnerId: string | null; channelOwnerId: string | null }[]>('SELECT name, salesOwnerId, channelOwnerId FROM "Customer" WHERE id = ?', r.root))[0];
    const 名 = String(客户行?.name ?? 本机?.name ?? "");
    const 设备人 = r.device ? 主人.get(r.device) ?? null : null;
    const 负责人 = (客户行?.salesOwnerId ?? 客户行?.channelOwnerId ?? 本机?.salesOwnerId ?? 本机?.channelOwnerId ?? null) as string | null;
    out.push({
      root: r.root, 名称: 名 || "（没名字的客户）", 客户也删了: !!客户行, 条数: 数(r.n), 删的时间: new Date(数(r.at)).toISOString(),
      删的人: 设备人 ?? 负责人, 按负责人猜的: !设备人 && !!负责人, 客户还在: !!本机,
    });
  }
  return out;
}

/**
 * 插回一批整行（回收站恢复、从备份捞回都走这里）。在一个事务里：
 *   - 不在「回放中」：触发器记日志、编新时钟，推出去全队放回来
 *   - 先父后子（外键图的深度），本机已有这个 id 的跳过（老板自己的不动），本机没有的列不写
 *   - 外键延后检查，插完找坏的：能空的置空，不能空的（父行找不回来）不插
 * 返回插回了几行、跳过了几行
 */
export async function 插回(tx: Prisma.TransactionClient, 行们: { tbl: string; row: Record<string, unknown> }[], 引用们: { tbl: string; pk: string; 列: string; 到: unknown }[] = []): Promise<{ 插回: number; 跳过: number; 客户们: string[] }> {
  const 图 = 外键图(tx);
  await tx.$executeRawUnsafe("UPDATE _sync_state SET applying = 0 WHERE id = 1").catch(() => undefined);
  await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
  const 表们 = new Set((await tx.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const 深 = new Map<string, number>();
  for (const t of new Set(行们.map((r) => r.tbl))) if (表们.has(t)) 深.set(t, await 图.深度(t));
  const 排好 = 行们.filter((r) => 表们.has(r.tbl)).sort((a, b) => 深.get(a.tbl)! - 深.get(b.tbl)!);
  let 插 = 0;
  let 跳 = 行们.length - 排好.length;
  const 插了的: { tbl: string; row: Record<string, unknown> }[] = [];
  for (const { tbl, row } of 排好) {
    const pk = await 图.主键(tbl);
    const 有列 = new Set(await 图.列(tbl));
    if ((await tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${引(tbl)} WHERE ${引(pk)} = ?`, row[pk])).length) { 跳++; continue; }
    const cs = Object.keys(row).filter((c) => 有列.has(c));
    await tx.$executeRawUnsafe("SAVEPOINT s_back");
    try {
      await tx.$executeRawUnsafe(`INSERT INTO ${引(tbl)} (${cs.map(引).join(", ")}) VALUES (${cs.map(() => "?").join(", ")})`, ...cs.map((c) => row[c]));
      await tx.$executeRawUnsafe("RELEASE s_back");
      插++;
      插了的.push({ tbl, row });
    } catch {
      // 撞了唯一约束（老板这两天又建了同名的渠道、同一位客户又有了线索……）：这一行不插
      await tx.$executeRawUnsafe("ROLLBACK TO s_back");
      await tx.$executeRawUnsafe("RELEASE s_back");
      跳++;
    }
  }
  for (const l of 引用们) {
    if (!表们.has(l.tbl) || !(await 图.列(l.tbl)).includes(l.列)) continue;
    await tx.$executeRawUnsafe(`UPDATE ${引(l.tbl)} SET ${引(l.列)} = ? WHERE ${引(await 图.主键(l.tbl))} = ? AND ${引(l.列)} IS NULL`, l.到, l.pk).catch(() => undefined);
  }
  // 父行找不回来的（恢复之前别人又把父行删了、备份里没有）：能空置空，不能空的这一行不要
  for (let 轮 = 0; 轮 < 10; 轮++) {
    const 坏 = await tx.$queryRawUnsafe<{ table: string; rowid: bigint | number | null; fkid: bigint | number }[]>("PRAGMA foreign_key_check");
    if (!坏.length) break;
    for (const b of 坏) {
      if (b.rowid == null) continue;
      const fk = (await tx.$queryRawUnsafe<{ id: bigint | number; from: string; on_delete: string }[]>(`PRAGMA foreign_key_list(${引(b.table)})`)).find((f) => 数(f.id) === 数(b.fkid));
      const 列信息 = await tx.$queryRawUnsafe<{ name: string; notnull: bigint | number }[]>(`PRAGMA table_info(${引(b.table)})`);
      const 能空 = fk && 数(列信息.find((c) => c.name === fk.from)?.notnull ?? 1) === 0 && String(fk.on_delete).toUpperCase() !== "CASCADE";
      if (fk && 能空) await tx.$executeRawUnsafe(`UPDATE ${引(b.table)} SET ${引(fk.from)} = NULL WHERE rowid = ?`, 数(b.rowid));
      else { await tx.$executeRawUnsafe(`DELETE FROM ${引(b.table)} WHERE rowid = ?`, 数(b.rowid)); 插--; 跳++; }
    }
  }
  /*
    删客户时联系人不跟着删、搬进了「未归属」（customers/actions.ts deleteCustomers）：联系人放回原来那位了，未归属里那份同名同号的去掉，
    不然同一个人两处都有。只认原来是这位的、名字电话都一样的
  */
  for (const { tbl, row } of 插了的) {
    if (tbl !== "Contact" || typeof row.customerId !== "string" || !表们.has("UnassignedContact")) continue;
    if (!(await tx.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "Contact" WHERE id = ?', row.id)).length) continue;
    await tx.$executeRawUnsafe('DELETE FROM "UnassignedContact" WHERE fromCustomerId = ? AND name = ? AND COALESCE(phone, \'\') = COALESCE(?, \'\')', row.customerId, row.name, row.phone ?? null);
  }
  const 客户们 = [...new Set(行们.flatMap((r) => (r.tbl === "Customer" ? [String(r.row.id)] : typeof r.row.customerId === "string" ? [r.row.customerId] : [])))];
  // 最近跟进是本机算的（不同步）：按插回来的跟进重算
  for (const id of 客户们) await tx.$executeRawUnsafe('UPDATE "Customer" SET lastFollowAt = (SELECT MAX(occurredAt) FROM "FollowUp" WHERE customerId = ?) WHERE id = ?', id, id);
  return { 插回: Math.max(0, 插), 跳过: 跳, 客户们 };
}

/** 回收站里不再记着的附件文件删掉（过了 30 天的） */
async function 清回收站附件(db: Db) {
  const 目录 = 回收站附件目录();
  if (!目录 || !fs.existsSync(目录)) return;
  const 记着 = new Set((await db.$queryRawUnsafe<{ pk: string }[]>("SELECT DISTINCT pk FROM _sync_trash WHERE tbl = 'Attachment' AND link IS NULL")).map((r) => r.pk));
  for (const f of fs.readdirSync(目录)) if (是附件编号(f) && !记着.has(f)) fs.rmSync(path.join(目录, f), { force: true });
}

/** 恢复这几位客户在回收站里的（没恢复过的全部行） */
export async function 恢复回收站(db: PrismaClient, roots: string[]): Promise<{ 插回: number; 跳过: number; 客户们: string[] }> {
  await 建回收站表(db);
  const 要 = [...new Set(roots.filter((r) => typeof r === "string" && r))];
  if (!要.length) return { 插回: 0, 跳过: 0, 客户们: [] };
  let 附件们: string[] = [];
  const 结果 = await db.$transaction(async (tx) => {
    const rows: { id: bigint; tbl: string; pk: string; row: string; link: string | null }[] = [];
    for (let i = 0; i < 要.length; i += 200) {
      const part = 要.slice(i, i + 200);
      rows.push(...(await tx.$queryRawUnsafe<typeof rows>(`SELECT id, tbl, pk, row, link FROM _sync_trash WHERE restoredAt IS NULL AND root IN (${part.map(() => "?").join(",")}) ORDER BY id`, ...part)));
    }
    // 同一行存过几次（删了、恢复、又删）只要最后一次
    const 整 = new Map<string, Record<string, unknown>>();
    const 引用 = new Map<string, { tbl: string; pk: string; 列: string; 到: unknown }>();
    for (const r of rows) {
      if (r.link) 引用.set(`${r.tbl}:${r.pk}:${r.link}`, { tbl: r.tbl, pk: r.pk, 列: r.link, 到: (JSON.parse(r.row) as { to: unknown }).to });
      else 整.set(`${r.tbl}:${r.pk}`, JSON.parse(r.row));
    }
    const 结果 = await 插回(tx, [...整].map(([键, row]) => ({ tbl: 键.slice(0, 键.indexOf(":")), row })), [...引用.values()]);
    附件们 = [...整.keys()].filter((k) => k.startsWith("Attachment:")).map((k) => k.slice("Attachment:".length));
    const 现在 = Date.now();
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      await tx.$executeRawUnsafe(`UPDATE _sync_trash SET restoredAt = ? WHERE id IN (${part.map(() => "?").join(",")})`, 现在, ...part.map((r) => 数(r.id)));
    }
    return 结果;
  }, { timeout: 180_000, maxWait: 20_000 });
  补附件文件(附件们);
  return 结果;
}

/** 老板那台同步时记下设备是谁的（云端 /api/sync/devices 只列在册的；人移出团队以后还要认得出是他删的） */
export async function 记设备主人(db: Db, devices: { device: string; accountId: string }[]) {
  await 建回收站表(db);
  for (const d of devices) {
    if (typeof d?.device !== "string" || typeof d?.accountId !== "string") continue;
    await db.$executeRawUnsafe("INSERT INTO _sync_device_owner (device, accountId, at) VALUES (?, ?, ?) ON CONFLICT(device) DO UPDATE SET accountId = excluded.accountId, at = excluded.at", d.device, d.accountId, Date.now());
  }
}

/** 回收站里有没对上人的设备（要不要去云端问一次） */
export async function 有不认识的设备(db: Db): Promise<boolean> {
  await 建回收站表(db);
  return (await db.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_trash WHERE restoredAt IS NULL AND device IS NOT NULL AND device NOT IN (SELECT device FROM _sync_device_owner) LIMIT 1")).length > 0;
}
