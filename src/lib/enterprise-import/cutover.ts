/**
 * 企业版导入 · 切换日：客户全面改用我们之后，把某个来源的同步永久关掉，快照留档。
 *
 * 快照 = 那一刻这个来源所有对照行：原系统 ID ↔ 我们这边的记录 ID，加原系统最后一次给的原始记录。
 * 以后有人问「这条在飞书里原来是什么样」照它查；导出成 JSON 给客户存。
 * 切换之后：同步不再拉、不能再开（sync.ts 看 切换）；待定的冲突照样能定，已导的批次照样能撤回。
 * 同一来源有一批正在写入 / 撤回 / 恢复时不切（快照会缺一截）。
 */
import { prisma } from "../prisma";
import { recordAudit, type Actor } from "../audit";
import { 别的在写 } from "./revert";
import { 读同步设置 } from "./sync";
import { setSetting } from "../settings";
import { 来源名, type 来源 } from "./types";

export type 快照条目 = { entity: string; externalId: string; targetId: string; raw: unknown };
export type 切换结果 = { 快照Id: string; 条数: number; 待定冲突: number };

const 每次读 = 2000;

function 解(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function 切换(源: 来源, 用户: Actor): Promise<切换结果> {
  const 设置 = await 读同步设置(源);
  if (设置.切换) throw new Error(`${来源名[源]}已经在 ${设置.切换.时间.slice(0, 10)} 切换过了`);
  if (await 别的在写(源, "")) throw new Error("同一来源还有一批正在写入、撤回或恢复，等它完了再切换");

  // 分段按 id 读，一万多条也不一次拉进内存
  const data: 快照条目[] = [];
  for (let 起 = ""; ; ) {
    const 段 = await prisma.entExternalRef.findMany({
      where: { source: 源, id: { gt: 起 } },
      orderBy: { id: "asc" },
      take: 每次读,
      select: { id: true, entity: true, externalId: true, targetId: true, raw: true },
    });
    for (const r of 段) data.push({ entity: r.entity, externalId: r.externalId, targetId: r.targetId, raw: 解(r.raw) });
    if (段.length < 每次读) break;
    起 = 段[段.length - 1].id;
  }

  const 快照 = await prisma.entSnapshot.create({ data: { source: 源, userId: 用户.id, count: data.length, data: JSON.stringify(data) }, select: { id: true } });
  const 时间 = new Date().toISOString();
  await setSetting(`entSync.${源}`, { ...设置, 开: false, 切换: { 时间, 快照Id: 快照.id, 人Id: 用户.id } });
  const 待定冲突 = await prisma.entConflict.count({ where: { source: 源, status: "待定" } });

  await recordAudit({
    user: 用户,
    action: "ent-cutover",
    entity: "EntSnapshot",
    entityId: 快照.id,
    summary: `${来源名[源]}切换：同步已关，快照留档 ${data.length} 条对照${待定冲突 ? `，还有 ${待定冲突} 笔冲突待定` : ""}`,
    detail: { source: 源, snapshotId: 快照.id, count: data.length, 待定冲突 },
  });
  return { 快照Id: 快照.id, 条数: data.length, 待定冲突 };
}

export type 快照概要 = { id: string; 来源: 来源; 条数: number; 人Id: string | null; 时间: Date };

export async function 列快照(源?: 来源): Promise<快照概要[]> {
  const 们 = await prisma.entSnapshot.findMany({
    where: 源 ? { source: 源 } : {},
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, count: true, userId: true, createdAt: true },
  });
  return 们.map((s) => ({ id: s.id, 来源: s.source as 来源, 条数: s.count, 人Id: s.userId, 时间: s.createdAt }));
}

/** 下载用：整份快照，JSON 文本 */
export async function 导出快照(id: string): Promise<{ 文件名: string; 内容: string } | null> {
  const s = await prisma.entSnapshot.findUnique({ where: { id } });
  if (!s) return null;
  const 内容 = JSON.stringify({ 来源: s.source, 来源名: 来源名[s.source as 来源] ?? s.source, 时间: s.createdAt.toISOString(), 条数: s.count, 对照: JSON.parse(s.data) }, null, 2);
  return { 文件名: `${来源名[s.source as 来源] ?? s.source}-切换快照-${s.createdAt.toISOString().slice(0, 10)}.json`, 内容 };
}
