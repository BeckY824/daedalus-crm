/**
 * 团队版的两档权限（2026-10-04 用户：「做最极简的权限，老板和业务员即可」；业务员只看自己的 + 公海）。
 *
 *   - **老板** = 建团队的人（中转那边的 owner），本机 User.role = ADMIN：看全部、管成员、改业务配置
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
 * **这是界面上的隔离，不是加密上的**：同步要求每台电脑都有整个团队的数据（钥匙只有一把），
 * 懂技术的人直接打开库文件还是看得到。对外说法要照这个说。
 *
 * 同步自己（推、拉、回放、改身份）和查重要看全部：包在 看全部() 里。
 */
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@/generated/prisma";
import { 读 as 读云端凭据 } from "./desktop/cloud";
import { 团队身份id } from "./desktop/me";

const 不限 = new AsyncLocalStorage<true>();

/** 这一段里的查询不加限定（同步、查重、角色对齐） */
export function 看全部<T>(fn: () => Promise<T>): Promise<T> {
  // 在 run 里 await：Prisma 的查询是懒的，拿到 then 才真正发出去——不 await 就跑到 run 外面去了
  return 不限.run(true, async () => await fn());
}

const g = globalThis as unknown as { __限定?: { 我: string | null; 到: number }; __限定刷新?: Promise<string | null> };

/** 角色刚对过 / 刚进出团队：别等缓存过期 */
export function 忘掉限定() {
  g.__限定 = undefined;
  g.__限定刷新 = undefined;
}

function 在团队(): boolean {
  const dir = process.env.CRM_DATA_DIR;
  return !!dir && fs.existsSync(path.join(dir, ".team.json"));
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
export async function 限定的我(db: PrismaClient): Promise<string | null> {
  if (不限.getStore()) return null;
  if (process.env.DESKTOP_LOCAL !== "1") return null;
  // 文件丢失不能等缓存到期，更不能把「认不出我」解释成老板。
  if (在团队() && !读云端凭据()?.accountId) throw new Error("团队身份缺失，请重新登录");
  const 现 = g.__限定;
  if (现 && 现.到 > Date.now()) return 现.我;
  if (现) {
    void 认一次(db).catch(() => {});
    return 现.我;
  }
  return 认一次(db);
}

function 认一次(db: PrismaClient): Promise<string | null> {
  if (g.__限定刷新) return g.__限定刷新;
  const 票 = { p: undefined as Promise<string | null> | undefined };
  const 是这次 = () => g.__限定刷新 === 票.p;
  票.p = (async () => {
    await Promise.resolve(); // 让 票.p 先挂上，下面的「是这次」才认得出
    let 我: string | null = null;
    if (在团队()) {
      const 账号 = 读云端凭据()?.accountId;
      if (账号) {
        const u = await 不限.run(true, () => db.user.findUnique({ where: { id: 团队身份id(账号) }, select: { id: true, role: true, active: true } }));
        if (!u || !u.active) throw new Error("团队身份不存在或已停用，请重新登录");
        if (u.role !== "ADMIN") 我 = u.id;
      }
    }
    // 认的过程中被忘掉过（刚进出团队 / 角色刚对过）：这次的结果可能是旧的，不写，下一句再认
    if (是这次()) g.__限定 = { 我, 到: Date.now() + 3000 };
    return 我;
  })()
    .catch((e) => {
      console.warn("[team-scope] 认不出我：", e?.message ?? e);
      // 有旧的用旧的；一次都没认出来就让这句查询报错——不能悄悄当成「不限定」，业务员会看到全队
      // 只有旧的业务员限定可继续使用；旧的「不限」不能作为身份失败时的退路。
      if (g.__限定?.我 && !/身份不存在或已停用/.test(String(e?.message))) return g.__限定.我;
      g.__限定 = undefined;
      throw e;
    })
    .finally(() => {
      if (是这次()) g.__限定刷新 = undefined;
    });
  g.__限定刷新 = 票.p;
  return 票.p;
}

/** 业务员看得到的客户：自己是销售负责人或渠道负责人，或者在公海里 */
export const 可见客户 = (我: string) => ({ OR: [{ salesOwnerId: 我 }, { channelOwnerId: 我 }, { pool: { isNot: null } }] });

/** 一位客户业务员看不看得到（查重时看全部取回来的行，再按这个判） */
export function 看得到(c: { salesOwnerId: string | null; channelOwnerId?: string | null; pool?: unknown }, 我: string | null): boolean {
  return !我 || c.salesOwnerId === 我 || c.channelOwnerId === 我 || !!c.pool;
}

/** 每个要限定的模型加的那一句 where */
export function 限定条件(model: string, 我: string): Record<string, unknown> | null {
  const 客户 = 可见客户(我);
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
    default:
      return null;
  }
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

/** Prisma 扩展只拦顶层操作：关联列表、可空关联和关联计数也必须补同一范围。 */
function 限定关联(model: string, args: 查询参数, 我: string): 查询参数 {
  const 关系 = 关系们.get(model) ?? [];
  const out = { ...args };
  for (const 模式 of ["include", "select"] as const) {
    const 原 = args[模式];
    if (!原 || typeof 原 !== "object") continue;
    const 选 = { ...原 } as 查询参数;
    for (const f of 关系) {
      const v = 选[f.name];
      if (!v) continue;
      let a = 限定关联(f.type, v === true ? {} : v as 查询参数, 我);
      const 条件 = 限定条件(f.type, 我);
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
        const 条件 = 限定条件(f.type, 我);
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
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (写操作.has(operation)) 改完推一下();
          const 我 = await 限定的我(db);
          if (!我) return query(args);
          const a = 限定关联(model, (args ?? {}) as 查询参数, 我);
          const 条件 = 限定的操作.has(operation) ? 限定条件(model, 我) : null;
          // 原来的 where 原样摊开、条件并进 AND：findUnique / update / delete 要求唯一键留在最外层
          return query((条件 ? { ...a, where: 并限定(a.where, 条件) } : a) as typeof args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
