/**
 * 企业版「按组织架构看客户」（2026-10-24，规则开关 规则.按组织看客户）。
 *
 * 和团队版业务员限定共用一层（lib/team-scope.ts 的 加上限定），这里只回答「这个请求的人看得到、改得到谁负责的客户」：
 *   - 老板（账号 ADMIN）、总管理员（业务角色 director / admin）：看全部，不限定；
 *   - 其余：**改** = 自己 + 实线下属（直属上级链往下整条）负责的客户 + 公海；
 *     **看** = 改的范围 + 虚线下属和他们的实线下属负责的客户——虚线上级只能看，不能改、不能转，
 *     那些客户下面也不能新建任何东西（跟进也不行，和团队版互看「能加跟进」不同）。
 *
 * 认人：企业版是网页（自部署），按请求认——读 crm_session 这张会话票（同 lib/auth.ts，那边带 next/headers 顶层 import，
 * 测试里用不了，这里自己验）。MCP 这类不走 cookie 的入口用 以谁的身份() 包住。
 *   - 没有请求（定时任务、启动时）= 不限定：后台本来就要看全部；
 *   - 有请求但没登录 / 票不对 / 人停用了 = 只看公海（这种请求页面会跳登录，这里只是别漏）。
 *
 * 缓存 10 秒，按会话票分开；到期先用旧的、后台再认一次——理由同 team-scope 现在的限定：
 * 这一句常落在交互式事务里，SQLite 只开一个连接，现查要等事务放连接。改组织、拨开关后 忘掉企业版范围()。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { jwtVerify } from "jose";
import type { PrismaClient } from "@/generated/prisma";
import { readSecret } from "@/lib/secret";
import { 看得到, type 限定 } from "@/lib/team-scope";
import { 建组织, 实线下属, 虚线下属, 管理员类别of, type 组织 } from "./org-core";
import { 规则 } from "./rules";

/** lib/auth.ts 的 COOKIE */
const 会话票 = "crm_session";
export const 虚线只读话 = "这是虚线下属的客户：只能看，不能改、不能转";
/** 没认出人：只看公海（谁的 id 都不会是这个） */
const 只看公海: 限定 = { 我: ["__无"], 互看: false, 别人的: new Set() };

/**
 * 算范围（纯函数，测试直接用）：null = 看全部。
 * 写 = 自己 + 实线下属；读 = 写 + 每个虚线下属和他的实线下属。读比写多才带 读，不然和普通限定一样
 */
export function 组织范围of(org: 组织, 账号角色: string | null, 我: string): { 写: string[]; 读?: string[] } | null {
  if (账号角色 === "ADMIN" || 管理员类别of(org, 我) === "总管理员") return null;
  if (!org.成员.has(我)) return { 写: ["__无"] };
  const 写 = new Set([我, ...实线下属(org, 我)]);
  const 读 = new Set(写);
  for (const d of 虚线下属(org, 我)) for (const x of [d, ...实线下属(org, d)]) 读.add(x);
  return 读.size > 写.size ? { 写: [...写], 读: [...读] } : { 写: [...写] };
}

const 身份 = new AsyncLocalStorage<string>();

/** 不走 cookie 的入口（MCP 用令牌认人）：这一段里的查询按这个人算范围 */
export function 以谁的身份<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return 身份.run(userId, async () => await fn());
}

type 缓存项 = { 值: 限定 | null; 到: number };
const g = globalThis as unknown as { __企业范围?: Map<string, 缓存项>; __企业范围刷新?: Map<string, Promise<限定 | null>> };
const 缓存 = () => (g.__企业范围 ??= new Map());
const 刷新中 = () => (g.__企业范围刷新 ??= new Map());

/** 组织、规则开关、人员改了：别等缓存过期 */
export function 忘掉企业版范围() {
  g.__企业范围 = undefined;
  g.__企业范围刷新 = undefined;
}

/**
 * next/headers 只 import 一次：每条查询都动态 import 一回不值；
 * 而且测试里几条查询同时首次 import 时，vitest 的 mock 会有一条拿到真模块（真 cookies() 在请求外抛错 → 当成后台 → 不限定）
 */
let 头: Promise<typeof import("next/headers")> | undefined;

/** 现在这个请求是谁：钥 = 缓存的键；id = null 是有请求但没认出人；"无请求" = 后台 */
async function 是谁(): Promise<{ 钥: string; id: string | null } | "无请求"> {
  const o = 身份.getStore();
  if (o) return { 钥: `u:${o}`, id: o };
  let 票: string | undefined;
  try {
    const { cookies } = await (头 ??= import("next/headers"));
    票 = (await cookies()).get(会话票)?.value;
  } catch (e) {
    // Next 静态渲染时的「这页要动态」信号带 digest，得原样抛回去
    if (e && typeof e === "object" && "digest" in e) throw e;
    return "无请求";
  }
  if (!票) return { 钥: "无", id: null };
  try {
    const { payload } = await jwtVerify(票, new TextEncoder().encode(readSecret()));
    return typeof payload.sub === "string" ? { 钥: `t:${票}`, id: payload.sub } : { 钥: "无", id: null };
  } catch {
    return { 钥: "无", id: null };
  }
}

/**
 * 这个请求的企业版范围：null = 不限定（规则关着、老板 / 总管理员、后台任务）。
 * 调用方（team-scope 现在的限定）已判过 企业版()
 */
export async function 企业版范围(db: PrismaClient): Promise<限定 | null> {
  const 人 = await 是谁();
  if (人 === "无请求") return null;
  const 现 = 缓存().get(人.钥);
  if (现 && 现.到 > Date.now()) return 现.值;
  if (现) {
    void 认一次(db, 人.钥, 人.id).catch(() => {});
    return 现.值;
  }
  return 认一次(db, 人.钥, 人.id);
}

function 认一次(db: PrismaClient, 钥: string, id: string | null): Promise<限定 | null> {
  const 在跑 = 刷新中().get(钥);
  if (在跑) return 在跑;
  const 表 = 刷新中();
  const p = 算(db, id)
    .then((值) => {
      // 认的过程中被忘掉过：结果可能是旧的，不写
      if (g.__企业范围刷新 === 表) {
        const c = 缓存();
        if (c.size > 500) c.clear();
        c.set(钥, { 值, 到: Date.now() + 10_000 });
      }
      return 值;
    })
    .finally(() => {
      if (表.get(钥) === p) 表.delete(钥);
    });
  表.set(钥, p);
  return p;
}

/** 规则开关的 Setting 值：只有存的是 true 才算开（同 rules.ts 规则开着，这里在钩子里，直接读 db） */
async function 开着(db: PrismaClient, key: string): Promise<boolean> {
  const v = await db.setting.findUnique({ where: { key }, select: { value: true } });
  try {
    return !!v && JSON.parse(v.value) === true;
  } catch {
    return false;
  }
}

async function 算(db: PrismaClient, id: string | null): Promise<限定 | null> {
  if (!(await 开着(db, 规则.按组织看客户.key))) return null;
  if (!id) return 只看公海;

  const [users, members, depts] = await Promise.all([
    db.user.findMany({ select: { id: true, role: true, active: true } }),
    db.entMember.findMany(),
    db.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } }),
  ]);
  const 我 = users.find((u) => u.id === id);
  if (!我 || !我.active) return 只看公海;
  const org = 建组织(users, members, depts);
  const 范围 = 组织范围of(org, 我.role, id);
  if (!范围) return null;
  // 市场管理分线索（同 lead-assign 能分配；老板、总管理员上面已经不限定）：线索开着分配时全看全改，
  // 不然分出去就看不到、也分不了（F9 10-25）。客户那条线还是按组织架构
  const 线索 = 管理员类别of(org, id) === "市场管理" && (await 开着(db, 规则.线索分配.key)) ? { 线索全看: true } : {};
  if (!范围.读) return { 我: 范围.写, 互看: false, 别人的: new Set(), ...线索 };

  // 只能看的那些客户的编号：新建前、改客户前按这份判（钩子里不能现查）
  const 读 = 范围.读;
  const 那些 = await db.customer.findMany({
    where: { OR: [{ salesOwnerId: { in: 读 } }, { channelOwnerId: { in: 读 } }] },
    select: { id: true, salesOwnerId: true, channelOwnerId: true, pool: { select: { customerId: true } } },
  });
  const 别人的 = new Set(那些.filter((c) => !看得到(c, 范围.写)).map((c) => c.id));
  return { 我: 范围.写, 互看: false, 别人的, 读, 全拦: true, 话: 虚线只读话, ...线索 };
}
