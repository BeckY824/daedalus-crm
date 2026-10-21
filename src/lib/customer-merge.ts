/**
 * 合并重复客户（2026-10-20，团队版疑似重复批量核对，用户定的是「合并成一份」，不是直接删）。
 *
 * 一对：留下的那位（留）+ 被合并的那位（并）。
 *   - 并 名下的跟进、商机、签约、订单、联系人、待办、计划挪到 留；线索（一位一条）留 没有才挪，有就解开
 *   - 推荐人 / 业绩归属指向 并 的客户改指 留（留 自己指过去的置空）
 *   - 留 空着的字段用 并 补上（已经有值的不覆盖）；外贸档案同样
 *   - 负责人保留 留 的；并 原来的负责人记在操作日志和合并记号里
 *   - 写一条合并记号（CustomerMerge，编号 = 并），再删 并。记号同步给全队：中转照它拒掉离线那台推回来的旧改动，
 *     各台回放时引用 并 的改挂到 留（lib/sync/local.ts 回放、lib/sync/scope-policy.ts 合并掉了）
 *
 * 每一步都走普通写（触发器照记），同步出去和人手改的一样：先挪子记录、补字段、写记号，最后删客户——
 * 中转按这个顺序核（删了之后再挂上去的会被拒）。
 *
 * 撤销（一次）：合并时把 并 的整行、一位一行的旁表、挪了哪些、补了哪些记下来（撤销料，存在本机），
 * 撤销 = 删记号、按原编号把 并 建回来、挪回去、补上的清回空。合并之后又改过的不动（挪回只挪还挂在 留 上的那几条）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma";
import { prisma } from "./prisma";
import { 看全部 } from "./team-scope";

type Tx = Prisma.TransactionClient;
type 行 = Record<string, unknown>;

/** 挪过去的子记录：表、主键列、哪几条 */
const 子表: [表: string, 主键: string][] = [
  ["Contact", "id"], ["Opportunity", "id"], ["Contract", "id"], ["TradeOrder", "id"],
  ["FollowUp", "id"], ["Task", "id"], ["FollowPlan", "id"],
];
/** 留 空着时用 并 补上的列。推荐关系五列是一组：留 一样都没有才整组补（拆开补会对不上推荐链） */
const 补的列 = ["phone", "school", "grade", "major", "remark"];
const 推荐组 = ["channelId", "referrerCustomerId", "attributionChannelId", "attributionCustomerId", "channelOwnerId"];
const 档案列 = ["country", "whatsapp", "wechat", "email", "source", "level", "website"];
const 一位一行 = ["CustomerPool", "CustomerClaim", "CustomerExtra"];

const 引 = (s: string) => `"${s.replace(/"/g, '""')}"`;
const 空 = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

export type 撤销料 = {
  留: string; 并: string; 留名: string; 并名: string;
  /** 并 的整行（json_object 读的：时间是毫秒数，和触发器同一种编码） */
  客户: 行;
  旁表: Record<string, 行>;
  挪了: Record<string, string[]>;
  /** 推荐人 / 业绩归属改指 留 的客户：列 → 编号；留 自己那一格置空的记在 置空 */
  改指: Record<string, string[]>;
  置空: string[];
  取消关键: string[];
  补了: Record<string, unknown>;
  档案补了: Record<string, unknown>;
  新建档案: boolean;
  线索: { id: string; 挪: boolean } | null;
};

async function 列名(tx: Tx, t: string): Promise<string[]> {
  return (await tx.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${引(t)})`)).map((c) => c.name);
}
/** 整行读出来（json_object：毫秒数、0/1 原样，不经 Prisma 的 Date / BigInt） */
async function 整行(tx: Tx, t: string, 键: string, 值: string): Promise<行 | null> {
  const cs = await 列名(tx, t);
  const r = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT json_object(${cs.map((c) => `'${c}', ${引(c)}`).join(", ")}) AS v FROM ${引(t)} WHERE ${引(键)} = ?`, 值);
  return r[0] ? (JSON.parse(r[0].v) as 行) : null;
}
async function 插回(tx: Tx, t: string, r: 行) {
  const 有 = new Set(await 列名(tx, t));
  const cs = Object.keys(r).filter((c) => 有.has(c));
  await tx.$executeRawUnsafe(`INSERT INTO ${引(t)} (${cs.map(引).join(", ")}) VALUES (${cs.map(() => "?").join(", ")})`, ...cs.map((c) => r[c] ?? null));
}
const 编号们 = async (tx: Tx, sql: string, ...p: unknown[]) => (await tx.$queryRawUnsafe<{ id: string }[]>(sql, ...p)).map((r) => String(r.id));

/** 合并一对（调用方开事务、核权限）。返回撤销料 */
export async function 合并一对(tx: Tx, 留id: string, 并id: string, 我: { id: string }): Promise<撤销料> {
  if (!留id || !并id || 留id === 并id) throw new 合并问题("两份是同一位，不用合并");
  const 留 = await 整行(tx, "Customer", "id", 留id);
  const 并 = await 整行(tx, "Customer", "id", 并id);
  if (!留 || !并) throw new 合并问题("有一份已经不在了（可能刚在别的电脑上删了或合并了），刷新看看");
  const 并负责人 = (await tx.$queryRawUnsafe<{ name: string }[]>('SELECT name FROM "User" WHERE id = ?', 并.salesOwnerId))[0]?.name ?? null;

  const 料: 撤销料 = {
    留: 留id, 并: 并id, 留名: String(留.name), 并名: String(并.name), 客户: 并, 旁表: {},
    挪了: {}, 改指: {}, 置空: [], 取消关键: [], 补了: {}, 档案补了: {}, 新建档案: false, 线索: null,
  };
  for (const t of 一位一行) {
    const r = await 整行(tx, t, "customerId", 并id);
    if (r) 料.旁表[t] = r;
  }

  // 1. 子记录挪过去。关键联系人：留 已经有了，挪过来的就不再是关键联系人（一位只该有一个）
  const 留有关键 = (await 编号们(tx, 'SELECT id FROM "Contact" WHERE "customerId" = ? AND "isPrimary" = 1', 留id)).length > 0;
  if (留有关键) {
    料.取消关键 = await 编号们(tx, 'SELECT id FROM "Contact" WHERE "customerId" = ? AND "isPrimary" = 1', 并id);
    if (料.取消关键.length) await tx.contact.updateMany({ where: { id: { in: 料.取消关键 } }, data: { isPrimary: false } });
  }
  for (const [t] of 子表) {
    const ids = await 编号们(tx, `SELECT id FROM ${引(t)} WHERE "customerId" = ?`, 并id);
    if (!ids.length) continue;
    料.挪了[t] = ids;
    // 走 Prisma：updatedAt 跟着变，触发器记一条改了 customerId 的改动
    await (tx as unknown as Record<string, { updateMany: (a: unknown) => Promise<unknown> }>)[t[0].toLowerCase() + t.slice(1)].updateMany({ where: { id: { in: ids } }, data: { customerId: 留id } });
  }
  // 线索一位一条（customerId 唯一）：留 没有才挪，有就把 并 的那条解开（线索还在线索页）
  const 线索 = (await 编号们(tx, 'SELECT id FROM "Lead" WHERE "customerId" = ?', 并id))[0];
  if (线索) {
    const 挪 = !(await 编号们(tx, 'SELECT id FROM "Lead" WHERE "customerId" = ?', 留id)).length;
    await tx.lead.update({ where: { id: 线索 }, data: { customerId: 挪 ? 留id : null } });
    料.线索 = { id: 线索, 挪 };
  }

  // 2. 推荐人 / 业绩归属指向 并 的：改指 留；留 自己指过去的置空
  for (const c of ["referrerCustomerId", "attributionCustomerId"] as const) {
    const ids = await 编号们(tx, `SELECT id FROM "Customer" WHERE ${引(c)} = ? AND id <> ?`, 并id, 留id);
    if (ids.length) { 料.改指[c] = ids; await tx.customer.updateMany({ where: { id: { in: ids } }, data: { [c]: 留id } }); }
    if (留[c] === 并id) { 料.置空.push(c); await tx.customer.update({ where: { id: 留id }, data: { [c]: null } }); 留[c] = null; }
  }

  // 3. 空着的字段补上（有值的不覆盖）
  for (const c of 补的列) if (空(留[c]) && !空(并[c])) 料.补了[c] = 并[c];
  if (留.expectedSignAt == null && 并.expectedSignAt != null) { 料.补了.expectedSignAt = 并.expectedSignAt; 料.补了.expectedSignOn = 并.expectedSignOn ?? null; }
  if (推荐组.every((c) => 空(留[c])) && 推荐组.some((c) => !空(并[c]))) {
    for (const c of 推荐组) if (!空(并[c]) && 并[c] !== 留id) 料.补了[c] = 并[c];
  }
  if (Object.keys(料.补了).length) {
    const sets = Object.keys(料.补了);
    // 裸 SQL：时间列按毫秒数原样写（json_object 读出来的就是毫秒数），updatedAt 一起改
    await tx.$executeRawUnsafe(`UPDATE "Customer" SET ${sets.map((c) => `${引(c)} = ?`).join(", ")}, "updatedAt" = ? WHERE id = ?`, ...sets.map((c) => 料.补了[c]), Date.now(), 留id);
  }
  const 并档案 = 料.旁表.CustomerExtra;
  if (并档案) {
    const 留档案 = await 整行(tx, "CustomerExtra", "customerId", 留id);
    for (const c of 档案列) if (!空(并档案[c]) && 空(留档案?.[c])) 料.档案补了[c] = 并档案[c];
    if (Object.keys(料.档案补了).length) {
      if (留档案) await tx.customerExtra.update({ where: { customerId: 留id }, data: 料.档案补了 });
      else { await tx.customerExtra.create({ data: { customerId: 留id, ...料.档案补了 } }); 料.新建档案 = true; }
    }
  }

  // 4. 记号先写、客户后删（中转按顺序核：删了再写记号会被当成挂在已删的上）
  await tx.customerMerge.create({ data: { id: 并id, fromId: 并id, intoId: 留id, fromName: String(并.name), fromOwnerName: 并负责人, userId: 我.id } });
  for (const t of 一位一行) if (料.旁表[t]) await tx.$executeRawUnsafe(`DELETE FROM ${引(t)} WHERE "customerId" = ?`, 并id);
  await tx.customer.delete({ where: { id: 并id } });
  await 重算最近跟进(tx, 留id);
  return 料;
}

/** 撤销一对（调用方开事务）。合并之后又改过的不动：只挪还挂在 留 上的、只清还是补上那个值的 */
export async function 撤销一对(tx: Tx, 料: 撤销料) {
  if (!(await 编号们(tx, 'SELECT id FROM "Customer" WHERE id = ?', 料.留)).length) throw new 合并问题(`「${料.留名}」已经不在了，撤销不了。可以从「合并前」的自动备份恢复`);
  if ((await 编号们(tx, 'SELECT id FROM "Customer" WHERE id = ?', 料.并)).length) throw new 合并问题(`「${料.并名}」已经在了，不用撤销`);
  await tx.customerMerge.deleteMany({ where: { id: 料.并 } });
  await 插回(tx, "Customer", 料.客户);
  for (const t of 一位一行) if (料.旁表[t]) await 插回(tx, t, 料.旁表[t]);
  for (const [t, ids] of Object.entries(料.挪了)) {
    await (tx as unknown as Record<string, { updateMany: (a: unknown) => Promise<unknown> }>)[t[0].toLowerCase() + t.slice(1)].updateMany({ where: { id: { in: ids }, customerId: 料.留 }, data: { customerId: 料.并 } });
  }
  if (料.取消关键.length) await tx.contact.updateMany({ where: { id: { in: 料.取消关键 }, customerId: 料.并 }, data: { isPrimary: true } });
  if (料.线索) await tx.lead.updateMany({ where: { id: 料.线索.id, customerId: 料.线索.挪 ? 料.留 : null }, data: { customerId: 料.并 } });
  for (const [c, ids] of Object.entries(料.改指)) await tx.customer.updateMany({ where: { id: { in: ids }, [c]: 料.留 }, data: { [c]: 料.并 } });
  for (const c of 料.置空) await tx.customer.updateMany({ where: { id: 料.留, [c]: null }, data: { [c]: 料.并 } });
  const 现 = await 整行(tx, "Customer", "id", 料.留);
  const 清 = Object.keys(料.补了).filter((c) => 现 && 现[c] === 料.补了[c]);
  if (清.length) await tx.$executeRawUnsafe(`UPDATE "Customer" SET ${清.map((c) => `${引(c)} = NULL`).join(", ")}, "updatedAt" = ? WHERE id = ?`, Date.now(), 料.留);
  if (Object.keys(料.档案补了).length) {
    const 档 = await 整行(tx, "CustomerExtra", "customerId", 料.留);
    const 清档 = Object.keys(料.档案补了).filter((c) => 档 && 档[c] === 料.档案补了[c]);
    if (档 && 料.新建档案 && 档案列.every((c) => 清档.includes(c) || 空(档[c]))) await tx.customerExtra.delete({ where: { customerId: 料.留 } });
    else if (清档.length) await tx.customerExtra.update({ where: { customerId: 料.留 }, data: Object.fromEntries(清档.map((c) => [c, null])) });
  }
  await 重算最近跟进(tx, 料.留);
  await 重算最近跟进(tx, 料.并);
}

async function 重算最近跟进(tx: Tx, id: string) {
  await tx.$executeRawUnsafe('UPDATE "Customer" SET lastFollowAt = (SELECT MAX(occurredAt) FROM "FollowUp" WHERE customerId = ?) WHERE id = ?', id, id);
}

export class 合并问题 extends Error {}

/* ---------------- 一批：先备份、逐对一个事务、记下撤销料 ---------------- */

const 撤销键 = "customerMergeUndo";
export type 上次合并 = { at: string; 料们: 撤销料[] };

/**
 * 合并前自动备份（照连接团队前的备份：VACUUM INTO 一份）。放在自动备份同一个文件夹，名字 before-merge-…，
 * 设置 → 数据 → 自动备份里列出来、能一键恢复（desktop/auto-backup.js）。留最近 5 份。
 * 不是桌面端（没有 CRM_DATA_DIR）就不备份：网页 / 测试库没有那个文件夹
 */
export async function 合并前备份(db: PrismaClient = prisma): Promise<string | null> {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) return null;
  const 目录 = path.join(dir, "backups");
  fs.mkdirSync(目录, { recursive: true });
  const d = new Date(), 两 = (n: number) => String(n).padStart(2, "0");
  const f = path.join(目录, `before-merge-${d.getFullYear()}-${两(d.getMonth() + 1)}-${两(d.getDate())}-${两(d.getHours())}${两(d.getMinutes())}-${randomBytes(3).toString("hex")}.db`);
  await db.$executeRawUnsafe("VACUUM INTO ?", f);
  const 份 = fs.readdirSync(目录).filter((x) => /^before-merge-.+\.db$/.test(x)).map((x) => ({ x, t: fs.statSync(path.join(目录, x)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { x } of 份.slice(5)) fs.rmSync(path.join(目录, x), { force: true });
  return path.basename(f);
}

export type 一对 = { 留: string; 并: string };
export type 批结果 = { 合了: 撤销料[]; 没合: { 对: 一对; 原因: string }[]; 备份: string | null };

/** 合并一批（调用方核权限、写操作日志）。一对一个事务：一对失败不连累别的 */
export async function 合并一批(对们: 一对[], 我: { id: string }, db: PrismaClient = prisma): Promise<批结果> {
  const 备份 = await 合并前备份(db);
  const 合了: 撤销料[] = [], 没合: 批结果["没合"] = [];
  for (const 对 of 对们) {
    try {
      合了.push(await 看全部(() => db.$transaction((tx) => 合并一对(tx, 对.留, 对.并, 我), { timeout: 60_000 })));
    } catch (e) {
      没合.push({ 对, 原因: e instanceof 合并问题 ? e.message : `出错了：${(e as Error)?.message?.slice(0, 120) ?? e}` });
    }
  }
  // 撤销只留最近这一批（「合并后能撤销一次」）；一对都没合成就不覆盖上一批的。记不下来不算合并失败（备份还在）
  if (合了.length) {
    const value = JSON.stringify({ at: new Date().toISOString(), 料们: 合了 } satisfies 上次合并);
    await 看全部(() => db.setting.upsert({ where: { key: 撤销键 }, create: { key: 撤销键, value }, update: { value } })).catch((e) => console.error("[合并重复] 撤销料没记下", e));
  }
  return { 合了, 没合, 备份 };
}

export async function 读上次合并(db: PrismaClient = prisma): Promise<上次合并 | null> {
  const s = await 看全部(() => db.setting.findUnique({ where: { key: 撤销键 } }));
  try { return s ? (JSON.parse(s.value) as 上次合并) : null; } catch { return null; }
}

/** 撤销上一批（倒着撤：同一位先后并进来两位时先撤后并的那一位）。撤完清掉撤销料，只能撤一次 */
export async function 撤销上一批(db: PrismaClient = prisma): Promise<{ 撤了: 撤销料[]; 没撤: { 料: 撤销料; 原因: string }[] }> {
  const 上 = await 读上次合并(db);
  if (!上) return { 撤了: [], 没撤: [] };
  const 撤了: 撤销料[] = [], 没撤: { 料: 撤销料; 原因: string }[] = [];
  for (const 料 of [...上.料们].reverse()) {
    try {
      await 看全部(() => db.$transaction((tx) => 撤销一对(tx, 料), { timeout: 60_000 }));
      撤了.push(料);
    } catch (e) {
      没撤.push({ 料, 原因: e instanceof 合并问题 ? e.message : `出错了：${(e as Error)?.message?.slice(0, 120) ?? e}` });
    }
  }
  await 看全部(() => db.setting.deleteMany({ where: { key: 撤销键 } }));
  return { 撤了, 没撤 };
}

/* ---------------- 「不是同一个人」 ---------------- */

/** 一对的编号：两个客户编号排好、用 __ 连起来（同步的编号只许字母数字 - _） */
export const 不重复编号 = (a: string, b: string) => (a < b ? `${a}__${b}` : `${b}__${a}`);

/** 一组里两两标上「不是同一个人」。已经标过的跳过 */
export async function 标不是同一个人(ids: string[], 我: { id: string }, db: PrismaClient = prisma): Promise<number> {
  const 排好 = [...new Set(ids)].sort();
  let n = 0;
  await 看全部(() => db.$transaction(async (tx) => {
    for (let i = 0; i < 排好.length; i++) for (let j = i + 1; j < 排好.length; j++) {
      const id = 不重复编号(排好[i], 排好[j]);
      if (await tx.customerNotDupe.findUnique({ where: { id }, select: { id: true } })) continue;
      await tx.customerNotDupe.create({ data: { id, customerId: 排好[i], otherId: 排好[j], userId: 我.id } });
      n++;
    }
  }));
  return n;
}
