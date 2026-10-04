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
import type { PrismaClient } from "@/generated/prisma";
import { 读 as 读云端凭据 } from "./desktop/cloud";
import { 团队身份id } from "./desktop/me";

const 不限 = new AsyncLocalStorage<true>();

/** 这一段里的查询不加限定（同步、查重、角色对齐） */
export function 看全部<T>(fn: () => Promise<T>): Promise<T> {
  // 在 run 里 await：Prisma 的查询是懒的，拿到 then 才真正发出去——不 await 就跑到 run 外面去了
  return 不限.run(true, async () => await fn());
}

const g = globalThis as unknown as { __限定?: { 我: string | null; 到: number } };

/** 角色刚对过 / 刚进出团队：别等缓存过期 */
export function 忘掉限定() {
  g.__限定 = undefined;
}

function 在团队(): boolean {
  const dir = process.env.CRM_DATA_DIR;
  return !!dir && fs.existsSync(path.join(dir, ".team.json"));
}

/**
 * 现在要不要限定、限定成谁：业务员返回本机我的 id，其余（老板、没进团队、网页版、托管版）返回 null。
 * 缓存 3 秒：每条查询都会问一次，不能每次都读库。
 */
export async function 限定的我(db: PrismaClient): Promise<string | null> {
  if (不限.getStore()) return null;
  if (process.env.DESKTOP_LOCAL !== "1") return null;
  const 现 = g.__限定;
  if (现 && 现.到 > Date.now()) return 现.我;
  let 我: string | null = null;
  if (在团队()) {
    const 账号 = 读云端凭据()?.accountId;
    if (账号) {
      const u = await 不限.run(true, () => db.user.findUnique({ where: { id: 团队身份id(账号) }, select: { id: true, role: true } }));
      if (u && u.role === "SALES") 我 = u.id;
    }
  }
  g.__限定 = { 我, 到: Date.now() + 3000 };
  return 我;
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
      return { customer: 客户 };
    case "Task":
    case "FollowPlan":
      return { OR: [{ ownerId: 我 }, { customer: 客户 }] };
    case "Lead":
      return { OR: [{ ownerId: 我 }, { customer: 客户 }] };
    case "AuditLog":
      return { userId: 我 };
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

/** 给一个客户端套上业务员限定（lib/prisma.ts 用；测试拿拷出来的库套同一层） */
export function 加上限定(db: PrismaClient): PrismaClient {
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!限定的操作.has(operation)) return query(args);
          const 我 = await 限定的我(db);
          const 条件 = 我 ? 限定条件(model, 我) : null;
          if (!条件) return query(args);
          // 原来的 where 原样摊开、条件并进 AND：findUnique / update / delete 要求唯一键留在最外层
          const a = (args ?? {}) as { where?: Record<string, unknown> };
          const w = a.where ?? {};
          const 旧 = w.AND ? (Array.isArray(w.AND) ? w.AND : [w.AND]) : [];
          return query({ ...a, where: { ...w, AND: [...旧, 条件] } } as typeof args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
