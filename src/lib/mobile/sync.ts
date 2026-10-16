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
 *   - 不做的：老板迁移、补发起点、改归属（手机第一版不领取公海、不改负责人——这些会牵动「起点」，留在电脑上做）
 *   - 手机只写这几张表：FollowUp、FollowPlan、AuditLog（记一笔跟进时电脑上写的也就是这几样，见 customers/[id]/actions.ts）
 */
import { 提取范围, 核对范围, 行键, 范围父表, type 范围索引, type 范围元数据 } from "@/lib/sync/scope-policy";
import { 同步表, 不同步列 } from "@/lib/sync/tables";
import { 归一化范围行, 主键表 } from "@/lib/sync/scoped-pure";
import { 规范串 } from "@/lib/sync/canon";
import * as 密 from "@/lib/sync/crypto-web";
import type { 改动 } from "@/lib/sync/local";

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
  /** 上一次「试着同步」的时间：成功、出错都记 */
  lastSyncAt?: string;
  /**
   * 上一次同步成功的时间（2026-10-15 起才有）。只在成功时写：团队到期被拒时不能拿出错的时间冒充「已同步 · 刚才」。
   * 之前存下的老状态没有这一项，读法见 上次成功()
   */
  lastOkAt?: string;
  lastError?: string | null;
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
  if (!current || !allowed.has(key)) throw new 范围包错误("该记录不在本机同步范围内");
  const e = 归一化范围行(inner.change, current, allowed);
  if (e.o !== "D" && e.r) for (const [field, table] of Object.entries(范围父表[e.t] ?? {})) {
    const v = e.r[field];
    if (v != null && !allowed.has(行键(table, String(v)))) throw new 范围包错误(`关联的${table}不在本机同步范围内`);
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
export async function 推(c0: 手机团队, 云: 传输, 状态: 同步状态): Promise<{ c: 手机团队; 推: number; 拒: number }> {
  let c = c0, 推 = 0, 拒 = 0, 换钥 = 0, 重来 = 0;
  while (状态.待推.length) {
    const 这批 = 状态.待推.slice(0, 100);
    const packets = await Promise.all(这批.map((e) => 做包(c, e)));
    const r = await 云("POST", 范围路径, { teamId: c.teamId, action: "push", device: c.device, packets });
    if (r.状态 === 409 && /换过钥匙/.test(String(r.json.error ?? "")) && 换钥++ < 3) { c = await 更新钥匙(c, 云); continue; }
    if (r.状态 === 403 && Array.isArray(r.json.denied) && 重来++ < 50) {
      const denied = new Set((r.json.denied as unknown[]).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < 这批.length));
      if (denied.size) {
        for (const i of denied) 状态.被拒.push({ 改动: 这批[i], 原因: "这位客户已经不归你了，这条没同步上" });
        拒 += denied.size;
        /*
          被拒那几条的操作日志（「记了 XX 的一条跟进」）也不推：操作日志按它说的那条记录算归属，那条没落下就算成本人的，
          服务端照收——老板的操作日志里写着记了一条跟进，跟进却不在（2026-10-16 团队版全面检验）。一起挪进被拒，界面只列跟进
        */
        const 被拒的 = new Set([...denied].map((i) => 行键(这批[i].t, 这批[i].k)));
        const 跟着拒 = (e: 改动) => e.t === "AuditLog" && !!e.r && 被拒的.has(行键(String(e.r.entity ?? ""), String(e.r.entityId ?? "")));
        const 剩 = [...这批.filter((_, i) => !denied.has(i)), ...状态.待推.slice(这批.length)];
        for (const e of 剩.filter(跟着拒)) 状态.被拒.push({ 改动: e, 原因: "这位客户已经不归你了，这条没同步上" });
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
    const p = await 推(c, 云, 状态);
    c = p.c;
    const d = await 云("POST", 范围路径, { teamId: c.teamId, action: "directory", device: c.device });
    if (d.状态 !== 200) throw new 同步问题(话(d, "取不到同步目录"));
    if (Number(d.json.epoch ?? 0) > c.epoch) c = await 更新钥匙(c, 云);
    // 「团队」范围（成员、设置）先拉，和桌面端一样
    const scopes = ((d.json.scopes as { id: string; revision: number; records: 范围索引[] }[]) ?? []).sort((a, b) => Number(b.id === "team") - Number(a.id === "team"));
    const index = new Map<string, 范围索引>();
    for (const s of scopes) for (const r of s.records) index.set(行键(r.t, r.k), r);
    const allowed = new Set(index.keys());
    // 待推都推完了才清理：没推上去的本人记录还不在目录里，不能当成失权删掉
    if (!状态.待推.length) for (const k of await 库.键们()) if (!allowed.has(k)) { const i = k.indexOf(":"); await 库.删(k.slice(0, i), k.slice(i + 1)); }
    let 拉 = 0;
    const cursors: 同步状态["cursors"] = {};
    for (const s of scopes) {
      const cur = 状态.cursors[s.id];
      let after = cur && cur.revision >= s.revision ? cur.after : 0;
      for (;;) {
        const r = await 云("POST", 范围路径, { teamId: c.teamId, action: "pull", scopeId: s.id, after, device: c.device });
        if (r.状态 !== 200) throw new 同步问题(话(r, "拉取失败"));
        const batches = (r.json.batches as 拉到的包[]) ?? [];
        const 收: 改动[] = [];
        for (const b of batches) {
          try { 收.push(await 验收(b, 全部钥匙(c), c.teamId, index.get(行键(b.meta.t, b.meta.k)), allowed)); }
          catch (e) { if (e instanceof 范围包错误) { 状态.skipped++; continue; } throw e; }
        }
        if (收.length) 拉 += await 回放(库, 收, c.device, 状态);
        if (batches.length) after = batches[batches.length - 1].seq;
        cursors[s.id] = { after, revision: s.revision };
        if (!r.json.more || !batches.length) break;
      }
    }
    // 目录里标着删了、本机还在的：补一次删除（没推上去的不动）
    const 待推键 = new Set(状态.待推.map((e) => 行键(e.t, e.k)));
    const 补删: 改动[] = [];
    for (const r of index.values()) if (r.deleted && r.clock && !待推键.has(行键(r.t, r.k)) && (await 库.取(r.t, r.k))) 补删.push({ t: r.t, k: r.k, o: "D", r: null, c: [], h: r.clock });
    if (补删.length) 拉 += await 回放(库, 补删, c.device, 状态, { 含本人: true });
    状态.cursors = cursors;
    状态.lastSyncAt = 状态.lastOkAt = new Date().toISOString();
    状态.lastError = null;
    return { c, 推: p.推, 拉, 拒: p.拒 };
  } catch (e) {
    // 只记「试过」，不动 lastOkAt
    状态.lastSyncAt = new Date().toISOString();
    状态.lastError = e instanceof 同步问题 ? e.message : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    throw e;
  }
}

/* ---------------- 手机上记一笔跟进 ---------------- */

const 类型名: Record<string, string> = { PHONE: "电话沟通", MEETING: "线上会议", VISIT: "上门拜访", EMAIL: "邮件沟通", SMS: "短信沟通", WHATSAPP: "WhatsApp", TASK: "跟进任务", REMIND: "跟进提醒", OTHER: "其他记录" };
/** 手机上能记的类型（任务 / 提醒走「下次跟进」）。WhatsApp 2026-10-16 加 */
export const 手机跟进类型 = ["PHONE", "WHATSAPP", "SMS", "EMAIL", "MEETING", "VISIT", "OTHER"] as const;

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
};

/**
 * 记一笔：和电脑上「记跟进」写同样几样（customers/[id]/actions.ts）——跟进一条、（可选）新计划、（可选）完成旧计划、操作日志。
 * 先放进手机库（马上看得到），再进待推；最近跟进时间是各台自己算的，不同步，这里不写。
 * 时间存成毫秒数：和桌面端库里 DateTime 的存法一样（Prisma 在 SQLite 里存毫秒），推过去原样落库。
 */
export async function 记跟进(c: 手机团队, 库: 手机库, 状态: 同步状态, 输入: 记跟进输入, 现在 = Date.now()): Promise<{ id: string }> {
  if (!(手机跟进类型 as readonly string[]).includes(输入.type)) throw new 同步问题("跟进类型不对");
  const 内容 = 输入.content.trim();
  if (!内容) throw new 同步问题("写点什么再保存");
  const 客户 = await 库.取("Customer", 输入.customerId);
  if (!客户) throw new 同步问题("这位客户不在这台手机上了，下拉同步一下");
  // 公海客户要先领取（改归属）才能记——领取牵动「起点」，手机第一版不做，留在电脑上。其余有没有权限由服务端按归属判
  if (await 库.取("CustomerPool", 输入.customerId)) throw new 同步问题("公海客户请先在电脑上领取");
  const 我 = await 库.取("User", c.userId);
  const 我名 = String(我?.r.name ?? "");
  const 客户名 = String(客户.r.name ?? "");

  const 编钟 = () => { 状态.钟 = Math.max(现在, 状态.钟 + 1); return 钟串(状态.钟, c.device); };
  const 改: 改动[] = [];
  const 插 = (t: string, r: Record<string, unknown>) => { const h = 编钟(); 改.push({ t, k: String(r[主键表[t]]), o: "I", r, c: Object.keys(r), h }); };
  const 审 = (action: string, entity: string, entityId: string, summary: string, detail?: unknown) =>
    插("AuditLog", { id: 新编号(), at: 现在, userId: c.userId, userName: 我名, action, entity, entityId, summary, detail: detail === undefined ? null : JSON.stringify(detail) });

  const id = 新编号();
  插("FollowUp", {
    id, type: 输入.type, title: "", content: 内容, status: "已完成", duration: null, occurredAt: 现在,
    dueAt: null, dueOn: null, dueHasTime: null, participants: null,
    customerId: 输入.customerId, contactId: null, opportunityId: null, ownerId: c.userId, createdAt: 现在, updatedAt: 现在,
  });
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
  return { id };
}
