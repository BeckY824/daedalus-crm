/**
 * 企业版导入 · 冲突处理：同步时两边都改了（或我们这边删了）记下的待定冲突，由人定「采用原系统」还是「保留我们」。
 *
 * 一次定的算一批（EntImportBatch kind = resolve），每一笔写的照样记 EntImportRow，所以能整批撤回、撤回后再恢复：
 *   - 采用原系统：冲突的那几格照原系统改；本地已删的照原系统那份建回来（对照行指向新建的这条）
 *   - 保留我们：格子不动，对照行记下原系统这次的值——下次同步原系统没再改就不会再问；本地已删的只改状态
 * 记下之后原系统这条又变了、或我们这边删了 / 建回来了，这一笔不定，标成「已过时」：下次同步会按新的情况重新比对。
 * 定的时候同一来源有一批正在写入 / 撤回 / 恢复，先不动（对照行会对不上）。
 */
import { revalidatePath } from "next/cache";
import { prisma } from "../prisma";
import { recordAudit, type Actor } from "../audit";
import { 查完再写 } from "../check-then-write";
import { 看全部 } from "../team-scope";
import { 写不进, 开现场, 落值, 建, 改, 读现值, 规, 引用键, type 现场, type 值表 } from "./apply";
import { 别的在写, 重算最近跟进, type 定的一笔 } from "./revert";
import { 来源名, 实体名, type 来源, type 实体, type 映射, type 待写 } from "./types";

export const 一次最多 = 200;

export type 冲突选择 = 定的一笔["选"];
export type 没定明细 = { 冲突Id: string; 实体?: 实体; 外部ID?: string; 名称?: string; 原因: string };
export type 定冲突结果 = {
  /** 这次定的那一批（能整批撤回）；一笔都没定时为空 */
  批次Id: string | null;
  定了: number;
  /** 记下之后又变了，标成已过时的 */
  过时: number;
  没定: 没定明细[];
};

const J = (v: unknown) => JSON.stringify(v);
function 解<T>(s: string | null | undefined, 缺: T): T {
  if (!s) return 缺;
  try {
    return JSON.parse(s) as T;
  } catch {
    return 缺;
  }
}

type 冲突字段 = Record<string, { 原系统: 值表[string]; 我们: 值表[string]; 上次: 值表[string] }>;

const 名称 = (w: 待写 | null) => String(w?.值.name ?? w?.值.title ?? w?.外部ID ?? "");

/** 记下之后又变了：不定，等下次同步重新比对 */
function 过时了(c: { localDeleted: boolean; targetId: string }, ref: { fingerprint: string; targetId: string } | null, w: 待写, 还在: boolean): string | null {
  if (!ref || ref.fingerprint !== w.指纹 || ref.targetId !== c.targetId) return "记下之后原系统这条又变了";
  if (!c.localDeleted && !还在) return "我们这边这条已经删了";
  if (c.localDeleted && 还在) return "我们这边这条又建回来了";
  return null;
}

/**
 * 定一组冲突（同一来源，一次最多 一次最多 笔），一个事务写完。
 * 已经定过的、找不到的、写不进的（所属客户不在了）不定，原因记在 没定 里
 */
export async function 定冲突(冲突Ids: string[], 选: 冲突选择, 用户: Actor): Promise<定冲突结果> {
  if (选 !== "采用原系统" && 选 !== "保留我们") throw new Error("只能选「采用原系统」或「保留我们」");
  const ids = [...new Set(冲突Ids)];
  if (!ids.length) throw new Error("没选冲突");
  if (ids.length > 一次最多) throw new Error(`一次最多定 ${一次最多} 笔，请分几次`);

  const 们 = await prisma.entConflict.findMany({ where: { id: { in: ids } }, select: { source: true, batchId: true } });
  if (!们.length) throw new Error("找不到这些冲突");
  const 源们 = new Set(们.map((c) => c.source));
  if (源们.size > 1) throw new Error("一次只能定同一来源的冲突");
  const 源 = [...源们][0] as 来源;
  if (await 别的在写(源, "")) throw new Error("同一来源还有一批正在写入或撤回，等它完了再处理冲突");

  // 负责人对不上时退回的默认负责人：照记下冲突的那一批当时的映射
  const 批们 = await prisma.entImportBatch.findMany({ where: { id: { in: 们.map((c) => c.batchId).filter((x): x is string => !!x) } }, select: { id: true, mapping: true } });
  const 映射们 = new Map(批们.map((b) => [b.id, 解<映射 | null>(b.mapping, null)]));
  const 底 = await 开现场("", 源, { 默认负责人Id: "" } as 映射, 用户);

  const r = await 查完再写((tx) =>
    看全部(async () => {
      const 批 = await tx.entImportBatch.create({ data: { source: 源, kind: "resolve", status: "applying", userId: 用户.id } });
      const 结果: 定冲突结果 = { 批次Id: 批.id, 定了: 0, 过时: 0, 没定: [] };
      const 计划: 定的一笔[] = [];
      const 碰过 = new Set<string>();
      let 改了 = 0;
      let 建了 = 0;

      for (const id of ids) {
        const c = await tx.entConflict.findUnique({ where: { id } });
        if (!c) {
          结果.没定.push({ 冲突Id: id, 原因: "找不到这笔冲突" });
          continue;
        }
        const w = 解<待写 | null>(c.incoming, null);
        const e = c.entity as 实体;
        const 明细 = (原因: string): 没定明细 => ({ 冲突Id: id, 实体: e, 外部ID: c.externalId, 名称: 名称(w), 原因 });
        if (c.status !== "待定") {
          结果.没定.push(明细(`已经是「${c.status}」了`));
          continue;
        }
        if (!w) {
          结果.没定.push(明细("原系统那份读不出来了"));
          continue;
        }
        const ref = await tx.entExternalRef.findUnique({ where: 引用键(源, e, c.externalId) });
        const 现值 = await 读现值(tx, e, c.targetId);
        const 过时 = 过时了(c, ref, w, !!现值);
        if (过时 || !ref) {
          await tx.entConflict.updateMany({ where: { id, status: "待定" }, data: { status: "已过时" } });
          结果.过时++;
          结果.没定.push(明细(过时 ?? "记下之后原系统这条又变了"));
          continue;
        }
        const 现: 现场 = { ...底, 批次Id: 批.id, m: (c.batchId && 映射们.get(c.batchId)) || 底.m };
        const 上次 = 解<值表>(ref.written, {});
        const 字段 = 解<冲突字段>(c.fields, {});

        // 先算好原系统那份要落成什么样，算不出来（所属客户不在了）就不定
        let v: 值表 | null = null;
        try {
          v = await 落值(tx, 现, w, 上次, 现值);
        } catch (err) {
          if (!(err instanceof 写不进)) throw err;
          if (选 === "采用原系统") {
            结果.没定.push(明细(err.message));
            continue;
          }
        }

        // 占住这一笔：两个窗口同时定，晚到的那边算已经定过
        const n = await tx.entConflict.updateMany({
          where: { id, status: "待定" },
          data: { status: 选, resolvedById: 用户.id, resolvedAt: new Date(), resolveBatchId: 批.id },
        });
        if (n.count !== 1) {
          结果.没定.push(明细("已经有人定过了"));
          continue;
        }
        计划.push({ 冲突Id: id, 选, 批次Id: c.batchId, 指纹: w.指纹 });
        结果.定了++;

        if (c.localDeleted) {
          if (选 === "保留我们") continue; // 删了就是删了：不建、对照行不动，原系统再改时还会问
          const 新id = await 建(tx, e, v!, 现.现在);
          await tx.entExternalRef.update({ where: { id: ref.id }, data: { targetId: 新id, written: J(v), batchId: 批.id } });
          await tx.entImportRow.create({ data: { batchId: 批.id, entity: e, externalId: c.externalId, targetId: 新id, kind: "create", written: J(v), refBefore: J(ref) } });
          if (e === "followup" && v!.customerId) 碰过.add(String(v!.customerId));
          建了++;
          continue;
        }

        // 原系统这次的值：重新算出来的（负责人离职这类照今天的情况退）；算不出来就用记冲突时的那份
        const 原系统 = (k: string) => (v && k in v ? 规(v[k]) : 规(字段[k].原系统));
        const 新上次: 值表 = { ...上次 };
        const 改动: 值表 = {};
        const before: 值表 = {};
        for (const k of Object.keys(字段)) {
          新上次[k] = 原系统(k);
          if (选 === "采用原系统" && 原系统(k) !== 规(现值![k])) {
            改动[k] = 原系统(k);
            before[k] = 现值![k];
          }
        }
        if (Object.keys(改动).length) {
          await 改(tx, e, c.targetId, 改动, 现值!, 现.现在);
          改了++;
          if (e === "followup") {
            碰过.add(String(现值!.customerId));
            if (改动.customerId) 碰过.add(String(改动.customerId));
          }
        }
        await tx.entExternalRef.update({ where: { id: ref.id }, data: { written: J(新上次), batchId: 批.id } });
        await tx.entImportRow.create({
          data: { batchId: 批.id, entity: e, externalId: c.externalId, targetId: c.targetId, kind: "update", before: J(before), written: J(改动), refBefore: J(ref) },
        });
      }

      if (!结果.定了) {
        await tx.entImportBatch.delete({ where: { id: 批.id } });
        return { ...结果, 批次Id: null };
      }
      await 重算最近跟进(tx, 碰过);
      await tx.entImportBatch.update({
        where: { id: 批.id },
        data: { status: "done", finishedAt: new Date(), plan: J(计划), total: 结果.定了, cursor: 结果.定了, created: 建了, updated: 改了, skipped: 结果.定了 - 建了 - 改了 },
      });
      return 结果;
    }),
  );

  if (r.批次Id) {
    await recordAudit({
      user: 用户,
      action: "ent-resolve",
      entity: "EntImportBatch",
      entityId: r.批次Id,
      summary: `处理从${来源名[源] ?? 源}同步来的冲突：${r.定了} 笔${选}${r.过时 ? `，${r.过时} 笔已过时` : ""}${r.没定.length - r.过时 > 0 ? `，${r.没定.length - r.过时} 笔没定` : ""}`,
      detail: { batchId: r.批次Id, source: 源, 选, 定了: r.定了, 过时: r.过时, 没定: r.没定.slice(0, 50) },
    });
    for (const p of ["/customers", "/leads", "/opportunities", "/dashboard"]) revalidatePath(p);
  }
  return r;
}

/* ───────────────────────── 给页面看 ───────────────────────── */

export type 冲突条目 = {
  id: string;
  来源: 来源;
  实体: 实体;
  实体名: string;
  外部ID: string;
  名称: string;
  本地已删: boolean;
  /** 字段 → 原系统 / 我们 / 上次 */
  字段: 冲突字段;
  状态: string;
  记下时间: Date;
};

/** 冲突列表：默认待定的，新的在前 */
export async function 列冲突(opts: { 状态?: string; 来源?: 来源; 跳过?: number; 取?: number } = {}): Promise<{ 总数: number; 条目: 冲突条目[] }> {
  const where = { status: opts.状态 ?? "待定", ...(opts.来源 ? { source: opts.来源 } : {}) };
  const [总数, 们] = await Promise.all([
    prisma.entConflict.count({ where }),
    prisma.entConflict.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: opts.跳过 ?? 0, take: Math.min(opts.取 ?? 50, 一次最多) }),
  ]);
  return {
    总数,
    条目: 们.map((c) => ({
      id: c.id,
      来源: c.source as 来源,
      实体: c.entity as 实体,
      实体名: 实体名[c.entity as 实体] ?? c.entity,
      外部ID: c.externalId,
      名称: 名称(解<待写 | null>(c.incoming, null)),
      本地已删: c.localDeleted,
      字段: 解<冲突字段>(c.fields, {}),
      状态: c.status,
      记下时间: c.createdAt,
    })),
  };
}
