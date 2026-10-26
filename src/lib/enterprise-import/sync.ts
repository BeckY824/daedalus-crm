/**
 * 企业版导入 · 增量同步：飞书 / 钉钉 → 我们，单向，每小时或每晚一次。
 *
 * 一次同步 = 适配器拉自上次之后改过的 → 照最近一次已认的映射清洗（不再问 AI，不花客户的钱；新冒出来的阶段名、
 * 负责人照规则认，认不出的进报告）→ 存成 kind = sync 的一批 → 直接写。写的那套和首次导入同一份（apply.ts）：
 * 按 来源 + 原系统 ID 去重和更新，没变的靠指纹跳过，我们这边改过的不覆盖、记冲突。所以同步的每一批也能整批撤回。
 *
 * 设置存 Setting `entSync.<来源>`（不进团队同步，见 src/lib/sync/tables.ts 只同步白名单 key）。
 * 切换日（cutover.ts）之后同步永久关掉，这里不再拉。
 *
 * 定时：instrumentation.ts 起一个每 5 分钟的钟，只在 企业版() 开着时起；到点了才真拉。
 * Excel 没有「拉」：再导出一次重新上传，走首次导入那条路，同样按原系统 ID 只更新变了的。
 */
import { prisma } from "../prisma";
import { getSetting, setSetting } from "../settings";
import type { Actor } from "../audit";
import { 企业版 } from "../enterprise/switch";
import { 定时同步通讯录 } from "../enterprise/org-sync";
import { 取适配器, 还没接, type 现有列 } from "./adapter";
import { 写一批 } from "./apply";
import { 试跑, type 试跑结果 } from "./report";
import { 别的在写 } from "./revert";
import { 进备注 } from "./mapping";
import { 来源名, 实体名, 实体顺序, type 来源, type 映射, type 原始记录 } from "./types";

export type 同步频率 = "每小时" | "每晚";
export type 同步结果类别 = "成功" | "没变化" | "没接" | "出错" | "跳过";

export type 同步设置 = {
  开: boolean;
  频率: 同步频率;
  /** 每晚几点拉（服务器时间，0–23） */
  几点: number;
  /** 开同步的人：定时同步写进操作日志时记在他名下 */
  开的人Id: string | null;
  /** 下次拉变化从这个时间起（上次成功那次「开始拉」的时间；拉的过程中原系统又改的，下次会再拉到，靠指纹跳过）。真拉时再往前多拉 拉变化回看毫秒 */
  拉到: string | null;
  上次: { 时间: string; 结果: 同步结果类别; 话: string; 批次Id?: string } | null;
  /** 切换日：之后不再同步 */
  切换: { 时间: string; 快照Id: string; 人Id: string } | null;
};

export const 能同步的来源: 来源[] = ["feishu", "dingtalk"];
const 键 = (源: 来源) => `entSync.${源}`;
/** 拉变化往前多拉这么久：原系统和我们的钟对不齐、或改动晚几秒才记上修改时间的，也拉得到；多拉的靠指纹跳过 */
export const 拉变化回看毫秒 = 5 * 60_000;
const 默认: 同步设置 = { 开: false, 频率: "每晚", 几点: 2, 开的人Id: null, 拉到: null, 上次: null, 切换: null };

export async function 读同步设置(源: 来源): Promise<同步设置> {
  return { ...默认, ...((await getSetting<Partial<同步设置>>(键(源))) ?? {}) };
}

async function 存(源: 来源, 改: Partial<同步设置>): Promise<同步设置> {
  const s = { ...(await 读同步设置(源)), ...改 };
  await setSetting(键(源), s);
  return s;
}

/** 最近一次写完的首次导入 / 同步用的映射：同步照它来 */
export async function 已认映射(源: 来源): Promise<映射 | null> {
  const b = await prisma.entImportBatch.findFirst({
    where: { source: 源, kind: { in: ["full", "sync"] }, status: "done", mapping: { not: null } },
    orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
    select: { mapping: true },
  });
  try {
    return b?.mapping ? (JSON.parse(b.mapping) as 映射) : null;
  } catch {
    return null;
  }
}

/** 开 / 关同步、改频率。开之前要先有一次正式导入（映射是人认过的） */
export async function 改同步设置(源: 来源, 改: { 开?: boolean; 频率?: 同步频率; 几点?: number }, 用户: Actor): Promise<同步设置> {
  if (!能同步的来源.includes(源)) throw new Error("Excel 没有自动同步：把新导出的文件再传一次，按原系统 ID 只更新变了的");
  const 现 = await 读同步设置(源);
  if (现.切换 && 改.开) throw new Error(`已经在 ${现.切换.时间.slice(0, 10)} 切换过了，同步关掉后不能再开`);
  if (改.频率 !== undefined && 改.频率 !== "每小时" && 改.频率 !== "每晚") throw new Error("频率只能是每小时或每晚");
  if (改.几点 !== undefined && !(Number.isInteger(改.几点) && 改.几点 >= 0 && 改.几点 <= 23)) throw new Error("每晚几点要填 0 到 23");
  if (改.开 && !(await 已认映射(源))) throw new Error(`先从${来源名[源]}做一次首次导入（试跑、确认、正式导入），再开同步`);
  return 存(源, {
    ...(改.开 !== undefined ? { 开: 改.开, ...(改.开 ? { 开的人Id: 用户.id } : {}) } : {}),
    ...(改.频率 !== undefined ? { 频率: 改.频率 } : {}),
    ...(改.几点 !== undefined ? { 几点: 改.几点 } : {}),
  });
}

/* ───────────────────────── 首次全量（接口来的） ───────────────────────── */

/** 接口来的首次导入：拉全量 → 试跑出报告（人看过、改好映射再正式导入，和 Excel 同一页） */
export async function 拉全量试跑(源: 来源, 用户Id: string): Promise<试跑结果> {
  const 适配 = 取适配器(源);
  const 记录 = await 适配.拉全量();
  if (!记录.length) throw new Error(`${来源名[源]}那边一条都没拉到，看一下给的权限是不是能读客户、联系人、商机和跟进记录`);
  // 原系统改了列名：旧名从认过的映射里去掉，新名按规则重新认；不然旧名一直留着，同步每次都报「列不见了」
  return 试跑({ 来源: 源, 用户Id, 记录, 已有映射: 去掉不见的列(await 已认映射(源), 现有列们(适配.现有列?.() ?? null, 记录)), 留AI: true });
}

/* ───────────────────────── 同步一次 ───────────────────────── */

export type 同步一次结果 = { 结果: 同步结果类别; 话: string; 批次Id?: string };

/** 报错留最后一行（Prisma 的报错很长，最后一行认得出是什么） */
const 错话 = (e: unknown) => ((e instanceof Error ? e.message : String(e)).trim().split("\n").pop() ?? "").trim().slice(0, 200);

// 放 globalThis：instrumentation 起的钟和页面上的 server action 不一定是同一份模块
const 在同步 = ((globalThis as unknown as { __entSyncRunning?: Partial<Record<来源, { 开始: string; 谁: string }>> }).__entSyncRunning ??= {});

/**
 * 拉一次变化并写完。手动点「立即同步」和定时都走这里；关着也能手动拉（试接口用），切换过的不拉。
 * 上一次同步写到一半（服务重启）的，先接着写完那一批，这次不再拉。
 */
export async function 同步一次(源: 来源, opts: { 用户?: Actor; 现在?: Date } = {}): Promise<同步一次结果> {
  const 设置 = await 读同步设置(源);
  if (设置.切换) return { 结果: "跳过", 话: "已经切换，不再同步" };
  // 同一来源已经在拉（定时那次还没完又点了立即同步，或点了两下）：不叠，也不改「上次」，等那次自己记
  const 在 = 正在同步(源);
  if (在) return { 结果: "跳过", 话: `正在同步（${在.谁} ${new Date(在.开始).toTimeString().slice(0, 5)} 开始的那次还没完），这次不再拉` };
  const 开始 = opts.现在 ?? new Date();
  在同步[源] = { 开始: new Date().toISOString(), 谁: opts.用户?.name || "定时同步" };
  try {
    return await 拉了写(源, 设置, 开始, opts.用户);
  } finally {
    delete 在同步[源];
  }
}

/** 正在拉的那次（谁点的、什么时候开始，服务器时间）；没在拉给 null。界面拿它显示「正在同步」 */
export function 正在同步(源: 来源): { 开始: string; 谁: string } | null {
  return 在同步[源] ?? null;
}

async function 拉了写(源: 来源, 设置: 同步设置, 开始: Date, 手动的人?: Actor): Promise<同步一次结果> {
  const 记 = async (r: 同步一次结果, 拉到?: string) => {
    await 存(源, { 上次: { 时间: 开始.toISOString(), ...r }, ...(拉到 ? { 拉到 } : {}) });
    return r;
  };

  const 用户 = 手动的人 ?? (await 记名的人(设置.开的人Id));
  if (!用户) return 记({ 结果: "出错", 话: "开同步的人找不到了（账号被删或停用），请重新开一次同步" });

  const 半截 = await prisma.entImportBatch.findFirst({ where: { source: 源, kind: "sync", status: "applying" }, select: { id: true } });
  if (半截) return 记(await 写完(半截.id, 用户, "接着写完上次没写完的同步"));
  if (await 别的在写(源, "")) return 记({ 结果: "跳过", 话: "同一来源有一批正在写入、撤回或恢复，这次先不拉" });

  const m = await 已认映射(源);
  if (!m) return 记({ 结果: "跳过", 话: `还没从${来源名[源]}正式导入过，先做一次首次导入` });

  const 适配 = 取适配器(源);
  let 记录: 原始记录[];
  try {
    记录 = await 适配.拉变化(设置.拉到 ? new Date(new Date(设置.拉到).getTime() - 拉变化回看毫秒) : null);
  } catch (e) {
    if (e instanceof 还没接) return 记({ 结果: "没接", 话: e.message });
    return 记({ 结果: "出错", 话: `从${来源名[源]}拉数据没成功：${错话(e)}` });
  }
  // 认过的列在原系统里没了（改名或删了）：照旧映射写会把那一列当没有，先停下，不写也不往前挪
  const 缺 = 不见的列(m, 适配.现有列?.() ?? null, 记录);
  if (缺) return 记({ 结果: "出错", 话: `${来源名[源]}${缺}（可能改了名或删了），这次没写。先重新拉全量试跑、认好列再正式导入一次，同步才接着走` });
  if (!记录.length) return 记({ 结果: "没变化", 话: "原系统没有新改动" }, 开始.toISOString());
  // 拉的时候有人点了切换：这批不写了（快照已经按切换那一刻留了）
  if ((await 读同步设置(源)).切换) return { 结果: "跳过", 话: "已经切换，不再同步" };

  // 照已认的映射清洗，不问 AI：新冒出来的阶段名、负责人照规则认，认不出的进这一批的报告
  const { 批次Id } = await 试跑({ 来源: 源, 用户Id: 用户.id, 记录, 建议器: null, 已有映射: m, 留AI: true, 类型: "sync" });
  const r = await 写完(批次Id, 用户, `拉到 ${记录.length} 条`);
  return 记(r, r.结果 === "出错" ? undefined : 开始.toISOString());
}

/**
 * 映射里落到字段的列（不用的、拼进备注的不算），原系统现在还有没有。
 * 现有 = 适配器按列描述报的列，再并上这次拉到的记录里出现的列；适配器报不了的，只看拉到记录的那几类。
 * 都在返回 null；缺了返回一句「「客户」表里『手机』列不见了」。
 */
export function 不见的列(m: 映射, 现有: 现有列 | null, 记录: 原始记录[]): string | null {
  const 有 = 现有列们(现有, 记录);
  const 话: string[] = [];
  for (const e of 实体顺序) {
    const 列 = 有[e];
    if (!列) continue;
    const 缺 = Object.entries(m.列[e] ?? {})
      .filter(([头, 字段]) => 字段 && 字段 !== 进备注 && !列.has(头))
      .map(([头]) => `『${头}』`);
    if (缺.length) 话.push(`「${实体名[e]}」表里${缺.slice(0, 5).join("、")}${缺.length > 5 ? ` 等 ${缺.length} 列` : "列"}不见了`);
  }
  return 话.length ? 话.join("；") : null;
}

/** 适配器按列描述报的列，并上拉到的记录里出现的列 */
function 现有列们(现有: 现有列 | null, 记录: 原始记录[]): 现有列 {
  const 有: 现有列 = {};
  for (const [e, 列] of Object.entries(现有 ?? {}) as [keyof 现有列, Set<string>][]) 有[e] = new Set(列);
  for (const r of 记录) {
    const 列 = (有[r.实体] ??= new Set());
    for (const k of Object.keys(r.字段)) 列.add(k);
  }
  return 有;
}

/** 认过的映射里，原系统现在没有的列去掉（只动这次拉到了的那几类） */
function 去掉不见的列(m: 映射 | null, 有: 现有列): 映射 | null {
  if (!m) return m;
  const 新 = structuredClone(m);
  for (const [e, 列] of Object.entries(有) as [keyof 现有列, Set<string>][]) {
    if (新.列[e]) 新.列[e] = Object.fromEntries(Object.entries(新.列[e]!).filter(([头]) => 列.has(头)));
  }
  return 新;
}

async function 写完(批次Id: string, 用户: Actor, 前话: string): Promise<同步一次结果> {
  try {
    for (;;) {
      const w = await 写一批(批次Id, 用户);
      if (w.完了) {
        const 有动 = w.新建 + w.更新 + w.冲突 + w.失败 > 0;
        // 全是没变的：这一批没东西可撤，不留在批次列表里
        if (!有动 && !(await prisma.entImportRow.count({ where: { batchId: 批次Id } }))) {
          await prisma.entImportBatch.delete({ where: { id: 批次Id } });
          return { 结果: "没变化", 话: `${前话}，都和上次一样` };
        }
        return {
          结果: "成功",
          话: `${前话}：新建 ${w.新建}，更新 ${w.更新}，跳过 ${w.跳过}${w.冲突 ? `，${w.冲突} 条冲突待定` : ""}${w.失败 ? `，${w.失败} 条没写进去` : ""}`,
          批次Id,
        };
      }
      // 别处在写同一批（两边同时点了立即同步）：它会写完，这边不抢
      if (w.状态 !== "applying") return { 结果: "跳过", 话: "这一批别处在写", 批次Id };
    }
  } catch (e) {
    return { 结果: "出错", 话: `写入没完成（下次接着写）：${错话(e)}`, 批次Id };
  }
}

async function 记名的人(id: string | null): Promise<Actor | null> {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
  return u?.active ? { id: u.id, name: u.name } : null;
}

/* ───────────────────────── 定时 ───────────────────────── */

/** 到点了没：每小时 = 离上次满 55 分钟；每晚 = 今天过了那个钟点、今天那个钟点之后还没拉过（错过了开机就补） */
export function 到点了(s: 同步设置, 现在: Date): boolean {
  if (!s.开 || s.切换) return false;
  const 上次 = s.上次 ? new Date(s.上次.时间).getTime() : null;
  if (s.频率 === "每小时") return 上次 === null || 现在.getTime() - 上次 >= 55 * 60_000;
  const 今天点 = new Date(现在);
  今天点.setHours(s.几点, 0, 0, 0);
  return 现在 >= 今天点 && (上次 === null || 上次 < 今天点.getTime());
}

let 在扫 = false;

/** 扫一遍各来源，到点的同步一次（数据导入 + 通讯录）。企业版没开不扫；上一遍没扫完不叠 */
export async function 定时扫一遍(现在 = new Date()): Promise<void> {
  if (!企业版() || 在扫) return;
  在扫 = true;
  try {
    for (const 源 of 能同步的来源) {
      try {
        if (到点了(await 读同步设置(源), 现在)) await 同步一次(源, { 现在 });
      } catch (e) {
        console.error(`[企业版同步] ${源}`, e);
      }
    }
    // 通讯录 → 组织架构：各来源自己开关，每小时一次
    await 定时同步通讯录(现在);
  } finally {
    在扫 = false;
  }
}

const g = globalThis as unknown as { __entSyncTimer?: ReturnType<typeof setInterval> };

/** 起钟（instrumentation.ts 调；开发时热更新重复调只起一个） */
export function 启动定时(间隔毫秒 = 5 * 60_000): void {
  if (!企业版() || g.__entSyncTimer) return;
  g.__entSyncTimer = setInterval(() => void 定时扫一遍(), 间隔毫秒);
  g.__entSyncTimer.unref?.();
}
