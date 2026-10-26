/**
 * 团队版的权限（2026-10-04 用户：「做最极简的权限，老板和业务员即可」；业务员只看自己的 + 公海。2026-10-20 加一档业务主管）。
 *
 *   - **老板** = 建团队的人（中转那边的 owner），本机 User.role = ADMIN：看全部、管成员、改业务配置
 *   - **业务主管** = 老板在设置 → 团队里设的（中转 role = manager），本机 User.role = MANAGER：「看全部，不管人」——
 *     全队客户和跟进都看得到、能改（分配、指派公海、合并重复），不受互看开关影响；这里不限定。
 *     加人、移除、邀请码、互看开关、业务配置、设别人的角色都不归他（界面不给 + 中继拒）
 *   - **业务员** = 其余成员，本机 User.role = SALES：只看自己负责的客户（销售负责人或渠道负责人是自己）和公海里的客户，
 *     以及这些客户的跟进、商机、签约、联系人、计划；操作日志只看自己的
 *
 * 角色不同步（lib/sync/tables.ts 不同步列 User.role），每台按中转的成员名单自己对（lib/sync/client.ts 对齐角色），
 * 谁也不能在自己电脑上把自己改成老板再同步给别人。
 *
 * 拦在 Prisma 这一层（lib/prisma.ts 的 $extends），不在一个个页面里加：读的地方有上百处——列表、详情、搜索、
 * 首页、数据页、AI 的工具、MCP、导出——漏一处就是业务员看到了别人的客户。
 * 只管桌面端本地模式：桌面端的本地服务只有这台电脑的主人一个人在用，「我」是谁不用按请求去认。
 *
 * 端侧隔离分两档（2026-10-13 更新，Sam F2 证据：旧协议下业务员 crm.db 里有老板私客）：
 *   - 旧协议（团队未迁移）：全队复制，这里只是界面/AI 层的过滤，直接打开库文件仍看得到同事的客户；
 *   - v4 范围同步（lib/sync/client.ts 范围一轮，老板迁移完成后）：服务端按归属只下发本人 + 公海的密文，
 *     业务员本机每轮清掉失权副本（lib/sync/scoped-local.ts 清理失权副本）。这里的过滤仍保留，作为第二道防线。
 *   升级前已落到旧设备、手工备份、AI 历史里的资料技术上收不回；对外说法照这个说。
 *
 * 同步自己（推、拉、回放、改身份）和查重要看全部：包在 看全部() 里。
 *
 * **互看**（2026-10-20，客户需求）：老板在设置 → 团队里打开「同事之间互相看得到客户」（存在中继，每轮同步写进 .team.json）。
 * 开着时业务员**读**不再限定客户（列表、详情、搜索、首页、AI 工具、MCP、导出跟着放开，服务端也把全队客户范围下发给他）；
 * **改、删**照旧只限自己的 + 公海；同事的客户下面只许新建跟进（scope-policy 互看可加，服务端同一份规矩）。
 * 未归属联系人、没挂客户的线索、操作日志照旧只看自己的。关掉后服务端目录里没了同事的客户，本机清理失权副本删掉。
 *
 * **企业版**（2026-10-24，私有部署网页）：「按组织架构看客户」规则开着时也走这一层，范围由 lib/enterprise/visibility.ts 按请求算——
 * 我 是一组人（自己 + 实线下属），读 比 我 多出虚线下属那几位；他们的客户只能看，下面什么都不能建（全拦）。
 */
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@/generated/prisma";
import { 读 as 读云端凭据 } from "./desktop/cloud";
import { 团队身份id } from "./desktop/me";
import { 互看可加, 范围父表 } from "./sync/scope-policy";
import { 企业版 } from "./enterprise/switch";

const 不限 = new AsyncLocalStorage<true>();

/** 这一段里的查询不加限定（同步、查重、角色对齐） */
export function 看全部<T>(fn: () => Promise<T>): Promise<T> {
  // 在 run 里 await：Prisma 的查询是懒的，拿到 then 才真正发出去——不 await 就跑到 run 外面去了
  return 不限.run(true, async () => await fn());
}

/** 限定成谁：团队版是一个人的 id；企业版是一组人（自己 + 实线下属） */
export type 谁 = string | readonly string[];
const 等于 = (w: 谁) => (typeof w === "string" ? w : { in: [...w] });

/**
 * 我：业务员本机的 id（老板等 = null）；互看：团队开了同事互看；别人的：只能看的客户（互看时同事负责、不在公海的；
 * 企业版是虚线下属的），拦在它们下面新建。
 * 企业版另有：读 = 看得到谁的客户（比 我 多出虚线下属）；全拦 = 只能看的客户下面跟进也不许建；话 = 挡下时给人看的那句；
 * 线索全看 = 线索不限定（市场管理开着线索分配时要看、要分全部线索，F9 10-25），客户那条线照旧
 */
export type 限定 = { 我: 谁 | null; 互看: boolean; 别人的: ReadonlySet<string>; 读?: 谁; 全拦?: boolean; 话?: string; 线索全看?: boolean };
const 不限定: 限定 = { 我: null, 互看: false, 别人的: new Set() };
const g = globalThis as unknown as { __限定?: 限定 & { 到: number }; __限定刷新?: Promise<限定> };

/** 角色刚对过 / 刚进出团队：别等缓存过期 */
export function 忘掉限定() {
  g.__限定 = undefined;
  g.__限定刷新 = undefined;
}

function 在团队(): boolean {
  const dir = process.env.CRM_DATA_DIR;
  return !!dir && fs.existsSync(path.join(dir, ".team.json"));
}

/** .team.json 里记的互看开关（lib/sync/client.ts 记互看）。读不出 = 关 */
function 团队开了互看(): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CRM_DATA_DIR ?? "", ".team.json"), "utf8")).互看 === true;
  } catch {
    return false;
  }
}

/**
 * 现在要不要限定、限定成谁：业务员返回本机我的 id，其余（老板、没进团队、网页版、托管版）返回 null。
 * 缓存 3 秒：每条查询都会问一次，不能每次都读库。
 *
 * **到期了先用旧的、后台再认一次**（2026-10-08 发版前审查）：这一句常常落在交互式事务里，
 * 而 SQLite 只开一个连接（lib/sqlite-url.ts）——拿 db 现查要等事务自己放连接，5 秒后事务超时、保存报错。
 * 后台那一查排在事务后面，事务提交了它才跑。忘掉限定() 清空后的那一次仍现查（进出团队、角色刚对过要马上生效），
 * 那是一个请求的第一句查询，在事务外面。
 */
export async function 限定的我(db: PrismaClient): Promise<谁 | null> {
  return (await 现在的限定(db)).我;
}

/**
 * 「看得到哪些客户」用的我（2026-10-20 互看）：开了互看 = null（全队都看得到），否则同 限定的我。
 * 查重、比价这些「看全部取回来再按 看得到() 筛」的地方用它；判「能不能改」照旧用 限定的我
 */
export async function 读的我(db: PrismaClient): Promise<谁 | null> {
  const x = await 现在的限定(db);
  return x.读 ?? (x.互看 ? null : x.我);
}

/**
 * 这位客户只能看、不能改：「加跟进」= 团队版互看时同事负责、不在公海的（还能加跟进）；
 * 「全」= 企业版虚线下属的（跟进也不能加）。老板、没进团队、自己的、公海的都是 false
 */
export async function 只读客户(db: PrismaClient, c: { salesOwnerId: string | null; channelOwnerId?: string | null; pool?: unknown }): Promise<false | "加跟进" | "全"> {
  const { 我, 互看, 读 } = await 现在的限定(db);
  if (!我 || 看得到(c, 我)) return false;
  if (读) return "全";
  return 互看 ? "加跟进" : false;
}

/** 按编号认「这是同事的客户」（互看时只读）：用缓存里的名单，不现查。保存、改一格之前先问，给人话而不是等数据库回找不到 */
export async function 同事的客户(db: PrismaClient, id: string): Promise<boolean> {
  const x = await 现在的限定(db);
  return (x.互看 || !!x.读) && x.别人的.has(id);
}

/** 只读客户被挡时那一句：企业版虚线下属用 虚线只读话，团队版互看用 只读错误 的默认话 */
export async function 只读话(db: PrismaClient): Promise<string> {
  return (await 现在的限定(db)).话 ?? new 只读错误().message;
}

/**
 * 企业版虚线下属的客户（只能看，全拦）里，这一批中了哪几位。批量改、删之前先问：
 * 不问的话限定层把它们静静滤掉，界面上报「已不存在 / 已经在别处删掉了」，原因说错（10-25 实测 F4）。
 * 团队版互看不走这里，照原样
 */
export async function 虚线只读的(db: PrismaClient, ids: string[]): Promise<string[]> {
  const x = await 现在的限定(db);
  return x.全拦 ? ids.filter((id) => x.别人的.has(id)) : [];
}

/** 选中的里有虚线下属的客户：挡下时给人看的那句；没有回 null */
export async function 虚线只读挡(db: PrismaClient, ids: string[]): Promise<string | null> {
  const 中 = await 虚线只读的(db, ids);
  if (!中.length) return null;
  const 话 = (await 现在的限定(db)).话 ?? "";
  return ids.length === 1 ? 话 : `选中的有 ${中.length} 位是虚线下属的客户：只能看，不能改、不能转、不能删。去掉${中.length > 1 ? "这几位" : "这位"}再试`;
}

async function 现在的限定(db: PrismaClient): Promise<限定> {
  if (不限.getStore()) return 不限定;
  if (process.env.DESKTOP_LOCAL !== "1") {
    if (!企业版()) return 不限定;
    return (await (await import("./enterprise/visibility")).企业版范围(db)) ?? 不限定;
  }
  // 文件丢失不能等缓存到期，更不能把「认不出我」解释成老板。
  if (在团队() && !读云端凭据()?.accountId) throw new Error("团队身份缺失，请重新登录");
  const 现 = g.__限定;
  if (现 && 现.到 > Date.now()) return 现;
  if (现) {
    void 认一次(db).catch(() => {});
    return 现;
  }
  return 认一次(db);
}

function 认一次(db: PrismaClient): Promise<限定> {
  if (g.__限定刷新) return g.__限定刷新;
  const 票 = { p: undefined as Promise<限定> | undefined };
  const 是这次 = () => g.__限定刷新 === 票.p;
  票.p = (async () => {
    await Promise.resolve(); // 让 票.p 先挂上，下面的「是这次」才认得出
    let 我: string | null = null;
    let 互看 = false;
    let 别人的: ReadonlySet<string> = 不限定.别人的;
    if (在团队()) {
      const 账号 = 读云端凭据()?.accountId;
      if (账号) {
        const u = await 不限.run(true, () => db.user.findUnique({ where: { id: 团队身份id(账号) }, select: { id: true, role: true, active: true } }));
        if (!u || !u.active) throw new Error("团队身份不存在或已停用，请重新登录");
        if (u.role !== "ADMIN" && u.role !== "MANAGER") 我 = u.id;
      }
      // 只拿编号：钩子里不能现查（SQLite 只开一个连接，交互式事务里再查会等到事务超时），新建前按这份判
      if (我 && 团队开了互看()) {
        互看 = true;
        const 我的 = 我;
        // 不用 where NOT(可见客户)：channelOwnerId 是 NULL 时 SQL 里 NOT(… OR NULL …) 算不出真，同事的客户一个都捞不到
        const 全部 = await 不限.run(true, () => db.customer.findMany({ select: { id: true, salesOwnerId: true, channelOwnerId: true, pool: { select: { customerId: true } } } }));
        别人的 = new Set(全部.filter((c) => !看得到(c, 我的)).map((c) => c.id));
      }
    }
    const 新: 限定 = { 我, 互看, 别人的 };
    // 认的过程中被忘掉过（刚进出团队 / 角色刚对过）：这次的结果可能是旧的，不写，下一句再认
    if (是这次()) g.__限定 = { ...新, 到: Date.now() + 3000 };
    return 新;
  })()
    .catch((e) => {
      console.warn("[team-scope] 认不出我：", e?.message ?? e);
      // 有旧的用旧的；一次都没认出来就让这句查询报错——不能悄悄当成「不限定」，业务员会看到全队
      // 只有旧的业务员限定可继续使用；旧的「不限」不能作为身份失败时的退路。
      if (g.__限定?.我 && !/身份不存在或已停用/.test(String(e?.message))) return g.__限定;
      g.__限定 = undefined;
      throw e;
    })
    .finally(() => {
      if (是这次()) g.__限定刷新 = undefined;
    });
  g.__限定刷新 = 票.p;
  return 票.p;
}

/** 业务员看得到的客户：自己是销售负责人或渠道负责人，或者在公海里（企业版：负责人是这组人里的一位） */
export const 可见客户 = (我: 谁) => ({ OR: [{ salesOwnerId: 等于(我) }, { channelOwnerId: 等于(我) }, { pool: { isNot: null } }] });

/** 一位客户业务员看不看得到（查重时看全部取回来的行，再按这个判） */
export function 看得到(c: { salesOwnerId: string | null; channelOwnerId?: string | null; pool?: unknown }, 我: 谁 | null): boolean {
  if (!我) return true;
  const 是 = (x: string | null | undefined) => !!x && (typeof 我 === "string" ? x === 我 : 我.includes(x));
  return 是(c.salesOwnerId) || 是(c.channelOwnerId) || !!c.pool;
}

/**
 * 每个要限定的模型加的那一句 where。互看读 = 开了互看时的读（查、数、汇总）：客户这条线不再限定，
 * 计划 / 待办都挂在客户上、全放开；线索只放开挂了客户的；未归属联系人、操作日志照旧只看自己的
 */
export function 限定条件(model: string, 谁们: 谁, 互看读 = false): Record<string, unknown> | null {
  const 我 = 等于(谁们);
  if (互看读) {
    switch (model) {
      case "Lead":
        return { OR: [{ ownerId: 我 }, { customerId: { not: null } }] };
      case "AuditLog":
        return { userId: 我 };
      case "UnassignedContact":
        return { ownerId: 我 };
      default:
        return null;
    }
  }
  const 客户 = 可见客户(谁们);
  switch (model) {
    case "Customer":
      return 客户;
    case "FollowUp":
    case "Opportunity":
    case "Contract":
    case "Contact":
    case "CustomerExtra":
    case "CustomerPool":
    case "CustomerClaim":
    case "CustomerOwnerLog":
    // 订单（2026-10-05 打开）：0.46.15 时订单整个关着，这里没列，业务员能在订单页看到全队的单
    case "TradeOrder":
      return { customer: 客户 };
    case "FollowUpOrder":
    case "TradeOrderPurchase":
    // 节点、单据（二审：节点开关打开后盯盘、按 id 改节点都会碰到同事的单）
    case "TradeOrderNode":
    case "TradeOrderDoc":
      return { order: { customer: 客户 } };
    case "Task":
    case "FollowPlan":
      return { OR: [{ ownerId: 我 }, { customer: 客户 }] };
    case "Lead":
      return { OR: [{ ownerId: 我 }, { customer: 客户 }] };
    case "AuditLog":
      return { userId: 我 };
    case "FollowUpSource":
      return { followUp: { customer: 客户 } };
    case "UnassignedContact":
      return { ownerId: 我 };
    case "OpportunityClose":
    case "OpportunityMoney":
    case "Quote":
    case "SupplierQuote":
      return { opportunity: { customer: 客户 } };
    case "QuoteLine":
      return { quote: { opportunity: { customer: 客户 } } };
    case "ContractMoney":
    case "ContractOwner":
      return { contract: { customer: 客户 } };
    case "ContractWin":
      return { opportunity: { customer: 客户 }, contract: { customer: 客户 } };
    // 项目模式 1a（2026-10-23）：项目跟客户走；负责人不是这位客户的销售时，自己负责的项目也看得到；
    // 放在项目公海里的谁都看得到（才能领）。企业版（10-26）：点了同意的组员也看得到，只是邀请着的不算
    case "Project":
      return 看得到的项目(我, 客户);
    case "ProjectMember":
    case "ProjectNodeLog":
    case "FollowUpProject":
      return { project: 看得到的项目(我, 客户) };
    default:
      return null;
  }
}

function 看得到的项目(我: string | { in: string[] }, 客户: Record<string, unknown>) {
  const 或: Record<string, unknown>[] = [{ ownerId: 我 }, { customer: 客户 }, { pooledAt: { not: null } }];
  if (企业版()) 或.push({ members: { some: { userId: 我, inviteStatus: "JOINED" } } });
  return { OR: 或 };
}

/** 带 where 的操作。create / upsert 不限（新建的本来就是自己的；upsert 限了会在别人的行上再建一条） */
export const 限定的操作 = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany",
]);

type 查询参数 = Record<string, unknown>;
const 关系们 = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.filter((f) => f.kind === "object")]));
function 并限定(where: unknown, 条件: 查询参数): 查询参数 {
  const w = (where ?? {}) as 查询参数;
  const 旧 = w.AND ? (Array.isArray(w.AND) ? w.AND : [w.AND]) : [];
  return { ...w, AND: [...旧, 条件] };
}

/** Prisma 扩展只拦顶层操作：关联列表、可空关联和关联计数也必须补同一范围。互看时带出来的关联都是读，按读放开 */
function 限定关联(model: string, args: 查询参数, 我: 谁, 互看 = false): 查询参数 {
  const 关系 = 关系们.get(model) ?? [];
  const out = { ...args };
  for (const 模式 of ["include", "select"] as const) {
    const 原 = args[模式];
    if (!原 || typeof 原 !== "object") continue;
    const 选 = { ...原 } as 查询参数;
    for (const f of 关系) {
      const v = 选[f.name];
      if (!v) continue;
      let a = 限定关联(f.type, v === true ? {} : v as 查询参数, 我, 互看);
      const 条件 = 限定条件(f.type, 我, 互看);
      // Prisma 允许列表与可空单关联带 where；必填关联由父模型的限定保证。
      if (条件 && (f.isList || !f.isRequired)) a = { ...a, where: 并限定(a.where, 条件) };
      选[f.name] = a;
    }
    if (选._count) {
      const 计数 = 选._count === true ? {} : 选._count as 查询参数;
      const 原计数 = 计数.select as 查询参数 | undefined;
      const 列 = 原计数 ?? Object.fromEntries(关系.filter((f) => f.isList).map((f) => [f.name, true]));
      const 数 = { ...列 };
      for (const f of 关系.filter((f) => f.isList)) {
        const v = 数[f.name];
        const 条件 = 限定条件(f.type, 我, 互看);
        if (!v || !条件) continue;
        const a = v === true ? {} : v as 查询参数;
        数[f.name] = { ...a, where: 并限定(a.where, 条件) };
      }
      选._count = { ...计数, select: 数 };
    }
    out[模式] = 选;
  }
  return out;
}

const 写操作 = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);
const 新建操作 = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
const 单条改删 = new Set(["update", "delete"]);

/** 互看时改 / 删 / 在同事的客户下新建被挡（不在了() 认 code，给人看 message） */
export class 只读错误 extends Error {
  code = "CRM_READONLY";
  constructor(message = "这是同事的客户：只能看和加跟进。改资料、删除、转交请找负责人或老板") {
    super(message);
  }
}

/** 新建的行挂在哪位客户下：直接带 customerId / connect 的那几张表（商机下面的报价等更深的，靠界面不给入口 + 服务端拒收） */
function 挂的客户(d: unknown): string | null {
  const x = d as { customerId?: unknown; customer?: { connect?: { id?: unknown } } } | null;
  const id = x?.customerId ?? x?.customer?.connect?.id;
  return typeof id === "string" ? id : null;
}
function 拦同事客户下新建(model: string, operation: string, args: 查询参数, 别人的: ReadonlySet<string>, 全拦 = false, 话?: string) {
  // 只管会同步、挂在客户下面的表（收藏、AI 对话这些只在本机，随便建）；企业版虚线下属的客户下面跟进也不许建
  if (!范围父表[model] || (!全拦 && 互看可加.has(model))) return;
  const 数据 = operation === "upsert" ? [args.create, args.where] : Array.isArray(args.data) ? args.data : [args.data];
  for (const d of 数据) {
    const c = 挂的客户(d);
    if (c && 别人的.has(c)) throw new 只读错误(话);
  }
}
const 推 = globalThis as unknown as { __推送计时?: ReturnType<typeof setTimeout> };

/**
 * 「这是同步自己那一轮里的写」（回放别人的改动）。2026-10-04 多台实测脚本抓到：原来用一个全进程共用的 __同步中 标记，
 * 同步那一轮跑着的时候，**用户自己**写的也被当成回放、一条推送都不排——同事最长十几秒才看到。
 * 换成异步上下文：只有在 在同步里() 里面发生的写才不算（lib/sync/client.ts 同步一轮 用它包住 跑一轮）
 */
const 同步这一轮 = new AsyncLocalStorage<true>();
export function 在同步里<T>(fn: () => Promise<T>): Promise<T> {
  return 同步这一轮.run(true, async () => await fn());
}

/**
 * 一改完就推（2026-10-04 五人实测：写的那台要等自己的下一轮才推，看的那台再等它的下一轮才拉，平均十几秒）。
 * 本机在团队里、有人写了库：1.5 秒后（连着改只算一次）推一下，同事那边下一次拉就看得到。
 * 同步自己回放时写的不算（在同步里()），不然收一轮又推一轮。
 * 到点时上一轮还没跑完：推一下() 记「欠一轮」，那一轮结束马上补一轮——原来直接复用那一轮，而它早推完了，这次的改动就被吞了
 */
function 改完推一下() {
  if (process.env.DESKTOP_LOCAL !== "1" || 同步这一轮.getStore() || !在团队()) return;
  clearTimeout(推.__推送计时);
  推.__推送计时 = setTimeout(() => {
    void import("./sync/client").then((m) => m.推一下()).catch(() => undefined);
  }, 1500);
  推.__推送计时.unref?.();
}

/** 给一个客户端套上业务员限定（lib/prisma.ts 用；测试拿拷出来的库套同一层） */
export function 加上限定(db: PrismaClient): PrismaClient {
  const c = db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (写操作.has(operation)) 改完推一下();
          const { 我, 互看, 别人的, 读, 全拦, 话, 线索全看 } = await 现在的限定(db);
          if (!我) return query(args);
          // 有只读的客户：团队版互看、企业版虚线下属。读谁 / 读互看 = 查、数、带出来的关联按哪个范围放开
          const 有只读 = 互看 || !!读;
          const 读谁 = 读 ?? 我;
          const 读互看 = !读 && 互看;
          if (有只读 && 新建操作.has(operation)) 拦同事客户下新建(model, operation, (args ?? {}) as 查询参数, 别人的, 全拦, 话);
          // 只读的客户这一张：一眼认得出，不用等数据库回「找不到」
          if (有只读 && model === "Customer" && 单条改删.has(operation)) {
            const id = ((args ?? {}) as { where?: { id?: unknown } }).where?.id;
            if (typeof id === "string" && 别人的.has(id)) throw new 只读错误(话);
          }
          const a = 限定关联(model, (args ?? {}) as 查询参数, 读谁, 读互看);
          const 条件 = !限定的操作.has(operation) || (线索全看 && model === "Lead") ? null : 写操作.has(operation) ? 限定条件(model, 我, false) : 限定条件(model, 读谁, 读互看);
          // 原来的 where 原样摊开、条件并进 AND：findUnique / update / delete 要求唯一键留在最外层
          const q = query((条件 ? { ...a, where: 并限定(a.where, 条件) } : a) as typeof args);
          if (!有只读 || !条件 || !单条改删.has(operation)) return q;
          try {
            return await q;
          } catch (e) {
            // 读得到、改不到：多半是只读客户下面的那一条（也可能真在别处删了）
            if ((e as { code?: string } | null)?.code === "P2025") {
              throw new 只读错误(话 ? "改不了：这一条在虚线下属的客户下面（只能看），或者已经在别处删了，刷新看看" : "改不了：这一条在同事的客户下面（只能看和加跟进），或者已经在别处删了，刷新看看");
            }
            throw e;
          }
        },
      },
    },
  }) as unknown as PrismaClient;
  // 交互式事务占着连接（SQLite 只有一条）。范围缓存是冷的（刚改完组织、刚换人）时，事务里第一条查询
  // 要拿 db 现算范围，等的正是事务手里那条连接，15 秒后超时。开事务之前先把范围算好
  return new Proxy(c, {
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (prop !== "$transaction" || typeof v !== "function") return v;
      return async (...a: unknown[]) => {
        await 现在的限定(db).catch(() => {});
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}
