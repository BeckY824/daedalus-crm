/**
 * 手机端的团队同步（2026-10-15，方案：~/Opensource_CRM/02-开发与发版/手机端-方案-20261015.md 第 3 节）。
 *
 * 手机在服务端眼里就是**这个成员的又一台设备**：自己的设备号、自己的 X25519 钥匙对，
 * 走和桌面端同一套 v4 范围同步（/api/sync/scoped）——业务员只收得到本人 + 公海，老板收全队，权限由服务端把关。
 * 这里只管协议和合并，不管存在哪：存储（手机库）、和云端说话（传输）都由调用方给，
 * 浏览器里是 IndexedDB + fetch，测试里是内存 + 直接调中转（tests/mobile-sync.test.ts，和桌面端真客户端一起跑）。
 *
 * 和桌面端 lib/sync/client.ts 的 范围一轮 对照：
 *   - 收包时逐项核对一模一样（解密绑定、内外层元数据、在不在目录、父链可见），用的是同一份 scope-policy / scoped-pure
 *   - 合并规则一样：字段级后写为准、删除留墓碑、自己推过的不重放
 *   - 不做的：老板迁移、补发起点、改负责人（这些会牵动「起点」，留在电脑上做）。公海客户记跟进时顺带领取（10-19「记跟进 = 领取」，见 记跟进）
 *   - 手机只写这几张表：FollowUp、FollowPlan、AuditLog（记一笔跟进时电脑上写的也就是这几样，见 customers/[id]/actions.ts）；
 *     2026-10-19 起加上新建客户（Customer、CustomerExtra）和新建商机（Opportunity、OpportunityMoney），都归本人；
 *     记跟进时挂订单写 FollowUpOrder（和电脑上「关联商机 / 订单」同一个字段）
 */
import { 提取范围, 核对范围, 行键, 范围父表, 还等吗, type 范围索引, type 范围元数据, type 卡住的范围 } from "@/lib/sync/scope-policy";
import { 同步表, 不同步列 } from "@/lib/sync/tables";
import { 归一化范围行, 主键表 } from "@/lib/sync/scoped-pure";
import { 规范串 } from "@/lib/sync/canon";
import * as 密 from "@/lib/sync/crypto-web";
import type { 改动 } from "@/lib/sync/local";
// 下面这几样都不牵进服务端模块（Prisma、node:*）：手机页面直接打包
import { BUSINESS_KEY, mergeBusiness, 外贸订单, type BusinessConfig } from "@/lib/business-config";
import { 订单前缀 } from "@/lib/follow-link";
import { DECISION_STATUSES, FOLLOW_STATUSES, OPP_STAGES, STAGE_PROBABILITY } from "@/lib/constants";
import { 金额 as 显示金额, 规整币种 } from "@/lib/currency";
import { 认国家, 规整外贸格, type 外贸档案 } from "@/lib/customer-extra";
import { hasVisibleText } from "@/lib/form-validation";
import { 号键, 查电话 } from "@/lib/phone";
import { 客户查重值, 查重键, 查重原文, 查重标签绑定, 查重指纹, 查重单次上限, 同事撞号说法, type 查重种类, type 查重条目, type 查重命中 } from "@/lib/sync/dedupe";

export type { 改动 };
export type 传输 = (方法: "GET" | "POST", 路径: string, body?: unknown) => Promise<{ 状态: number; json: Record<string, unknown> }>;

/** 这台手机在团队里的身份。电脑授权时封给手机的就是这些（私钥是手机自己生成的，不出手机） */
export type 手机团队 = {
  teamId: string;
  device: string;
  /** 当前钥匙和编号；keys 是之前的钥匙（解老包用） */
  key: string;
  epoch: number;
  keys: 密.钥匙环;
  /** 老板的签名公钥：换钥匙时只认老板签过的 */
  signPub?: string;
  /** 本人在团队库里的用户 id（acct_<云端账号>） */
  userId: string;
  /** 这台手机的 X25519 私钥：内置时是 CryptoKey，没内置时是原始字节（存盘前都由 store.ts 封起来） */
  私钥: 密.设备私钥;
};

export type 同步状态 = {
  cursors: Record<string, { after: number; revision: number }>;
  /** 手机上记了、还没推上去的 */
  待推: 改动[];
  /** 推上去被服务端拒了的（例如断网期间这位客户转给了别人）：不悄悄丢，界面上提示、内容可复制 */
  被拒: { 改动: 改动; 原因: string }[];
  /** 本机时钟：上一次编的毫秒数。收到别人的改动会推到对方的数（和桌面端 _sync_clock 一样） */
  钟: number;
  skipped: number;
  /** 哪些范围停在「目录里还没有」的那一包前面、等了几轮（2026-10-21，scope-policy 还等吗） */
  held?: 卡住的范围;
  /** 上一次「试着同步」的时间：成功、出错都记 */
  lastSyncAt?: string;
  /**
   * 上一次同步成功的时间（2026-10-15 起才有）。只在成功时写：团队到期被拒时不能拿出错的时间冒充「已同步 · 刚才」。
   * 之前存下的老状态没有这一项，读法见 上次成功()
   */
  lastOkAt?: string;
  lastError?: string | null;
  /** 跨成员查重：这台报过的客户指纹（客户 id → 查重指纹，见 lib/sync/dedupe.ts），只报变了的 */
  查重?: Record<string, string>;
};
export const 新状态 = (): 同步状态 => ({ cursors: {}, 待推: [], 被拒: [], 钟: 0, skipped: 0 });
/** 上次同步成功是什么时候（毫秒）。老状态没有 lastOkAt：没出错时 lastSyncAt 就是成功的那次，出着错就不知道 */
export function 上次成功(s: Pick<同步状态, "lastSyncAt" | "lastOkAt" | "lastError">): number | null {
  const v = s.lastOkAt ?? (s.lastError ? undefined : s.lastSyncAt);
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** 手机上存的一行：整行 + 每列的字段钟 */
export type 记录 = { t: string; k: string; r: Record<string, unknown>; 钟: Record<string, string> };
export interface 手机库 {
  取(t: string, k: string): Promise<记录 | undefined>;
  放(x: 记录): Promise<void>;
  删(t: string, k: string): Promise<void>;
  墓(t: string, k: string): Promise<string | undefined>;
  记墓(t: string, k: string, h: string): Promise<void>;
  /** 本机有的全部行键（`表:主键`） */
  键们(): Promise<string[]>;
}

/** 测试和「还没开 IndexedDB」时用的内存库 */
export class 内存库 implements 手机库 {
  行 = new Map<string, 记录>();
  墓碑 = new Map<string, string>();
  async 取(t: string, k: string) { const x = this.行.get(行键(t, k)); return x && { ...x, r: { ...x.r }, 钟: { ...x.钟 } }; }
  async 放(x: 记录) { this.行.set(行键(x.t, x.k), { ...x, r: { ...x.r }, 钟: { ...x.钟 } }); }
  async 删(t: string, k: string) { this.行.delete(行键(t, k)); }
  async 墓(t: string, k: string) { return this.墓碑.get(行键(t, k)); }
  async 记墓(t: string, k: string, h: string) { const 旧 = this.墓碑.get(行键(t, k)); if (!旧 || h > 旧) this.墓碑.set(行键(t, k), h); }
  async 键们() { return [...this.行.keys()]; }
  表(t: string) { return [...this.行.values()].filter((x) => x.t === t).map((x) => x.r); }
}

/** 说给人听的同步问题（不是程序错） */
export class 同步问题 extends Error {}
class 范围包错误 extends Error {}
/** 不在这一轮目录里（可能是取目录之后才新建的）：下一轮再拉，见 scope-policy 还等吗 */
class 范围包未到 extends 范围包错误 {}

const 钟串 = (ms: number, 设备: string) => `${String(ms).padStart(15, "0")}-${设备}`;
const 钟的毫秒 = (h: string) => Number(h.split("-")[0]) || 0;
const 范围路径 = "/api/sync/scoped";
const 话 = (r: { 状态: number; json: Record<string, unknown> }, 默认: string) => String(r.json.error ?? `${默认}（${r.状态}）`);

/* ---------------- 钥匙 ---------------- */

async function 验过(签好: string, 用途: string, signPub: string | undefined): Promise<string> {
  if (!signPub) return 签好;
  const 原 = await 密.验(签好, 用途, signPub);
  if (原 == null) throw new 同步问题("收到的团队钥匙没有老板的签名，这次没收下。先别在这台手机上同步，联系我们");
  return 原;
}
const 全部钥匙 = (c: 手机团队): 密.钥匙环 => ({ ...c.keys, [String(c.epoch)]: c.key });

/** 团队换过钥匙：取封给这台手机的那一份，用手机私钥解开，再解开钥匙环（和桌面端 更新钥匙 同一流程） */
export async function 更新钥匙(c: 手机团队, 云: 传输): Promise<手机团队> {
  const r = await 云("GET", `/api/sync/key?teamId=${encodeURIComponent(c.teamId)}&device=${encodeURIComponent(c.device)}`);
  if (r.状态 !== 200) throw new 同步问题(话(r, "取不到团队钥匙"));
  const epoch = Number(r.json.epoch ?? 0);
  if (epoch <= c.epoch) return c;
  const 信 = r.json.envelope ? String(r.json.envelope) : null;
  if (!信) throw new 同步问题("团队换过钥匙了，这台手机没拿到新钥匙：在电脑上重新授权这台手机");
  const key = await 密.拆自(c.私钥, await 验过(信, `env|${c.teamId}|${epoch}|${c.device}`, c.signPub));
  const 环 = await 验过(String(r.json.ring ?? ""), `ring|${c.teamId}|${epoch}`, c.signPub);
  const keys = (await 密.拆<{ keys: 密.钥匙环 }>(环, key, { teamId: c.teamId, device: "ring" })).keys;
  return { ...c, key, epoch, keys };
}

/* ---------------- 合并（对照 local.ts 回放） ---------------- */

/**
 * 按字段钟把一批改动放进手机库。自己推过的不重放（手机记的时候已经放过了）。
 * 返回动过的行数。
 */
export async function 回放(库: 手机库, 批: 改动[], 本机设备: string, 状态: 同步状态, 选项: { 含本人?: boolean } = {}): Promise<number> {
  const 排好 = [...批].filter((e) => 选项.含本人 || !e.h.endsWith(`-${本机设备}`)).sort((a, b) => a.h.localeCompare(b.h));
  let 动 = 0;
  for (const e of 排好) {
    if (!(同步表 as readonly string[]).includes(e.t)) continue;
    状态.钟 = Math.max(状态.钟, 钟的毫秒(e.h));
    const 现 = await 库.取(e.t, e.k);
    if (e.o === "D") {
      const 更晚 = 现 && Object.values(现.钟).some((h) => h > e.h);
      if (现 && !更晚) { await 库.删(e.t, e.k); 动++; }
      await 库.记墓(e.t, e.k, e.h);
      continue;
    }
    const 墓 = await 库.墓(e.t, e.k);
    if (墓 && 墓 > e.h) continue;
    const 不要 = 不同步列[e.t] ?? [];
    const row = Object.fromEntries(Object.entries(e.r ?? {}).filter(([c]) => !不要.includes(c)));
    if (!现) {
      // 外贸档案一位一行：插入时空着的列不记钟（同 local.ts）
      const 钟 = Object.fromEntries(Object.keys(row).filter((c) => e.t !== "CustomerExtra" || row[c] != null).map((c) => [c, e.h]));
      await 库.放({ t: e.t, k: e.k, r: row, 钟 });
      动++;
      continue;
    }
    const 只带有值的 = e.o === "I" && e.t === "CustomerExtra";
    const 要改 = e.c.filter((c) => c in row && !不要.includes(c) && !(只带有值的 && row[c] == null) && (!现.钟[c] || 现.钟[c] < e.h));
    if (!要改.length) continue;
    for (const c of 要改) { 现.r[c] = row[c]; 现.钟[c] = e.h; }
    await 库.放(现);
    动++;
  }
  return 动;
}

/* ---------------- 收包核对（对照 scoped-local.ts 验收范围包） ---------------- */

type 拉到的包 = { seq: number; device: string; eventId: string; meta: 范围元数据; data: string };

async function 验收(b: 拉到的包, keys: 密.钥匙环, teamId: string, current: 范围索引 | undefined, allowed: Set<string>): Promise<改动> {
  let inner: { meta: 范围元数据; change: 改动 };
  try {
    inner = await 密.拆范围(b.data, keys, { teamId, device: b.device, eventId: b.eventId, meta: b.meta });
  } catch (e) {
    if (e instanceof Error && /^没有 \d+ 号钥匙/.test(e.message)) throw e;
    throw new 范围包错误("范围密文与外层元数据不符或已损坏");
  }
  if (!inner || 规范串(inner.meta) !== 规范串(b.meta) || !核对范围(b.meta, inner.change)) throw new 范围包错误("密文内容与授权元数据不一致");
  if (inner.change.o === "D" && (inner.change.r != null || (inner.change.c ?? []).length)) throw new 范围包错误("删除包不能带内容");
  const key = 行键(b.meta.t, b.meta.k);
  if (!current || !allowed.has(key)) throw new 范围包未到("该记录不在本机同步范围内");
  const e = 归一化范围行(inner.change, current, allowed);
  if (e.o !== "D" && e.r) for (const [field, table] of Object.entries(范围父表[e.t] ?? {})) {
    const v = e.r[field];
    if (v != null && !allowed.has(行键(table, String(v)))) throw new 范围包未到(`关联的${table}不在本机同步范围内`);
  }
  return e;
}

/* ---------------- 推 ---------------- */

async function 做包(c: 手机团队, e: 改动) {
  const meta = 提取范围(e);
  const eventId = await 密.事件编号(c.key, `log|${c.device}`, e);
  return { meta, eventId, data: await 密.封范围({ meta, change: e }, c.key, c.epoch, { teamId: c.teamId, device: c.device, eventId, meta }) };
}

/** 把待推的推上去。被服务端按归属拒掉的挪进「被拒」，其余照常（整批是回滚了的，去掉被拒的重推） */
export async function 推(c0: 手机团队, 云: 传输, 状态: 同步状态, 库?: 手机库): Promise<{ c: 手机团队; 推: number; 拒: number }> {
  let c = c0, 推 = 0, 拒 = 0, 换钥 = 0, 重来 = 0;
  while (状态.待推.length) {
    const 这批 = 状态.待推.slice(0, 100);
    const packets = await Promise.all(这批.map((e) => 做包(c, e)));
    const r = await 云("POST", 范围路径, { teamId: c.teamId, action: "push", device: c.device, packets });
    if (r.状态 === 409 && /换过钥匙/.test(String(r.json.error ?? "")) && 换钥++ < 3) { c = await 更新钥匙(c, 云); continue; }
    if (r.状态 === 403 && Array.isArray(r.json.denied) && 重来++ < 50) {
      const denied = new Set((r.json.denied as unknown[]).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < 这批.length));
      if (denied.size) {
        // gone：挂在已经删掉的客户 / 商机下面（2026-10-19）；老服务端不回这一项，照旧按「不归你了」说
        const 删了 = new Set(Array.isArray(r.json.gone) ? (r.json.gone as unknown[]).filter((i): i is number => Number.isInteger(i)) : []);
        // taken：想领的公海客户被别人先领走了（2026-10-19「记跟进 = 领取」）：客户 id → 现在的负责人，名字从本机同事名单取
        const 领走: Record<string, string> = {};
        if (r.json.taken && typeof r.json.taken === "object") {
          for (const [k, who] of Object.entries(r.json.taken as Record<string, unknown>)) {
            const 人 = typeof who === "string" && 库 ? await 库.取("User", who) : undefined;
            领走[k] = String(人?.r.name ?? "") || "同事";
          }
        }
        const 哪位 = (e: 改动) => ["Customer", "CustomerClaim", "CustomerPool"].includes(e.t) ? e.k : String(e.r?.customerId ?? (e.t === "AuditLog" && e.r?.entity === "Customer" ? e.r.entityId : "") ?? "");
        for (const i of denied) {
          const 谁领走 = 领走[哪位(这批[i])];
          状态.被拒.push({ 改动: 这批[i], 原因: 删了.has(i) ? "这位客户（或商机）已经在电脑上被删了，这条没同步上；内容还在，可以复制下来"
            : 谁领走 ? `这位公海客户已被 ${谁领走} 先领走，这条没同步上；内容还在，可以复制下来`
            : "这位客户已经不归你了，这条没同步上" });
        }
        拒 += denied.size;
        /*
          被拒那几条的操作日志（「记了 XX 的一条跟进」）也不推：操作日志按它说的那条记录算归属，那条没落下就算成本人的，
          服务端照收——老板的操作日志里写着记了一条跟进，跟进却不在（2026-10-16 团队版全面检验）。一起挪进被拒，界面只列跟进
        */
        const 被拒的 = new Set([...denied].map((i) => 行键(这批[i].t, 这批[i].k)));
        const 跟着拒 = (e: 改动) => e.t === "AuditLog" && !!e.r && 被拒的.has(行键(String(e.r.entity ?? ""), String(e.r.entityId ?? "")));
        const 剩 = [...这批.filter((_, i) => !denied.has(i)), ...状态.待推.slice(这批.length)];
        for (const e of 剩.filter(跟着拒)) 状态.被拒.push({ 改动: e, 原因: 领走[哪位(e)] ? `这位公海客户已被 ${领走[哪位(e)]} 先领走，这条没同步上` : "这位客户已经不归你了，这条没同步上" });
        状态.待推 = 剩.filter((e) => !跟着拒(e));
        continue;
      }
    }
    if (r.状态 !== 200) throw new 同步问题(话(r, "推送失败"));
    状态.待推 = 状态.待推.slice(这批.length);
    推 += 这批.length;
  }
  return { c, 推, 拒 };
}

/* ---------------- 拉 ---------------- */

/** 一轮：先推、再按目录拉、逐包核对后合并；目录里没有的（失权）本机删掉，目录说删了的补删 */
export async function 同步一轮(c0: 手机团队, 云: 传输, 库: 手机库, 状态: 同步状态): Promise<{ c: 手机团队; 推: number; 拉: number; 拒: number }> {
  let c = c0;
  try {
    const p = await 推(c, 云, 状态, 库);
    c = p.c;
    const d = await 云("POST", 范围路径, { teamId: c.teamId, action: "directory", device: c.device });
    if (d.状态 !== 200) throw new 同步问题(话(d, "取不到同步目录"));
    if (Number(d.json.epoch ?? 0) > c.epoch) c = await 更新钥匙(c, 云);
    // 「团队」范围（成员、设置）先拉，和桌面端一样
    const scopes = ((d.json.scopes as { id: string; revision: number; head?: number; records: 范围索引[] }[]) ?? []).sort((a, b) => Number(b.id === "team") - Number(a.id === "team"));
    const index = new Map<string, 范围索引>();
    for (const s of scopes) for (const r of s.records) index.set(行键(r.t, r.k), r);
    const allowed = new Set(index.keys());
    // 待推都推完了才清理：没推上去的本人记录还不在目录里，不能当成失权删掉
    if (!状态.待推.length) for (const k of await 库.键们()) if (!allowed.has(k)) { const i = k.indexOf(":"); await 库.删(k.slice(0, i), k.slice(i + 1)); }
    let 拉 = 0;
    const cursors: 同步状态["cursors"] = {};
    const held: 卡住的范围 = {};
    for (const s of scopes) {
      const cur = 状态.cursors[s.id];
      let after = cur && cur.revision >= s.revision ? cur.after : 0;
      // 游标已经到这个范围最新的批次：不发请求（2026-10-21，和电脑端同一条；老服务端不回 head，照旧拉）
      if (typeof s.head === "number" && cur && after >= s.head) { cursors[s.id] = { after, revision: s.revision }; continue; }
      for (;;) {
        const r = await 云("POST", 范围路径, { teamId: c.teamId, action: "pull", scopeId: s.id, after, device: c.device });
        if (r.状态 !== 200) throw new 同步问题(话(r, "拉取失败"));
        const batches = (r.json.batches as 拉到的包[]) ?? [];
        const 收: 改动[] = [];
        let 停在: number | null = null;
        for (const b of batches) {
          try { 收.push(await 验收(b, 全部钥匙(c), c.teamId, index.get(行键(b.meta.t, b.meta.k)), allowed)); }
          catch (e) {
            // 和桌面端一样：这一轮目录里还没有它，范围停在它前面、下一轮再拉（连等几轮还没有才跳过）
            const 等 = e instanceof 范围包未到 ? 还等吗(状态.held, s.id, b.seq) : null;
            if (等) { held[s.id] = 等; 停在 = b.seq; break; }
            if (e instanceof 范围包错误) { 状态.skipped++; continue; }
            throw e;
          }
        }
        if (收.length) 拉 += await 回放(库, 收, c.device, 状态);
        const 到 = 停在 == null ? batches : batches.filter((b) => b.seq < 停在);
        if (到.length) after = 到[到.length - 1].seq;
        cursors[s.id] = { after, revision: s.revision };
        if (停在 != null || !r.json.more || !batches.length) break;
      }
    }
    // 目录里标着删了、本机还在的：补一次删除（没推上去的不动）
    const 待推键 = new Set(状态.待推.map((e) => 行键(e.t, e.k)));
    const 补删: 改动[] = [];
    for (const r of index.values()) if (r.deleted && r.clock && !待推键.has(行键(r.t, r.k)) && (await 库.取(r.t, r.k))) 补删.push({ t: r.t, k: r.k, o: "D", r: null, c: [], h: r.clock });
    if (补删.length) 拉 += await 回放(库, 补删, c.device, 状态, { 含本人: true });
    状态.cursors = cursors;
    状态.held = held;
    状态.lastSyncAt = 状态.lastOkAt = new Date().toISOString();
    状态.lastError = null;
    // 跨成员查重的索引（2026-10-19）：报不上不算这一轮失败，下一轮再报
    await 报查重(c, 云, 库, 状态).catch(() => undefined);
    return { c, 推: p.推, 拉, 拒: p.拒 };
  } catch (e) {
    // 只记「试过」，不动 lastOkAt
    状态.lastSyncAt = new Date().toISOString();
    状态.lastError = e instanceof 同步问题 ? e.message : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    throw e;
  }
}

/* ---------------- 手机上记一笔跟进 ---------------- */

const 类型名: Record<string, string> = { PHONE: "电话沟通", MEETING: "线上会议", VISIT: "上门拜访", EMAIL: "邮件沟通", SMS: "短信沟通", WHATSAPP: "WhatsApp", WECHAT: "微信沟通", TASK: "跟进任务", REMIND: "跟进提醒", OTHER: "其他记录" };
/**
 * 手机上能记的类型（任务 / 提醒走「下次跟进」）。WhatsApp 2026-10-16 加；微信沟通 2026-10-19 加（客户反馈第 3 条），
 * 存 WECHAT，和电脑上 constants.ts 的跟进类型同一个值。还不认识 WECHAT 的电脑照样落库，界面上按「其他记录」的样子显示（同 0.46.20 加 WhatsApp）
 */
export const 手机跟进类型 = ["PHONE", "WHATSAPP", "WECHAT", "SMS", "EMAIL", "MEETING", "VISIT", "OTHER"] as const;

/** 和 Prisma 的 cuid 同一个样子（c + 24 位），只用作主键，不要求真是 cuid 算法 */
export function 新编号(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return "c" + [...b].map((x) => "0123456789abcdefghijklmnopqrstuvwxyz"[x % 36]).join("");
}
const 本地日期 = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export type 记跟进输入 = {
  customerId: string;
  type: (typeof 手机跟进类型)[number];
  content: string;
  /** 下次跟进：给了就新建一条计划 */
  下次?: { 时间: number; 主题: string; 方式: string } | null;
  /** 顺手把这位客户没完成的这条计划标成完成 */
  完成计划?: string | null;
  /**
   * 关联商机 / 订单（2026-10-19 客户反馈第 8 条）：和电脑上那一格同一种值——商机就是商机 id，订单是「订单:<id>」（lib/follow-link.ts）。
   * 商机写进 FollowUp.opportunityId；订单写一行 FollowUpOrder（节点 0，和电脑上跟进挂订单一样）。订单只有外贸模版有
   */
  关联?: string | null;
};

/**
 * 记一笔：和电脑上「记跟进」写同样几样（customers/[id]/actions.ts）——跟进一条、（可选）新计划、（可选）完成旧计划、操作日志。
 * 先放进手机库（马上看得到），再进待推；最近跟进时间是各台自己算的，不同步，这里不写。
 * 时间存成毫秒数：和桌面端库里 DateTime 的存法一样（Prisma 在 SQLite 里存毫秒），推过去原样落库。
 */
export async function 记跟进(c: 手机团队, 库: 手机库, 状态: 同步状态, 输入: 记跟进输入, 现在 = Date.now()): Promise<{ id: string; 领取了?: boolean }> {
  if (!(手机跟进类型 as readonly string[]).includes(输入.type)) throw new 同步问题("跟进类型不对");
  const 内容 = 输入.content.trim();
  if (!内容) throw new 同步问题("写点什么再保存");
  const 客户 = await 库.取("Customer", 输入.customerId);
  if (!客户) throw new 同步问题("这位客户不在这台手机上了，下拉同步一下");
  /*
    公海客户：记跟进 = 领取（2026-10-19 用户拍板，原来手机上一律拦「请先在电脑上领取」，断网时却能记、联网后被拒，两边不一致）。
    和这笔跟进一起排队：先改负责人、记领取、删公海那一行（和电脑上 pool-actions 领取同一个顺序），原负责人没做完的活跟着过来。
    两个人抢同一位，先同步上的拿到；后到的整组被拒，进「没同步上」，原因写「已被 X 先领走」（推 里按服务端回的 taken 说），内容可复制。
    起点快照不在这里补：领之前人人看得到（公海），领到的人本来就有；有需要时老板那台照目录补（client.ts 范围一轮 needBaseline）
  */
  const 公海 = await 库.取("CustomerPool", 输入.customerId);
  const 我 = await 库.取("User", c.userId);
  const 我名 = String(我?.r.name ?? "");
  const 客户名 = String(客户.r.name ?? "");
  // 关联商机 / 订单：只认这位客户名下、这台手机上有的（服务端还会按父链再核一次：跟进、商机 / 订单得在同一位客户下）
  let 商机id: string | null = null, 订单id: string | null = null;
  const 关联 = 输入.关联?.trim();
  if (关联?.startsWith(订单前缀)) {
    if (!外贸订单(await 业务设置(库))) throw new 同步问题("这套模版没有订单，只能关联商机");
    const o = await 库.取("TradeOrder", 关联.slice(订单前缀.length));
    if (!o || o.r.customerId !== 输入.customerId) throw new 同步问题("这张订单不在这位客户名下了，下拉同步一下再选");
    订单id = o.k;
  } else if (关联) {
    const o = await 库.取("Opportunity", 关联);
    if (!o || o.r.customerId !== 输入.customerId) throw new 同步问题("这个商机不在这位客户名下了，下拉同步一下再选");
    商机id = o.k;
  }

  const 编钟 = () => { 状态.钟 = Math.max(现在, 状态.钟 + 1); return 钟串(状态.钟, c.device); };
  const 改: 改动[] = [];
  const 插 = (t: string, r: Record<string, unknown>) => { const h = 编钟(); 改.push({ t, k: String(r[主键表[t]]), o: "I", r, c: Object.keys(r), h }); };
  const 审 = (action: string, entity: string, entityId: string, summary: string, detail?: unknown) =>
    插("AuditLog", { id: 新编号(), at: 现在, userId: c.userId, userName: 我名, action, entity, entityId, summary, detail: detail === undefined ? null : JSON.stringify(detail) });

  if (公海) await 领取改动(c, 库, 客户, 改, 编钟, 审, 现在);

  const id = 新编号();
  插("FollowUp", {
    id, type: 输入.type, title: "", content: 内容, status: "已完成", duration: null, occurredAt: 现在,
    dueAt: null, dueOn: null, dueHasTime: null, participants: null,
    customerId: 输入.customerId, contactId: null, opportunityId: 商机id, ownerId: c.userId, createdAt: 现在, updatedAt: 现在,
  });
  if (订单id) 插("FollowUpOrder", { followUpId: id, orderId: 订单id, nodeIdx: 0 });
  审("create", "FollowUp", id, `记了${客户名}的一条${类型名[输入.type]}跟进（${本地日期(现在)}）`, { 客户: 客户名, 类型: 类型名[输入.type], 状态: "已完成", 内容: 内容.slice(0, 120), 来自: "手机" });
  if (输入.下次) {
    const pid = 新编号();
    插("FollowPlan", {
      id: pid, subject: 输入.下次.主题.trim() || "接着跟进", plannedAt: 输入.下次.时间, plannedOn: 本地日期(输入.下次.时间), plannedHasTime: true,
      method: 输入.下次.方式, done: false, doneAt: null, customerId: 输入.customerId, ownerId: c.userId, createdAt: 现在, updatedAt: 现在,
    });
    审("create", "FollowPlan", pid, `给${客户名}排了跟进计划（${本地日期(输入.下次.时间)} ${输入.下次.方式}·${输入.下次.主题.trim() || "接着跟进"}）`);
  }
  if (输入.完成计划) {
    const 计划 = await 库.取("FollowPlan", 输入.完成计划);
    if (计划 && 计划.r.customerId === 输入.customerId && !计划.r.done) {
      const r = { ...计划.r, done: true, doneAt: 现在, updatedAt: 现在 };
      改.push({ t: "FollowPlan", k: 计划.k, o: "U", r, c: ["done", "doneAt", "updatedAt"], h: 编钟() });
      审("update", "FollowPlan", 计划.k, `完成跟进计划「${String(计划.r.subject ?? "")}」（${客户名}）`);
    }
  }
  await 回放(库, 改, c.device, 状态, { 含本人: true });
  状态.待推.push(...改);
  return { id, ...(公海 ? { 领取了: true } : {}) };
}

/** 领取这一位要写的几样（同电脑上 customers/pool-actions.ts 领取 + lib/carry-over-db.ts 带走）：只往 改 里加，由 记跟进 一起回放、排队 */
async function 领取改动(c: 手机团队, 库: 手机库, 客户: 记录, 改: 改动[], 编钟: () => string, 审: (action: string, entity: string, entityId: string, summary: string, detail?: unknown) => void, 现在: number) {
  const 旧 = String(客户.r.salesOwnerId ?? "");
  const 我 = c.userId;
  const 改一行 = (x: 记录, 新: Record<string, unknown>) => 改.push({ t: x.t, k: x.k, o: "U", r: { ...x.r, ...新 }, c: Object.keys(新), h: 编钟() });
  if (旧 !== 我) 改一行(客户, { salesOwnerId: 我, updatedAt: 现在 });
  const 领 = await 库.取("CustomerClaim", 客户.k);
  if (领) 改一行(领, { userId: 我, at: 现在 });
  else 改.push({ t: "CustomerClaim", k: 客户.k, o: "I", r: { customerId: 客户.k, userId: 我, at: 现在 }, c: ["customerId", "userId", "at"], h: 编钟() });
  改.push({ t: "CustomerPool", k: 客户.k, o: "D", r: null, c: [], h: 编钟() });
  // 原负责人在他身上没做完的活跟着过来：没完成的计划、待办，进行中的商机（别的同事的、做完的不动）
  const 带: string[] = [];
  if (旧 && 旧 !== 我) {
    for (const key of await 库.键们()) {
      const i = key.indexOf(":"); const t = key.slice(0, i);
      if (t !== "FollowPlan" && t !== "Task" && t !== "Opportunity") continue;
      const x = await 库.取(t, key.slice(i + 1));
      if (!x || x.r.customerId !== 客户.k || x.r.ownerId !== 旧) continue;
      if (t === "Opportunity" ? x.r.status !== "OPEN" : !!x.r.done) continue;
      改一行(x, t === "Opportunity" ? { ownerId: 我, updatedAt: 现在, activityAt: x.r.activityAt ?? x.r.updatedAt ?? 现在 } : { ownerId: 我, updatedAt: 现在 });
      带.push(x.k);
    }
  }
  审("claim", "Customer", 客户.k, `从公海领取 1 名客户（${String(客户.r.name ?? "")}，记跟进时领取）`, { ids: [客户.k], 原负责人: [{ id: 客户.k, salesOwnerId: 旧 }], 来自: "手机", 带过来: 带.length });
}

/* ---------------- 手机上新建客户 / 商机（2026-10-19 客户反馈第 7 条） ---------------- */

/**
 * 团队的业务设置（随团队同步下来的 Setting:business）：外贸 / 通用模版、来源选项、本位币、阶段叫法都看它。
 * 还没同步到（第一次同步没完）就按默认的来
 */
export function 读业务(s: 记录 | undefined): BusinessConfig {
  try { return mergeBusiness(s ? (JSON.parse(String(s.r.value ?? "null")) as Partial<BusinessConfig>) : null); } catch { return mergeBusiness(null); }
}
export const 业务行键 = 行键("Setting", BUSINESS_KEY);
async function 业务设置(库: 手机库): Promise<BusinessConfig> {
  return 读业务(await 库.取("Setting", BUSINESS_KEY));
}

/**
 * 和电脑上「新建客户」同一套格子（2026-10-20 用户：名片录入要和新建客户录的信息一致）。
 * school / grade / major 是公司 / 职位 / 行业（外贸模版的叫法，business-config fields）；level 是客户等级 A–D；
 * 跟进状态 / 决策状态不填就是电脑上的默认值（待跟进 / 了解中）
 */
export type 新建客户输入 = {
  name: string; phone?: string; school?: string; grade?: string; major?: string;
  whatsapp?: string; email?: string; country?: string; source?: string; wechat?: string; website?: string; level?: string;
  followStatus?: string; decisionStatus?: string; remark?: string;
};

/** 状态不在取值表里给那句报错（和电脑上 customers/actions.ts 不合法 同一句） */
const 不合法 = (名: string, 表: readonly string[], v: unknown) => (表.includes(v as string) ? null : `${名}「${v}」不是合法取值`);

/** 这台手机上已有的同号 / 同邮箱客户（成员手机只有本人 + 公海；同事名下的，联网时再问服务端：问同事） */
async function 手机上撞的(库: 手机库, phone: string, email: string, wechat = ""): Promise<string | null> {
  const 号 = phone ? 号键(phone) : "";
  const 邮 = email.trim().toLowerCase();
  const 微 = wechat.trim().toLowerCase();
  for (const key of await 库.键们()) {
    if (!key.startsWith("Customer:")) continue;
    const x = await 库.取("Customer", key.slice("Customer:".length));
    if (!x) continue;
    if (号 && String(x.r.phone ?? "") && 号键(String(x.r.phone)) === 号) return `手机号 ${phone} 已经有了：${String(x.r.name ?? "")}`;
    if (邮 && !phone) {
      const 额 = await 库.取("CustomerExtra", x.k);
      if (!x.r.phone && String(额?.r.email ?? "").trim().toLowerCase() === 邮) return `邮箱 ${email.trim()} 已经有了：${String(x.r.name ?? "")}`;
    }
    if (微 && !phone && !邮) {
      const 额 = await 库.取("CustomerExtra", x.k);
      if (!x.r.phone && !String(额?.r.email ?? "").trim() && String(额?.r.wechat ?? "").trim().toLowerCase() === 微) return `微信 ${wechat.trim()} 已经有了：${String(x.r.name ?? "")}`;
    }
  }
  return null;
}

/**
 * 新建客户：和电脑上 saveCustomer 新建那一支同一套规矩（customers/actions.ts），只收手机上摆的几格。
 *   - 名字必填；外贸：电话、WhatsApp、邮箱、微信至少一个（没电话就拿 WhatsApp 当电话认人，再没有按邮箱、微信认）；通用：电话必填
 *   - 公司 / 职位 / 行业 / 客户等级 / 两个状态和电脑上存的是同一些列，取值表也一样（状态不在表里不收）
 *   - 归本人（salesOwnerId = 本人）——服务端的范围规则只许成员建自己名下的客户
 *   - 写客户一行、（外贸填了才有）外贸档案一行、操作日志一条，先进手机库再进待推
 * 推荐人、渠道这些通用模版的东西手机上不问，空着（电脑上照样能补）
 */
export async function 新建客户(c: 手机团队, 库: 手机库, 状态: 同步状态, 输入: 新建客户输入, 现在 = Date.now(), 云?: 传输): Promise<{ id: string }> {
  if (!hasVisibleText(输入.name)) throw new 同步问题("请填写名字");
  const b = await 业务设置(库);
  const 外贸 = b.template === "trade";
  const 档案: Partial<外贸档案> = {};
  if (外贸) {
    for (const k of ["whatsapp", "email", "source", "wechat", "website", "level"] as const) {
      const r = 规整外贸格(k, 输入[k]);
      if (!r.ok) throw new 同步问题(r.error);
      if (r.v) 档案[k] = r.v;
    }
    const 国 = 认国家(输入.country);
    if (国) { const r = 规整外贸格("country", 国); if (!r.ok) throw new 同步问题(r.error); if (r.v) 档案.country = r.v; }
  }
  const 填的电话 = !String(输入.phone ?? "").trim() && 外贸 && 档案.whatsapp ? 档案.whatsapp : 输入.phone;
  const 按邮箱认 = 外贸 && !String(填的电话 ?? "").trim() && Boolean(档案.email);
  const 按微信认 = 外贸 && !String(填的电话 ?? "").trim() && !档案.email && Boolean(档案.wechat);
  const 电话 = 查电话(填的电话, { 必填: !按邮箱认 && !按微信认 });
  // 报错一字不差照抄电脑上的 saveCustomer
  if (!电话.ok) throw new 同步问题(外贸 && !String(填的电话 ?? "").trim() ? "电话 / WhatsApp / 邮箱 / 微信至少填一个（没有电话就用它认人）" : 电话.error);
  const 状态错 = 不合法("跟进状态", FOLLOW_STATUSES, 输入.followStatus ?? "待跟进") ?? 不合法("决策状态", DECISION_STATUSES, 输入.decisionStatus ?? "了解中");
  if (状态错) throw new 同步问题(状态错);
  const 撞 = await 手机上撞的(库, 电话.phone, 按邮箱认 ? String(档案.email) : "", 按微信认 ? String(档案.wechat) : "");
  if (撞) throw new 同步问题(撞);
  // 联网时再问一下服务端是不是同事名下的（2026-10-19 跨成员查重）；断网、超时当没撞，照样建（老板那台「疑似重复」兜底）
  if (云) {
    const 问的: [查重种类, string, string] | null = 电话.phone ? ["phone", 电话.phone, `手机号 ${电话.phone}`]
      : 按邮箱认 ? ["email", String(档案.email), `邮箱 ${String(档案.email)}`]
      : 按微信认 ? ["wechat", String(档案.wechat), `微信 ${String(档案.wechat)}`]
      : null;
    const 同事 = 问的 && (await 问同事(c, 云, 库, 问的[0], 问的[1]));
    if (同事 && 问的) throw new 同步问题(同事撞号说法(问的[2], 同事.同事, 同事.客户名, b.customer));
  }

  const 我 = await 库.取("User", c.userId);
  const 我名 = String(我?.r.name ?? "");
  const 编钟 = () => { 状态.钟 = Math.max(现在, 状态.钟 + 1); return 钟串(状态.钟, c.device); };
  const 改: 改动[] = [];
  const 插 = (t: string, r: Record<string, unknown>) => { const h = 编钟(); 改.push({ t, k: String(r[主键表[t]]), o: "I", r, c: Object.keys(r), h }); };

  const id = 新编号();
  const name = 输入.name.trim();
  // 扫名片把多出来的行都放进备注：截到 2000 字，认崩的名片别塞一大段乱码
  const remark = String(输入.remark ?? "").trim().slice(0, 2000) || null;
  // 公司 / 职位 / 行业：电脑上是 trim 以后空的存 null；手机这头再截个长度，认崩的名片别塞一长串
  const 格 = (v: string | undefined) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  插("Customer", {
    id, name, phone: 电话.phone, school: 格(输入.school), grade: 格(输入.grade), major: 格(输入.major),
    channelId: null, referrerCustomerId: null, attributionChannelId: null, attributionCustomerId: null,
    salesOwnerId: c.userId, channelOwnerId: null, followStatus: 输入.followStatus ?? "待跟进", decisionStatus: 输入.decisionStatus ?? "了解中",
    expectedSignAt: null, expectedSignOn: null, remark, createdAt: 现在, updatedAt: 现在,
  });
  if (Object.keys(档案).length) {
    插("CustomerExtra", { customerId: id, country: null, whatsapp: null, wechat: null, email: null, source: null, level: null, website: null, ...档案 });
  }
  插("AuditLog", { id: 新编号(), at: 现在, userId: c.userId, userName: 我名, action: "create", entity: "Customer", entityId: id, summary: `新建${b.customer}「${name}」`, detail: JSON.stringify({ 来自: "手机" }) });
  await 回放(库, 改, c.device, 状态, { 含本人: true });
  状态.待推.push(...改);
  return { id };
}

/** 手机上能选的商机阶段：不含「赢单成交」——赢单要登记签约 / 转订单，留在电脑上做 */
export const 手机商机阶段 = OPP_STAGES.filter((s) => s !== "赢单成交");

export type 新建商机输入 = { customerId: string; name: string; amount: number; stage: string };

/**
 * 新建商机：和电脑上 saveOpportunity 新建那一支同一套（opportunities/actions.ts）——商机一行、币种一行（团队本位币）、操作日志一条。
 * 归本人；只能挂在这台手机上看得到、不在公海里的客户下（成员的手机上就是本人名下的，服务端再按归属把关）
 */
export async function 新建商机(c: 手机团队, 库: 手机库, 状态: 同步状态, 输入: 新建商机输入, 现在 = Date.now()): Promise<{ id: string }> {
  if (!hasVisibleText(输入.name)) throw new 同步问题("请填写商机名称");
  if (!Number.isFinite(输入.amount) || 输入.amount < 0) throw new 同步问题("商机金额不能为负数");
  if (!(手机商机阶段 as readonly string[]).includes(输入.stage)) throw new 同步问题("商机阶段不对");
  const 客户 = await 库.取("Customer", 输入.customerId);
  if (!客户) throw new 同步问题("这位客户不在这台手机上了，下拉同步一下");
  if (await 库.取("CustomerPool", 输入.customerId)) throw new 同步问题("公海客户请先领取：记一笔跟进就领过来，再建商机");
  const b = await 业务设置(库);
  const 币 = 规整币种(b.currency);
  const 我 = await 库.取("User", c.userId);
  const 我名 = String(我?.r.name ?? "");
  const 编钟 = () => { 状态.钟 = Math.max(现在, 状态.钟 + 1); return 钟串(状态.钟, c.device); };
  const 改: 改动[] = [];
  const 插 = (t: string, r: Record<string, unknown>) => { const h = 编钟(); 改.push({ t, k: String(r[主键表[t]]), o: "I", r, c: Object.keys(r), h }); };

  const id = 新编号();
  const name = 输入.name.trim();
  const amount = Math.round(输入.amount * 100) / 100;
  const probability = STAGE_PROBABILITY[输入.stage] ?? 20;
  插("Opportunity", {
    id, name, amount, stage: 输入.stage, status: "OPEN", probability, expectedDealAt: null, remark: null,
    customerId: 输入.customerId, ownerId: c.userId, createdAt: 现在, updatedAt: 现在, activityAt: 现在,
  });
  插("OpportunityMoney", { opportunityId: id, currency: 币 });
  插("AuditLog", {
    id: 新编号(), at: 现在, userId: c.userId, userName: 我名, action: "create", entity: "Opportunity", entityId: id,
    summary: `新建商机「${name}」：${输入.stage} · ${显示金额(amount, 币)}`,
    detail: JSON.stringify({ 名称: name, 金额: amount, 币种: 币, 阶段: 输入.stage, 状态: "进行中", 概率: probability, 来自: "手机" }),
  });
  await 回放(库, 改, c.device, 状态, { 含本人: true });
  状态.待推.push(...改);
  return { id };
}

/* ---------------- 跨成员查重（2026-10-19，规则见 lib/sync/dedupe.ts） ---------------- */

async function 查重哈希们(c: 手机团队, 值: { phone?: unknown; email?: unknown; wechat?: unknown }): Promise<string[]> {
  const 出: string[] = [];
  for (const { 种, 键 } of 客户查重值({ phone: String(值.phone ?? ""), email: String(值.email ?? ""), wechat: String(值.wechat ?? "") })) 出.push(await 密.查重哈希(c.key, 查重原文(c.teamId, 种, 键)));
  return 出;
}

/** 把手机库里客户的查重索引报上去（只报指纹变了的；服务端没收的下一轮再报）。和电脑那边 sync/dedupe-client.ts 报查重 同一套 */
export async function 报查重(c: 手机团队, 云: 传输, 库: 手机库, 状态: 同步状态): Promise<number> {
  const 旧 = 状态.查重 ?? {};
  const 新: Record<string, string> = {};
  const 要报: { e: 查重条目; 指纹: string }[] = [];
  for (const key of await 库.键们()) {
    if (!key.startsWith("Customer:")) continue;
    const x = await 库.取("Customer", key.slice("Customer:".length));
    if (!x) continue;
    const 额 = await 库.取("CustomerExtra", x.k);
    const hashes = await 查重哈希们(c, { phone: x.r.phone, email: 额?.r.email, wechat: 额?.r.wechat });
    const 名 = String(x.r.name ?? "");
    const 指纹 = 查重指纹(c.epoch, hashes, 名);
    if (旧[x.k] === 指纹) { 新[x.k] = 指纹; continue; }
    要报.push({ e: { k: x.k, epoch: c.epoch, hashes, label: await 密.封(名, c.key, c.epoch, 查重标签绑定(c.teamId)) }, 指纹 });
  }
  let 报 = 0;
  for (let i = 0; i < 要报.length; i += 查重单次上限) {
    const 段 = 要报.slice(i, i + 查重单次上限);
    const r = await 云("POST", 范围路径, { teamId: c.teamId, action: "dedupe-put", device: c.device, entries: 段.map((x) => x.e) });
    if (r.状态 !== 200) break;
    const 没收 = new Set(Array.isArray(r.json.skipped) ? (r.json.skipped as string[]) : []);
    for (const x of 段) if (!没收.has(x.e.k)) { 新[x.e.k] = x.指纹; 报++; }
  }
  状态.查重 = 新;
  return 报;
}

/** 录入前问服务端：这个号码 / 邮箱是不是同事名下的客户。断网、超时（3 秒）、服务端旧都当没撞 */
export async function 问同事(c: 手机团队, 云: 传输, 库: 手机库, 种: 查重种类, 值: string): Promise<{ 同事: string; 客户名: string } | null> {
  const 键 = 查重键(种, 值);
  if (!键) return null;
  try {
    const r = await Promise.race([
      密.查重哈希(c.key, 查重原文(c.teamId, 种, 键)).then((h) => 云("POST", 范围路径, { teamId: c.teamId, action: "dedupe-find", hashes: [h] })),
      new Promise<null>((ok) => setTimeout(() => ok(null), 3000)),
    ]);
    if (!r || r.状态 !== 200 || !Array.isArray(r.json.hits)) return null;
    for (const h of r.json.hits as 查重命中[]) {
      if (!h || typeof h.k !== "string" || (await 库.取("Customer", h.k))) continue;
      const 人 = h.owner ? await 库.取("User", h.owner) : undefined;
      let 客户名 = "";
      try { 客户名 = String((await 密.拆<string>(h.label, 全部钥匙(c), 查重标签绑定(c.teamId))) ?? ""); } catch { /* 解不开只说同事 */ }
      return { 同事: String(人?.r.name ?? "") || "同事", 客户名 };
    }
    return null;
  } catch {
    return null;
  }
}
