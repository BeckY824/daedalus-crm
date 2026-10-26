"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { 企业版 } from "@/lib/enterprise/switch";
import { 当前是共享区 } from "@/lib/shared-ws/current";
import { 重新试跑, type 试跑报告, type 映射改动 } from "@/lib/enterprise-import/report";
import { 写一批, type 写入结果 } from "@/lib/enterprise-import/apply";
import { 撤回一批, 恢复一批, 留下说法, type 撤回结果, type 留下明细 } from "@/lib/enterprise-import/revert";
import { 列冲突, 定冲突, type 冲突选择, type 定冲突结果, type 冲突条目 } from "@/lib/enterprise-import/resolve";
import { 读同步设置, 改同步设置, 同步一次, 拉全量试跑, 能同步的来源, 正在同步, type 同步设置, type 同步频率, type 同步一次结果 } from "@/lib/enterprise-import/sync";
import { 切换, 列快照, 导出快照, type 切换结果 } from "@/lib/enterprise-import/cutover";
import { 合法值, 值说法, 值对照 } from "@/lib/enterprise-import/mapping";
import { 导出对照表, 读回对照表 } from "@/lib/enterprise-import/template";
import { 负责人候选 } from "@/lib/owners";
import { 来源们, 来源名, type 来源, type 值对照名 } from "@/lib/enterprise-import/types";

/**
 * 设置页「企业版导入」那一栏的服务端动作。上传文件走 /api/enterprise-import/upload（server action 默认只收 1 MB）。
 *
 * 每个动作都先过 要管理员()：企业版开着、是管理员、不是共享试用区。栏目只在这时才摆出来，
 * 但 server action 能被直调，这里再挡一次。
 * 写入、撤回、恢复都是「一段一段」：每调一次干 20 秒左右就返回，界面看 完了 再接着调，一万条不会卡死一个请求。
 */

async function 要管理员() {
  if (!企业版()) throw new Error("企业版没开");
  const me = await requireUser();
  if (me.role !== "ADMIN" || (await 当前是共享区())) throw new Error("只有管理员能做企业版导入");
  return me;
}

function 认来源(s: string): 来源 {
  if (!(来源们 as string[]).includes(s)) throw new Error("来源不对");
  return s as 来源;
}

function 解<T>(s: string | null | undefined, 缺: T): T {
  if (!s) return 缺;
  try {
    return JSON.parse(s) as T;
  } catch {
    return 缺;
  }
}

export type 批次行 = {
  id: string;
  来源: 来源;
  类型: string;
  状态: string;
  总数: number;
  写到: number;
  新建: number;
  更新: number;
  跳过: number;
  冲突: number;
  失败: number;
  人名: string;
  时间: string;
  完成时间: string | null;
  撤回时间: string | null;
  /** 最近一次撤回 / 恢复的账 */
  撤回账: { 动作: string; 删掉: number; 还原: number; 恢复: number; 留下数: number; 留下: string[] } | null;
  /** 写不进去的那几条（最多列 50 条） */
  失败明细: string[];
};

export type 企业版概况 = {
  批次们: 批次行[];
  /** 三个来源都列：Excel 没有自动同步（能同步 false），但也能切换、留快照 */
  /** 在同步：这一刻正在拉的那次（定时或别人点的也算），界面显示「正在同步」 */
  同步: { 来源: 来源; 名: string; 能同步: boolean; 设置: 同步设置; 在同步: { 开始: string; 谁: string } | null }[];
  待定冲突: number;
  快照们: { id: string; 来源: 来源; 名: string; 条数: number; 人名: string; 时间: string }[];
  成员们: { id: string; name: string }[];
  /** 报告上改「原值 → 我们的值」时能选的（跟进方式存英文，说法是中文） */
  合法值们: Record<值对照名, { 值: string; 说法: string }[]>;
};

/** 撤回 / 恢复一段的结果：留下的那几条已经拼成给人看的话 */
export type 撤回一段结果 = Omit<撤回结果, "留下"> & { 留下: string[] };

/** 列表最多给多少批（同步每小时一批，没变化的不留，几个月下来也就几百批） */
const 列多少批 = 200;

export async function 企业版导入概况(): Promise<企业版概况> {
  await 要管理员();
  const [批们, 待定冲突, 快照们, 成员们, 同步] = await Promise.all([
    prisma.entImportBatch.findMany({
      where: { kind: { in: ["full", "sync"] } },
      orderBy: { createdAt: "desc" },
      take: 列多少批,
      select: { id: true, source: true, kind: true, status: true, total: true, cursor: true, created: true, updated: true, skipped: true, conflicts: true, failed: true, userId: true, createdAt: true, finishedAt: true, revertedAt: true, revertNote: true, note: true },
    }),
    prisma.entConflict.count({ where: { status: "待定" } }),
    列快照(),
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, active: true } }),
    Promise.all(来源们.map(async (源) => ({ 来源: 源, 名: 来源名[源], 能同步: 能同步的来源.includes(源), 设置: await 读同步设置(源), 在同步: 正在同步(源) }))),
  ]);
  const 名 = new Map(成员们.map((u) => [u.id, u.name]));
  return {
    批次们: 批们.map((b) => {
      const 账 = 解<{ 动作: string; 删掉: number; 还原: number; 恢复: number; 留下数: number; 留下: 留下明细[] } | null>(b.revertNote, null);
      return {
        id: b.id,
        来源: b.source as 来源,
        类型: b.kind,
        状态: b.status,
        总数: b.total,
        写到: b.cursor,
        新建: b.created,
        更新: b.updated,
        跳过: b.skipped,
        冲突: b.conflicts,
        失败: b.failed,
        人名: (b.userId && 名.get(b.userId)) || "",
        时间: b.createdAt.toISOString(),
        完成时间: b.finishedAt?.toISOString() ?? null,
        撤回时间: b.revertedAt?.toISOString() ?? null,
        撤回账: 账 ? { ...账, 留下: (账.留下 ?? []).map(留下说法) } : null,
        失败明细: 解<{ 原因: string; 行号?: number; 出处?: string; 外部ID: string }[]>(b.note, [])
          .slice(0, 50)
          .map((f) => `${f.出处 ? `${f.出处}${f.行号 ? ` 第 ${f.行号} 行` : ""}` : f.外部ID}：${f.原因}`),
      };
    }),
    同步,
    待定冲突,
    快照们: 快照们.map((s) => ({ id: s.id, 来源: s.来源, 名: 来源名[s.来源] ?? s.来源, 条数: s.条数, 人名: (s.人Id && 名.get(s.人Id)) || "", 时间: s.时间.toISOString() })),
    成员们: 成员们.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })),
    合法值们: Object.fromEntries(
      (Object.keys(值对照) as 值对照名[]).map((名) => [名, 合法值(名).map((v) => ({ 值: v, 说法: 值说法(名, v) }))]),
    ) as 企业版概况["合法值们"],
  };
}

/** 打开一次试跑的报告（上传完、或者回头再看） */
export async function 取试跑报告(批次Id: string): Promise<{ 状态: string; 报告: 试跑报告 } | null> {
  await 要管理员();
  const b = await prisma.entImportBatch.findUnique({ where: { id: 批次Id }, select: { status: true, report: true } });
  const 报告 = 解<试跑报告 | null>(b?.report, null);
  return b && 报告 ? { 状态: b.status, 报告 } : null;
}

/** 在报告上改了映射：重新试跑（不再问 AI） */
export async function 改映射重新试跑(批次Id: string, 改: 映射改动): Promise<试跑报告> {
  const me = await 要管理员();
  return (await 重新试跑(批次Id, 改, me.id)).报告;
}

/** 对照表：报告里列、值、负责人怎么对的导成一张 CSV，给原系统那边的人填 */
export async function 下载对照表(批次Id: string): Promise<string> {
  await 要管理员();
  const r = await 取试跑报告(批次Id);
  if (!r) throw new Error("找不到这次试跑，请重新上传");
  return 导出对照表(r.报告, await 负责人候选());
}

/** 填好的对照表传回来：和报告不一样的当人改的，重新试跑一遍；填错的行不算，列在 问题 里 */
export async function 填回对照表(批次Id: string, 表单: FormData): Promise<{ 报告: 试跑报告; 改了: number; 问题: string[] }> {
  const me = await 要管理员();
  const f = 表单.get("file");
  if (!f || typeof f === "string") throw new Error("没收到对照表，请重新选一下");
  const r = await 取试跑报告(批次Id);
  if (!r) throw new Error("找不到这次试跑，请重新上传");
  const 读 = 读回对照表({ 名: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, r.报告, await 负责人候选());
  const 报告 = 读.改了 ? (await 重新试跑(批次Id, 读.改, me.id)).报告 : r.报告;
  return { 报告, 改了: 读.改了, 问题: 读.问题 };
}

/** 不要这次试跑了：只删还没开始导入的 */
export async function 丢掉试跑(批次Id: string): Promise<void> {
  await 要管理员();
  await prisma.entImportBatch.deleteMany({ where: { id: 批次Id, status: "preview" } });
}

/** 正式导入：写一段，界面看 完了 再接着调 */
export async function 正式导入一段(批次Id: string): Promise<写入结果> {
  const me = await 要管理员();
  return 写一批(批次Id, { id: me.id, name: me.name });
}

/**
 * 整批撤回一段。开始撤（done 那一刻）时，这个来源的自动同步要先关：
 * 一边撤一边同步，刚撤掉的下一小时又被拉回来，人会以为撤回没起作用。
 */
export async function 撤回一段(批次Id: string): Promise<撤回一段结果> {
  const me = await 要管理员();
  const b = await prisma.entImportBatch.findUnique({ where: { id: 批次Id }, select: { source: true, status: true } });
  if (b?.status === "done" && 能同步的来源.includes(b.source as 来源) && (await 读同步设置(b.source as 来源)).开) {
    throw new Error(`${来源名[b.source as 来源]}的自动同步开着：先暂停同步再撤回，不然下次同步会把撤掉的又拉回来`);
  }
  return 说清留下(await 撤回一批(批次Id, { id: me.id, name: me.name }));
}

export async function 恢复一段(批次Id: string): Promise<撤回一段结果> {
  const me = await 要管理员();
  return 说清留下(await 恢复一批(批次Id, { id: me.id, name: me.name }));
}

const 说清留下 = (r: 撤回结果): 撤回一段结果 => ({ ...r, 留下: r.留下.map(留下说法) });

/* ───────────────────────── 冲突 ───────────────────────── */

export async function 冲突列表(opts: { 来源?: string; 跳过?: number; 取?: number }): Promise<{ 总数: number; 条目: (Omit<冲突条目, "记下时间"> & { 记下时间: string })[] }> {
  await 要管理员();
  const r = await 列冲突({ 来源: opts.来源 ? 认来源(opts.来源) : undefined, 跳过: opts.跳过, 取: opts.取 });
  return { 总数: r.总数, 条目: r.条目.map((c) => ({ ...c, 记下时间: c.记下时间.toISOString() })) };
}

export async function 定这些冲突(ids: string[], 选: 冲突选择): Promise<定冲突结果> {
  const me = await 要管理员();
  if (选 !== "采用原系统" && 选 !== "保留我们") throw new Error("只能选采用原系统或保留我们");
  return 定冲突(ids, 选, { id: me.id, name: me.name });
}

/* ───────────────────────── 同步 / 切换 ───────────────────────── */

export async function 改同步(源: string, 改: { 开?: boolean; 频率?: 同步频率; 几点?: number }): Promise<同步设置> {
  const me = await 要管理员();
  return 改同步设置(认来源(源), 改, { id: me.id, name: me.name });
}

export async function 立即同步(源: string): Promise<同步一次结果> {
  const me = await 要管理员();
  return 同步一次(认来源(源), { 用户: { id: me.id, name: me.name } });
}

/** 接口来的首次导入：拉全量出报告，后面和 Excel 同一套（看报告 → 改映射 → 正式导入） */
export async function 从接口拉全量(源: string): Promise<{ 批次Id: string; 报告: 试跑报告 }> {
  const me = await 要管理员();
  return 拉全量试跑(认来源(源), me.id);
}

export async function 切换这个来源(源: string): Promise<切换结果> {
  const me = await 要管理员();
  return 切换(认来源(源), { id: me.id, name: me.name });
}

export async function 下载快照(id: string): Promise<{ 文件名: string; 内容: string } | null> {
  await 要管理员();
  return 导出快照(id);
}
