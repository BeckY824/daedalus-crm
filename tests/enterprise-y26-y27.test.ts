/**
 * 企业版两条重走红（2026-10-26，质量「全合完重走」）：
 *
 * - Y26 导入批次：原来只查登录，业务员能在设置页列出、撤掉老板导的整批。现在按权限矩阵的客户范围：
 *   看 = 自己 + 实线下属 + 虚线下属，撤 = 自己 + 实线下属；老板、总管理员全部。
 * - Y27 电话设成「藏」：列表上号码打了码，可拿完整号码、前 7 位、后 4 位一搜还是能把人搜出来。
 *   现在藏电话的人，客户搜索（含联系人电话、WhatsApp）、线索搜索、AI 助手（search_customers、list_leads、
 *   query_records 按电话筛）都不按号码匹配；姓名照常搜得到，号码照常打码。
 *
 * 每条都有反例（没权限的人看不到、搜不到）和开关关着的那一条（个人版、团队版照旧）。
 * 组织：经理 → 普通销售（实线）、小张（虚线）；老板 ADMIN；外人谁都不挂。字段权限：电话对 sales 「藏」。
 * 用拷出来的一份库、显式单连接，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ent-y26-"));
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
// 同权限矩阵：两个路径都 mock 成同一份，并发 import 时才不会漏限定
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
import { 忘掉企业版范围, 以谁的身份 } from "@/lib/enterprise/visibility";
import { 规则 } from "@/lib/enterprise/rules";
import { 字段权限key } from "@/lib/enterprise/field-perm";
import { invalidateSettingsCache } from "@/lib/settings";
import { 客户筛选条件 } from "@/app/(app)/customers/query";
import { 最近批次, 撤销批次 } from "@/app/(app)/customers/import-actions";
import { 线索关键词条件, 号码藏着 } from "@/lib/search-keyword";
import { 跑工具 } from "@/lib/mcp/tools";
import { maskPhone } from "@/lib/utils";

const 老板 = "y_boss", 经理 = "y_mgr", 普通销售 = "y_wang", 小张 = "y_zhang", 外人 = "y_other";
type 谁 = typeof 老板 | typeof 经理 | typeof 普通销售 | typeof 小张 | typeof 外人;

// 号码：客户本人、联系人、WhatsApp、线索各一个，都挂在普通销售名下（经理是他的实线上级，看得到）
const 客户号 = "13800771100", 联系人号 = "13900772200", 微信号码 = "8613700773300", 线索号 = "13600774400";
const id = { 客户: "", 联系人那位: "", 外贸那位: "", 线索: "" };

const 签票 = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(readSecret()));
async function 作为<R>(u: 谁, f: () => Promise<R>): Promise<R> {
  临时.票 = await 签票(u);
  忘掉企业版范围();
  try {
    return await f();
  } finally {
    临时.票 = undefined;
  }
}
/** 开关关着跑一段：个人版、团队版 */
async function 开关关着<R>(f: () => Promise<R>): Promise<R> {
  delete process.env.CRM_ENTERPRISE;
  忘掉企业版范围();
  try {
    return await f();
  } finally {
    process.env.CRM_ENTERPRISE = "1";
    忘掉企业版范围();
  }
}

const 存设置 = (key: string, v: unknown) => raw.setting.upsert({ where: { key }, update: { value: JSON.stringify(v) }, create: { key, value: JSON.stringify(v) } });

beforeAll(async () => {
  process.env.CRM_ENTERPRISE = "1";
  delete process.env.DESKTOP_LOCAL;
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportRow", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "CustomerExtra", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const 人 = (uid: string, role = "SALES") => raw.user.create({ data: { id: uid, email: `${uid}@x.com`, name: uid, password: "x", role } });
  await 人(老板, "ADMIN");
  for (const uid of [经理, 普通销售, 小张, 外人]) await 人(uid);
  await raw.entMember.createMany({
    data: [
      { userId: 经理, bizRole: "sales_mgr", managerId: 老板 },
      { userId: 普通销售, managerId: 经理 },
      { userId: 小张, dottedManagerId: 经理 },
      { userId: 外人 },
    ],
  });
  id.客户 = (await raw.customer.create({ data: { name: "号码那位", phone: 客户号, salesOwnerId: 普通销售 } })).id;
  id.联系人那位 = (await raw.customer.create({ data: { name: "联系人那位", phone: "15011119999", salesOwnerId: 普通销售, contacts: { create: { name: "家长", phone: 联系人号 } } } })).id;
  id.外贸那位 = (await raw.customer.create({ data: { name: "外贸那位", phone: "15011118888", salesOwnerId: 普通销售, extra: { create: { whatsapp: 微信号码 } } } })).id;
  id.线索 = (await raw.lead.create({ data: { name: "线索那家", contact: "联系人甲", phone: 线索号, ownerId: 普通销售 } })).id;
  await 存设置(规则.按组织看客户.key, true);
  await 存设置(规则.字段权限.key, true);
  await 存设置(字段权限key, { 电话: { sales: "藏" } });
  invalidateSettingsCache();
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

describe("Y26 导入批次：按权限矩阵看、撤", () => {
  /** 造一批：这位导进一位新客户，一条 create 记录。writtenAt 对上 updatedAt，撤销时会真删 */
  let 第几批 = 0;
  async function 造批次(u: 谁) {
    const c = await raw.customer.create({ data: { name: `${u}导的-${++第几批}`, phone: `1502222${String(第几批).padStart(4, "5")}`, salesOwnerId: u } });
    const b = await raw.importBatch.create({ data: { userId: u, userName: u, fileName: `${u}.xlsx`, created: 1 } });
    await raw.importRow.create({ data: { batchId: b.id, customerId: c.id, kind: "create", writtenAt: c.updatedAt } });
    return { 批: b.id, 客户: c.id };
  }
  const 还在 = async (cid: string) => !!(await raw.customer.findUnique({ where: { id: cid } }));
  const 列出 = (u: 谁) => 作为(u, () => 最近批次(100));

  it("普通销售：只列出自己的批次；撤老板、外人的批次当作不存在，客户一位不少", async () => {
    const 老板的 = await 造批次(老板), 外人的 = await 造批次(外人), 自己的 = await 造批次(普通销售);
    const 列 = (await 列出(普通销售)).map((r) => r.id);
    expect(列).toContain(自己的.批);
    expect(列).not.toContain(老板的.批);
    expect(列).not.toContain(外人的.批);
    for (const 别人的 of [老板的, 外人的]) {
      expect(await 作为(普通销售, () => 撤销批次(别人的.批))).toEqual({ ok: false, error: "这一批导入记录已经不在了" });
      expect(await 还在(别人的.客户)).toBe(true);
      expect((await raw.importBatch.findUniqueOrThrow({ where: { id: 别人的.批 } })).revertedAt).toBeNull();
    }
    // 自己的照常能撤
    expect((await 作为(普通销售, () => 撤销批次(自己的.批))).ok).toBe(true);
    expect(await 还在(自己的.客户)).toBe(false);
  });

  it("经理：实线下属的能看能撤；虚线下属的只能看（能撤=false，撤被拦下）；老板、外人的看不到", async () => {
    const 实线的 = await 造批次(普通销售), 虚线的 = await 造批次(小张), 老板的 = await 造批次(老板), 外人的 = await 造批次(外人);
    const 列 = new Map((await 列出(经理)).map((r) => [r.id, r]));
    expect(列.get(实线的.批)?.能撤).toBe(true);
    expect(列.get(虚线的.批)?.能撤).toBe(false);
    expect(列.has(老板的.批)).toBe(false);
    expect(列.has(外人的.批)).toBe(false);

    expect(await 作为(经理, () => 撤销批次(虚线的.批))).toEqual({ ok: false, error: "这一批是虚线下属导入的：只能看，不能撤销" });
    expect(await 还在(虚线的.客户)).toBe(true);
    expect(await 作为(经理, () => 撤销批次(老板的.批))).toEqual({ ok: false, error: "这一批导入记录已经不在了" });
    expect(await 还在(老板的.客户)).toBe(true);

    expect((await 作为(经理, () => 撤销批次(实线的.批))).ok).toBe(true);
    expect(await 还在(实线的.客户)).toBe(false);
  });

  it("老板：全部列出、全部能撤", async () => {
    const 外人的 = await 造批次(外人);
    const 列 = await 列出(老板);
    expect(列.find((r) => r.id === 外人的.批)?.能撤).toBe(true);
    expect(列.every((r) => r.能撤)).toBe(true);
    expect((await 作为(老板, () => 撤销批次(外人的.批))).ok).toBe(true);
  });

  it("开关关着（个人版、团队版）：照旧谁登录都列全部、都能撤", async () => {
    const 老板的 = await 造批次(老板);
    await 开关关着(async () => {
      const 列 = await 列出(普通销售);
      expect(列.find((r) => r.id === 老板的.批)?.能撤).toBe(true);
      expect((await 作为(普通销售, () => 撤销批次(老板的.批))).ok).toBe(true);
    });
    expect(await 还在(老板的.客户)).toBe(false);
  });
});

describe("Y27 电话藏着：按号码搜不出来", () => {
  // 完整号码、前 7 位、后 4 位：质量重走时三种都试出了人
  const 片段 = (号: string) => [号, 号.slice(0, 7), 号.slice(-4)];
  const 客户号码搜法 = [
    ...片段(客户号).map((k) => ({ k, 目标: "客户" as const, who: "号码那位" })),
    ...片段(联系人号).map((k) => ({ k, 目标: "联系人那位" as const, who: "联系人那位（联系人电话）" })),
    ...片段(微信号码).map((k) => ({ k, 目标: "外贸那位" as const, who: "外贸那位（WhatsApp）" })),
  ];

  /** 客户列表搜索框：我的、公海两种筛选里有没有这一位 */
  const 列表搜得到 = (u: 谁, k: string, cid: string) =>
    作为(u, async () => {
      await requireUser();
      for (const sp of [{ keyword: k }, { keyword: k, pool: "1" }]) if ((await db.customer.findMany({ where: await 客户筛选条件(sp), select: { id: true } })).some((c) => c.id === cid)) return true;
      return false;
    });
  const 线索搜得到 = (u: 谁, k: string) =>
    作为(u, async () => {
      await requireUser();
      return (await db.lead.findMany({ where: await 线索关键词条件(k), select: { id: true } })).some((l) => l.id === id.线索);
    });
  // 和 api/mcp/route.ts 一样：没有 cookie，只用 以谁的身份 告诉限定层是谁
  const MCP = (u: 谁, name: string, args: Record<string, unknown>) => 以谁的身份(u, () => 跑工具(name, args, { id: u, name: u }));
  const AI搜到 = async (u: 谁, k: string, cid: string) =>
    ((await MCP(u, "search_customers", { query: k })).data as { customers?: { id: string }[] }).customers?.some((c) => c.id === cid) ?? false;
  const AI线索搜到 = async (u: 谁, k: string) => JSON.stringify((await MCP(u, "list_leads", { keyword: k })).data).includes("线索那家");

  it("号码藏着 只对藏电话的人为真；开关关着谁都为假", async () => {
    expect(await 号码藏着(普通销售)).toBe(true);
    expect(await 号码藏着(经理)).toBe(false);
    expect(await 号码藏着(老板)).toBe(false);
    expect(await 开关关着(() => 号码藏着(普通销售))).toBe(false);
  });

  it.each(客户号码搜法)("普通销售（电话藏）客户列表搜「$k」→ 搜不到 $who", async ({ k, 目标 }) => {
    expect(await 列表搜得到(普通销售, k, id[目标])).toBe(false);
  });
  it.each(客户号码搜法)("经理（电话能看）客户列表搜「$k」→ 搜得到 $who", async ({ k, 目标 }) => {
    expect(await 列表搜得到(经理, k, id[目标])).toBe(true);
  });
  it.each(客户号码搜法)("开关关着：普通销售客户列表搜「$k」→ 照旧搜得到 $who", async ({ k, 目标 }) => {
    expect(await 开关关着(() => 列表搜得到(普通销售, k, id[目标]))).toBe(true);
  });

  it.each(片段(线索号))("线索搜「%s」：电话藏的人搜不到，能看的人、开关关着照旧搜得到", async (k) => {
    expect(await 线索搜得到(普通销售, k)).toBe(false);
    expect(await 线索搜得到(经理, k)).toBe(true);
    expect(await 开关关着(() => 线索搜得到(普通销售, k))).toBe(true);
  });

  it.each(客户号码搜法)("AI 助手 search_customers（MCP）搜「$k」：电话藏的人搜不到 $who，能看的人、开关关着搜得到", async ({ k, 目标 }) => {
    expect(await AI搜到(普通销售, k, id[目标])).toBe(false);
    expect(await AI搜到(经理, k, id[目标])).toBe(true);
    expect(await 开关关着(() => AI搜到(普通销售, k, id[目标]))).toBe(true);
  });

  it.each(片段(线索号))("AI 助手 list_leads（MCP）搜「%s」：电话藏的人搜不到，能看的人、开关关着搜得到", async (k) => {
    expect(await AI线索搜到(普通销售, k)).toBe(false);
    expect(await AI线索搜到(经理, k)).toBe(true);
    expect(await 开关关着(() => AI线索搜到(普通销售, k))).toBe(true);
  });

  it("AI 助手 query_records 按电话筛、排序、分组：电话藏的人一律拦下；能看的人、开关关着照旧查得到", async () => {
    const 规格们 = [
      { 表: "客户", 条件: [{ 字段: "电话", 运算: "包含", 值: 客户号.slice(-4) }] },
      { 表: "客户", 条件: [], 排序: { 字段: "电话", 降序: true } },
      { 表: "客户", 条件: [], 分组: "电话" },
      { 表: "线索", 条件: [{ 字段: "电话", 运算: "包含", 值: 线索号.slice(-4) }] },
    ];
    for (const 规格 of 规格们) {
      const r = await MCP(普通销售, "query_records", 规格);
      expect(r.summary, JSON.stringify(规格)).toBe("电话对你不可见");
    }
    const 查到 = async (u: 谁) => JSON.stringify((await MCP(u, "query_records", 规格们[0])).data);
    expect(await 查到(经理)).toContain("号码那位");
    expect(await 开关关着(() => 查到(普通销售))).toContain("号码那位");
    // 不碰电话的查询照常
    expect(JSON.stringify((await MCP(普通销售, "query_records", { 表: "客户", 条件: [{ 字段: "姓名", 运算: "包含", 值: "号码" }] })).data)).toContain("号码那位");
  });

  it("按姓名照常搜得到，号码照常打码（列表、AI 助手）", async () => {
    expect(await 列表搜得到(普通销售, "号码那位", id.客户)).toBe(true);
    const 这位 = ((await MCP(普通销售, "search_customers", { query: "号码那位" })).data as { customers?: { id: string; phone: string | null }[] }).customers?.find((c) => c.id === id.客户);
    expect(这位?.phone).toBe(maskPhone(客户号));
    expect(await 线索搜得到(普通销售, "线索那家")).toBe(true);
  });
});
