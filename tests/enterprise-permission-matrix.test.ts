/**
 * 企业版权限矩阵（2026-10-24）：6 种角色 × 5 个接口 × 5 类记录，每一格「看得到 / 改得了」都和下面的期望表比对。
 *
 * - 角色：老板（ADMIN）、总管理员、经理（有实线、虚线下属）、虚线上级（只有虚线下属）、普通销售、停用的人
 * - 记录：自己的、实线下属的、虚线下属的、公海、别人的（这个角色没有这类下属时那格写 null = 不适用）
 * - 接口：列表、详情、导出、关键词搜索、AI 查客户——都走真实入口（requireUser 认 crm_session 会话票，
 *   prisma 那一层按组织限定），不是直接调 visibility 的纯函数
 * - 改：patchCustomer（记录页行内改字段，和界面上点着改是同一个 action）
 *
 * 停用的人：requireUser 在入口就拦下（跳去登出），所以五个接口都拿不到、什么都改不了；
 * 另有一条钉住「就算绕过入口直接查库，也只看得到公海」。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ent-matrix-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir, 票: undefined as string | undefined };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const raw = new PrismaClient({ datasourceUrl: `file:${path.join(临时.dir, "A.db")}?connection_limit=1` });
  return { prisma: 加上限定(raw), defaultClient: raw };
});
// 请求里的会话票：auth.ts 的 requireUser 和 visibility 的认人读的都是它
// visibility 用动态 import("next/headers")：并发几条查询同时 import 时，vitest 有时解析到真模块 next/headers.js
// （抛「outside a request scope」→ 当成无请求、不限定）。两个路径都 mock 成同一份，否则 Promise.all 里会有一条漏限定。
const 假头 = vi.hoisted(() => () => ({
  cookies: async () => ({ get: (n: string) => (n === "crm_session" && 临时.票 ? { value: 临时.票 } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/headers", 假头);
vi.mock("next/headers.js", 假头);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { SignJWT } from "jose";
import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { readSecret } from "@/lib/secret";
import { requireUser } from "@/lib/auth";
import { 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";
import { 客户筛选条件 } from "@/app/(app)/customers/query";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { patchCustomer } from "@/app/(app)/customers/actions";
import { TOOL_MAP, type ToolContext } from "@/lib/agent/tools";

const 角色 = ["老板", "总管理员", "经理", "虚线上级", "普通销售", "停用的人"] as const;
const 记录 = ["自己的", "实线下属的", "虚线下属的", "公海", "别人的"] as const;
const 接口 = ["列表", "详情", "导出", "关键词搜索", "AI查客户"] as const;
type 角色 = (typeof 角色)[number];
type 记录 = (typeof 记录)[number];
type 接口 = (typeof 接口)[number];

/** 每个角色是谁 */
const 用户: Record<角色, string> = { 老板: "m_boss", 总管理员: "m_dir", 经理: "m_mgr", 虚线上级: "m_dot", 普通销售: "m_wang", 停用的人: "m_off" };
/** 组织：总管 → 老板；经理 → 总管；小王、停用的人 → 经理（实线）；小张 → 经理（虚线）；小李 → 虚线上级（虚线）；外人谁都不挂 */
const 小张 = "m_zhang";
const 小李 = "m_li";
const 外人 = "m_other";

/** 角色 × 记录 → 哪位的客户（null = 这个角色没有这类记录） */
const 记录归属: Record<角色, Record<记录, string | null>> = {
  老板: { 自己的: 用户.老板, 实线下属的: 用户.总管理员, 虚线下属的: null, 公海: "公海", 别人的: 外人 },
  总管理员: { 自己的: 用户.总管理员, 实线下属的: 用户.经理, 虚线下属的: null, 公海: "公海", 别人的: 外人 },
  经理: { 自己的: 用户.经理, 实线下属的: 用户.普通销售, 虚线下属的: 小张, 公海: "公海", 别人的: 外人 },
  虚线上级: { 自己的: 用户.虚线上级, 实线下属的: null, 虚线下属的: 小李, 公海: "公海", 别人的: 外人 },
  普通销售: { 自己的: 用户.普通销售, 实线下属的: null, 虚线下属的: null, 公海: "公海", 别人的: 外人 },
  停用的人: { 自己的: 用户.停用的人, 实线下属的: null, 虚线下属的: null, 公海: "公海", 别人的: 外人 },
};

/** 期望表：[看得到, 改得了]，按 记录 的顺序；null = 不适用。五个接口的「看得到」口径一样 */
const T = true, F = false, 无 = null;
const 期望: Record<角色, ([boolean, boolean] | null)[]> = {
  //            自己的    实线下属的  虚线下属的  公海      别人的
  老板: [[T, T], [T, T], 无, [T, T], [T, T]],
  总管理员: [[T, T], [T, T], 无, [T, T], [T, T]],
  经理: [[T, T], [T, T], [T, F], [T, T], [F, F]],
  虚线上级: [[T, T], 无, [T, F], [T, T], [F, F]],
  普通销售: [[T, T], 无, 无, [T, T], [F, F]],
  // 入口就拦下：哪一格都拿不到
  停用的人: [[F, F], 无, 无, [F, F], [F, F]],
};

const 客户id = new Map<string, string>(); // 归属（用户 id 或 "公海"）→ 客户 id
const 电话前缀 = "1380077";

const 签票 = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(readSecret()));
async function 作为<R>(r: 角色, f: () => Promise<R>): Promise<R> {
  临时.票 = await 签票(用户[r]);
  忘掉企业版范围();
  try {
    return await f();
  } finally {
    临时.票 = undefined;
  }
}

const ctx = (u: { id: string; name: string }): ToolContext => ({
  userId: u.id,
  userName: u.name,
  b: { customer: "学员", brief: "", statusLabels: {}, 术语: {} } as never,
  recordOffset: 0,
  proposals: [],
  号: undefined,
});

/** 每个接口在这个人身上能拿到哪些客户 id；入口拦下（requireUser 跳登出）= 空 */
const 拿到: Record<接口, (id: string) => Promise<boolean>> = {
  列表: async (id) => {
    await requireUser();
    const ids = new Set<string>();
    for (const sp of [{}, { pool: "1" }]) for (const c of await db.customer.findMany({ where: await 客户筛选条件(sp), select: { id: true } })) ids.add(c.id);
    return ids.has(id);
  },
  详情: async (id) => {
    await requireUser();
    return !!(await db.customer.findUnique({ where: { id } }));
  },
  导出: async (id) => {
    const ids = new Set<string>();
    for (const sp of [{}, { pool: "1" }]) {
      const r = await 导出客户(sp);
      if (!r.ok) throw new Error(r.error);
      for (const row of r.rows) ids.add(row.id);
    }
    return ids.has(id);
  },
  关键词搜索: async (id) => {
    await requireUser();
    const ids = new Set<string>();
    for (const sp of [{ keyword: 电话前缀 }, { keyword: 电话前缀, pool: "1" }]) for (const c of await db.customer.findMany({ where: await 客户筛选条件(sp), select: { id: true } })) ids.add(c.id);
    return ids.has(id);
  },
  AI查客户: async (id) => {
    const me = await requireUser();
    const 搜 = (await TOOL_MAP.get("search_customers")!.run({ query: 电话前缀 }, ctx(me))).data as { customers?: { id: string }[] };
    const 在搜里 = (搜.customers ?? []).some((c) => c.id === id);
    const 读 = (await TOOL_MAP.get("get_customer")!.run({ id }, ctx(me))).data as { 找到?: number };
    // 两条路径口径必须一致：搜得到 ⇔ 读得到
    expect(读.找到 !== 0, "search_customers 和 get_customer 不一致").toBe(在搜里);
    return 在搜里;
  },
};

/** requireUser 拦下时 next 的 redirect 抛 NEXT_REDIRECT，当作「拿不到」 */
const 拦下 = (e: unknown) => !!e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");

async function 看得到(r: 角色, 口: 接口, id: string) {
  return 作为(r, async () => {
    try {
      return await 拿到[口](id);
    } catch (e) {
      if (拦下(e)) return false;
      throw e;
    }
  });
}

async function 改得了(r: 角色, id: string) {
  const 原 = (await raw.customer.findUniqueOrThrow({ where: { id } })).major;
  const 新 = `改-${r}-${Date.now()}`;
  const res = await 作为(r, async () => {
    try {
      return await patchCustomer(id, "major", 新);
    } catch (e) {
      if (拦下(e)) return { ok: false as const, error: "入口拦下" };
      // 虚线只读在 prisma 那一层抛只读错误
      return { ok: false as const, error: String(e) };
    }
  });
  const 现在 = (await raw.customer.findUniqueOrThrow({ where: { id } })).major;
  await raw.customer.update({ where: { id }, data: { major: 原 } });
  // 说改成了就真改了，说没改就一个字都没动
  expect(现在 === 新, `patchCustomer 回 ${JSON.stringify(res)} 但库里是 ${现在}`).toBe(res.ok);
  return res.ok;
}

const 开规则 = async (on: boolean) => {
  await raw.setting.upsert({ where: { key: 规则.按组织看客户.key }, update: { value: JSON.stringify(on) }, create: { key: 规则.按组织看客户.key, value: JSON.stringify(on) } });
  忘掉企业版范围();
};

beforeAll(async () => {
  process.env.CRM_ENTERPRISE = "1";
  delete process.env.DESKTOP_LOCAL;
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 人 = (id: string, role = "SALES", active = true) => raw.user.create({ data: { id, email: `${id}@x.com`, name: id, password: "x", role, active } });
  await 人(用户.老板, "ADMIN");
  for (const id of [用户.总管理员, 用户.经理, 用户.虚线上级, 用户.普通销售, 小张, 小李, 外人]) await 人(id);
  await 人(用户.停用的人, "SALES", false);
  await raw.entMember.createMany({
    data: [
      { userId: 用户.总管理员, bizRole: "director", managerId: 用户.老板 },
      { userId: 用户.经理, bizRole: "sales_mgr", managerId: 用户.总管理员 },
      { userId: 用户.普通销售, managerId: 用户.经理 },
      { userId: 用户.停用的人, managerId: 用户.经理 },
      { userId: 小张, dottedManagerId: 用户.经理 },
      { userId: 小李, dottedManagerId: 用户.虚线上级 },
      { userId: 用户.虚线上级 },
      { userId: 外人 },
    ],
  });
  let n = 10;
  for (const o of [...Object.values(用户), 小张, 小李, 外人]) {
    const c = await raw.customer.create({ data: { name: `${o}的客户`, phone: `${电话前缀}${n++}00`, salesOwnerId: o } });
    客户id.set(o, c.id);
  }
  const 公海 = await raw.customer.create({ data: { name: "公海客户", phone: `${电话前缀}9900`, salesOwnerId: 用户.老板 } });
  await raw.customerPool.create({ data: { customerId: 公海.id } });
  客户id.set("公海", 公海.id);
  await 开规则(true);
});

beforeEach(() => {
  临时.票 = undefined;
  忘掉企业版范围();
});

afterAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  忘掉企业版范围();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

it("期望表完整：每个 角色 × 记录 都有定义，不适用的格和没有那类下属对得上", () => {
  for (const r of 角色) {
    expect(期望[r]).toHaveLength(记录.length);
    记录.forEach((k, i) => expect(期望[r][i] === null, `${r} × ${k}`).toBe(记录归属[r][k] === null));
  }
});

const 看的格 = 角色.flatMap((r) => 接口.flatMap((口) => 记录.flatMap((k, i) => (期望[r][i] ? [{ role: r, api: 口, kind: k, want: 期望[r][i]![0] }] : []))));
const 改的格 = 角色.flatMap((r) => 记录.flatMap((k, i) => (期望[r][i] ? [{ role: r, kind: k, want: 期望[r][i]![1] }] : [])));

describe("看得到", () => {
  it.each(看的格)("$role · $api · $kind → $want", async ({ role, api, kind, want }) => {
    expect(await 看得到(role, api, 客户id.get(记录归属[role][kind]!)!)).toBe(want);
  });
});

describe("改得了（记录页行内改字段）", () => {
  it.each(改的格)("$role · $kind → $want", async ({ role, kind, want }) => {
    expect(await 改得了(role, 客户id.get(记录归属[role][kind]!)!)).toBe(want);
  });
});

describe("停用的人", () => {
  it("就算绕过入口直接查库，也只看得到公海", async () => {
    const ids = await 作为("停用的人", async () => (await db.customer.findMany({ select: { id: true } })).map((c) => c.id));
    expect(ids).toEqual([客户id.get("公海")]);
  });
});
