/**
 * 团队「同事之间互相看得到客户」（2026-10-20，客户需求）：本机这一半，外加老板把公海客户指派给业务员。
 *   - 开关跟着同步写进 .team.json（对齐角色 / 范围一轮 记互看）；lib/team-scope.ts 照它放开读
 *   - 开着：业务员看得到全队客户、跟进、商机、待办；同事的客户只能看和新加跟进，改、删、在下面建别的都挡（只读错误）
 *   - 关掉：回到「只看自己的 + 公海」
 *   - 公海「分配给…」：只有老板；和领取一样换负责人、删公海那一行、没做完的活跟过去；能撤销
 * 用拷出来的一份库（同 team-roles.test.ts），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-team-share-"));
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "A.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "A.db-wal"));
  return { dir };
});
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@/generated/prisma");
  const { 加上限定 } = await import("@/lib/team-scope");
  const { 单连接 } = await import("@/lib/sqlite-url");
  const raw = new PrismaClient({ datasourceUrl: 单连接(`file:${path.join(临时.dir, "A.db").replaceAll("\\", "/")}`) });
  return { prisma: 加上限定(raw), defaultClient: raw };
});

const 登录的 = vi.hoisted(() => ({ user: { id: "acct_wang", name: "小王", email: "acct_wang@x.com", role: "SALES", title: "销售", avatar: null } as { id: string; name: string; email: string; role: string; title: string; avatar: null } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => 登录的.user, getCurrentUser: async () => 登录的.user }));

import { prisma as db, defaultClient as raw } from "@/lib/prisma";
import { 分配公海, 撤销公海, 领取 } from "@/app/(app)/customers/pool-actions";
import { saveFollowUp } from "@/app/(app)/customers/[id]/actions";
import { patchCustomer } from "@/app/(app)/customers/actions";
import { 忘掉限定, 限定的我, 读的我, 只读客户, 只读错误 } from "@/lib/team-scope";
import { 设传输, 对齐角色, 读团队, type 传输 } from "@/lib/sync/client";
import { 不在了 } from "@/lib/not-there";
import { GET as 列附件路由, POST as 传附件路由 } from "@/app/api/attachments/route";
import { GET as 取附件路由, DELETE as 删附件路由 } from "@/app/api/attachments/[id]/route";

const 老板 = "acct_boss";
const 小王 = "acct_wang";
const 小李 = "acct_li";

function 当(账号: "boss" | "wang") {
  fs.writeFileSync(path.join(临时.dir, ".cloud.json"), JSON.stringify({ baseUrl: "http://fake", token: "dk_test", accountId: 账号, name: 账号, contact: `${账号}@x.com`, models: [], loggedAt: new Date().toISOString() }));
  登录的.user = 账号 === "boss"
    ? { id: 老板, name: "老板", email: `${老板}@x.com`, role: "ADMIN", title: "老板", avatar: null }
    : { id: 小王, name: "小王", email: `${小王}@x.com`, role: "SALES", title: "销售", avatar: null };
  我是 = 账号;
  忘掉限定();
}
let 我是 = "wang";
const 云端 = { 互看: false as boolean | undefined };
const 名单 = [{ accountId: "boss", role: "owner" }, { accountId: "wang", role: "member" }, { accountId: "li", role: "member" }];
const 假传输: 传输 = async (方法, 路径) => {
  if (方法 === "GET" && 路径 === "/api/sync/team") return { 状态: 200, json: { ok: true, teams: [{ id: "t1xxxxxxxxxx", name: "队", active: true, 我是建的人: 我是 === "boss", 互看: 云端.互看, 成员: 名单.map((m) => ({ ...m, name: m.accountId, contact: "" })) }] } };
  return { 状态: 404, json: { error: "没有" } };
};
/** 云端说开关是什么，本机对齐一次（和每轮同步一样） */
async function 云端说(on: boolean | undefined) { 云端.互看 = on; await 对齐角色(); 忘掉限定(); }

const ids: Record<string, string> = {};
const 任务: Record<string, string> = {};

async function 种数据() {
  for (const t of ["AuditLog", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const [id, name] of [[老板, "老板"], [小王, "小王"], [小李, "小李"], ["acct_gone", "走了的"]]) {
    await raw.user.create({ data: { id, email: `${id}@x.com`, name, password: "x", role: "ADMIN", active: id !== "acct_gone" } });
  }
  const 建 = async (key: string, owner: string) => {
    const c = await raw.customer.create({ data: { name: key, phone: `1390000${String(Object.keys(ids).length).padStart(4, "0")}`, salesOwnerId: owner } });
    ids[key] = c.id;
    await raw.followUp.create({ data: { customerId: c.id, ownerId: owner, type: "PHONE", title: "电话", content: `${key} 的跟进` } });
    await raw.opportunity.create({ data: { customerId: c.id, ownerId: owner, name: `${key} 的商机`, amount: 1000 } });
    任务[key] = (await raw.task.create({ data: { customerId: c.id, ownerId: owner, title: `${key} 的待办` } })).id;
  };
  await 建("小王的客户", 小王);
  await 建("小李的客户", 小李);
  await 建("老板的客户", 老板);
  await 建("公海客户", 小李);
  await raw.customerPool.create({ data: { customerId: ids["公海客户"], reason: "手动" } });
  await raw.auditLog.createMany({ data: [
    { userId: 小王, userName: "小王", action: "update", entity: "Customer", entityId: ids["小王的客户"], summary: "小王改的" },
    { userId: 小李, userName: "小李", action: "update", entity: "Customer", entityId: ids["小李的客户"], summary: "小李改的" },
  ] });
}

beforeAll(async () => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 临时.dir;
  设传输(假传输);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await raw.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  await 种数据();
  fs.writeFileSync(path.join(临时.dir, ".team.json"), JSON.stringify({ teamId: "t1xxxxxxxxxx", teamName: "队", joinSecret: "s", key: "k".repeat(43), device: "dWANG01", pulled: 0 }));
  当("wang");
  await 云端说(false);
});

afterAll(async () => {
  设传输(null);
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  忘掉限定();
  await raw.$disconnect();
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

const 客户名 = async () => (await db.customer.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((c) => c.name).sort();

describe("开关", () => {
  it("默认关：业务员只看得到自己的 + 公海", async () => {
    expect(读团队()?.互看 ?? false).toBe(false);
    expect(await 客户名()).toEqual(["公海客户", "小王的客户"].sort());
    expect(await 读的我(raw)).toBe(小王);
    expect(await 只读客户(raw, { salesOwnerId: 小李 })).toBe(false);
  });

  it("云端开了：对齐角色记进 .team.json；老服务器不回这一项 = 不动", async () => {
    await 云端说(true);
    expect(读团队()?.互看).toBe(true);
    await 云端说(undefined);
    expect(读团队()?.互看).toBe(true);
  });
});

describe("开着", () => {
  beforeAll(async () => { 当("wang"); await 云端说(true); });

  it("业务员看得到全队客户、跟进、商机、待办；操作日志照旧只看自己的", async () => {
    expect(await 客户名()).toEqual(["公海客户", "小李的客户", "小王的客户", "老板的客户"].sort());
    expect(await db.followUp.count()).toBe(4);
    expect(await db.opportunity.count()).toBe(4);
    expect(await db.task.count()).toBe(4);
    // 关联带出来的也放开（详情页 include）
    const 李 = await db.customer.findUnique({ where: { id: ids["小李的客户"] }, include: { followUps: true, opportunities: true } });
    expect(李?.followUps).toHaveLength(1); expect(李?.opportunities).toHaveLength(1);
    expect((await db.auditLog.findMany({ select: { summary: true } })).map((a) => a.summary)).toEqual(["小王改的"]);
    // 限定的我 还是小王（写照旧限定），读的我 = 不限
    expect(await 限定的我(raw)).toBe(小王);
    expect(await 读的我(raw)).toBeNull();
    expect(await 只读客户(raw, { salesOwnerId: 小李 })).toBe(true);
    expect(await 只读客户(raw, { salesOwnerId: 小王 })).toBe(false);
    expect(await 只读客户(raw, { salesOwnerId: 小李, pool: { customerId: "x" } })).toBe(false);
  });

  it("同事的客户：改资料、删、在下面建联系人 / 待办、改同事的待办都挡；新加跟进可以；自己的照旧能改", async () => {
    const 李 = ids["小李的客户"];
    await expect(db.customer.update({ where: { id: 李 }, data: { remark: "改同事的" } })).rejects.toBeInstanceOf(只读错误);
    await expect(db.customer.delete({ where: { id: 李 } })).rejects.toBeInstanceOf(只读错误);
    await expect(db.contact.create({ data: { customerId: 李, name: "加个联系人" } })).rejects.toBeInstanceOf(只读错误);
    await expect(db.task.create({ data: { customer: { connect: { id: 李 } }, owner: { connect: { id: 小王 } }, title: "替同事建的待办" } })).rejects.toBeInstanceOf(只读错误);
    await expect(db.task.update({ where: { id: 任务["小李的客户"] }, data: { done: true } })).rejects.toBeInstanceOf(只读错误);
    expect((await db.task.updateMany({ where: { customerId: 李 }, data: { done: true } })).count).toBe(0);
    // 不在了() 认得出，把人话原样给界面
    try { await db.customer.update({ where: { id: 李 }, data: { remark: "x" } }); } catch (e) { expect(不在了(e)).toMatchObject({ ok: false, error: expect.stringContaining("同事的客户") }); }
    // 记录页「改一格」（含外贸档案那几格）：先说人话，不等数据库回找不到
    expect(await patchCustomer(李, "remark", "改同事的")).toMatchObject({ ok: false, error: expect.stringContaining("同事的客户") });
    expect(await patchCustomer(李, "country", "德国")).toMatchObject({ ok: false, error: expect.stringContaining("同事的客户") });
    expect(await patchCustomer(ids["小王的客户"], "remark", "自己的随便改")).toMatchObject({ ok: true });
    const r = await raw.customer.findUnique({ where: { id: 李 } });
    expect(r?.remark ?? null).toBeNull();
    expect((await raw.task.findUnique({ where: { id: 任务["小李的客户"] } }))?.done).toBe(false);
    // 跟进能加
    await db.followUp.create({ data: { customerId: 李, ownerId: 小王, type: "PHONE", title: "", content: "直接建的跟进" } });
    // 自己的照旧
    await db.customer.update({ where: { id: ids["小王的客户"] }, data: { remark: "自己的" } });
    await db.contact.create({ data: { customerId: ids["小王的客户"], name: "自己的联系人" } });
  });

  it("saveFollowUp：同事的客户只能新记跟进；改已有的、带待办 / 计划、未完成的提醒都拒", async () => {
    const 李 = ids["小李的客户"];
    const base = { customerId: 李, type: "PHONE", content: "替同事接了个电话", status: "已完成", occurredAt: new Date().toISOString() };
    const ok = await saveFollowUp(base);
    expect(ok.ok).toBe(true);
    expect((await raw.customer.findUnique({ where: { id: 李 } }))?.lastFollowAt).not.toBeNull();
    const 原 = await raw.followUp.findFirst({ where: { customerId: 李, ownerId: 小李 } });
    expect(await saveFollowUp({ ...base, id: 原!.id, content: "改同事的跟进" })).toMatchObject({ ok: false, error: expect.stringContaining("只能新加跟进") });
    expect(await saveFollowUp({ ...base, 附带: { tasks: [{ title: "顺手建个待办" }] } } as Parameters<typeof saveFollowUp>[0])).toMatchObject({ ok: false, error: expect.stringContaining("请找负责人安排") });
    expect(await saveFollowUp({ ...base, 附带: { tasks: [], plan: { subject: "下周回访", plannedAt: new Date(Date.now() + 864e5).toISOString(), method: "电话" } } } as Parameters<typeof saveFollowUp>[0])).toMatchObject({ ok: false, error: expect.stringContaining("请找负责人安排") });
    expect(await saveFollowUp({ ...base, type: "REMIND", status: "待处理", dueAt: new Date(Date.now() + 864e5).toISOString() })).toMatchObject({ ok: false, error: expect.stringContaining("请找负责人安排") });
    expect(await raw.task.count({ where: { customerId: 李 } })).toBe(1);
    expect(await raw.followPlan.count({ where: { customerId: 李 } })).toBe(0);
    // 自己的客户照旧能带待办
    expect((await saveFollowUp({ ...base, customerId: ids["小王的客户"], 附带: { tasks: [{ title: "自己的待办" }] } } as Parameters<typeof saveFollowUp>[0])).ok).toBe(true);
  });

  it("公海客户不算同事的：照样能领", async () => {
    expect(await 只读客户(raw, { salesOwnerId: 小李, pool: {} })).toBe(false);
  });
});

describe("关回去", () => {
  it("回到只看自己的 + 公海；只读的说法也收起来", async () => {
    当("wang"); await 云端说(false);
    expect(读团队()?.互看).toBe(false);
    expect(await 客户名()).toEqual(["公海客户", "小王的客户"].sort());
    expect(await db.followUp.count({ where: { customerId: ids["小李的客户"] } })).toBe(0);
    expect(await 读的我(raw)).toBe(小王);
    expect(await 只读客户(raw, { salesOwnerId: 小李 })).toBe(false);
  });
});

describe("公海由老板指派", () => {
  it("业务员调不了；分给停用的人不行", async () => {
    当("wang");
    expect(await 分配公海([ids["公海客户"]], 小王)).toMatchObject({ ok: false, error: expect.stringContaining("只有老板") });
    当("boss");
    expect(await 分配公海([ids["公海客户"]], "acct_gone")).toMatchObject({ ok: false, error: expect.stringContaining("不在了") });
    expect(await raw.customerPool.count({ where: { customerId: ids["公海客户"] } })).toBe(1);
  });

  it("老板分给小王：换负责人、删公海那一行、没做完的活跟过去、记操作日志；撤销全还回去", async () => {
    当("boss"); await 云端说(false);
    const id = ids["公海客户"];
    const r = await 分配公海([id], 小王);
    expect(r).toMatchObject({ ok: true, updated: 1, 给谁: { id: 小王, name: "小王" }, 带走: { 计划和待办: 1, 商机: 1 } });
    expect((await raw.customer.findUnique({ where: { id } }))?.salesOwnerId).toBe(小王);
    expect(await raw.customerPool.count({ where: { customerId: id } })).toBe(0);
    expect(await raw.customerClaim.count({ where: { customerId: id, userId: 小王 } })).toBe(1);
    expect((await raw.task.findUnique({ where: { id: 任务["公海客户"] } }))?.ownerId).toBe(小王);
    expect((await raw.opportunity.findFirst({ where: { customerId: id } }))?.ownerId).toBe(小王);
    expect(await raw.auditLog.count({ where: { action: "assign", summary: { contains: "分给「小王」" } } })).toBe(1);
    // 小王那边：现在是他的了
    当("wang");
    expect(await 客户名()).toContain("公海客户");
    expect(await 只读客户(raw, { salesOwnerId: 小王 })).toBe(false);
    // 业务员撤销不了老板的分配
    if (!r.ok) throw Error(r.error);
    expect(await 撤销公海("分配", r.原负责人!, r.带过来, 小王)).toMatchObject({ ok: false });
    当("boss");
    expect(await 撤销公海("分配", r.原负责人!, r.带过来, 小王)).toMatchObject({ ok: true, updated: 1 });
    expect((await raw.customer.findUnique({ where: { id } }))?.salesOwnerId).toBe(小李);
    expect(await raw.customerPool.count({ where: { customerId: id } })).toBe(1);
    expect(await raw.customerClaim.count({ where: { customerId: id, userId: 小王 } })).toBe(0);
    expect((await raw.task.findUnique({ where: { id: 任务["公海客户"] } }))?.ownerId).toBe(小李);
    expect((await raw.opportunity.findFirst({ where: { customerId: id } }))?.ownerId).toBe(小李);
  });

  it("已经被领走的分不了（和领取同一条：删公海那一行数到 0 = 别人先拿了）", async () => {
    当("wang");
    expect((await 领取([ids["公海客户"]])).ok).toBe(true);
    当("boss");
    const r = await 分配公海([ids["公海客户"]], 小李);
    expect(r).toMatchObject({ ok: true, updated: 0 });
    expect((await raw.customer.findUnique({ where: { id: ids["公海客户"] } }))?.salesOwnerId).toBe(小王);
  });
});


describe("商机图片跟着商机走（D-24）", () => {
  let 图: string;
  let 李的商机: string;
  beforeAll(async () => {
    当("wang");
    李的商机 = (await raw.opportunity.findFirstOrThrow({ where: { customerId: ids["小李的客户"] }, select: { id: true } })).id;
    图 = (await raw.attachment.create({ data: { opportunityId: 李的商机, name: "样品.jpg", mime: "image/jpeg", size: 3, sha256: "x".repeat(64), userId: 小李 } })).id;
  });
  afterAll(async () => { await raw.attachment.deleteMany({}); });
  const 列 = () => 列附件路由(new Request(`http://x/api/attachments?opportunityId=${李的商机}`));
  const 传 = () => 传附件路由(new Request(`http://x/api/attachments?opportunityId=${李的商机}&name=a.jpg`, { method: "POST", headers: { "content-type": "image/jpeg", "content-length": "3" }, body: new Uint8Array([1, 2, 3]) }));
  const 按编号 = (方法: "GET" | "DELETE") => (方法 === "GET" ? 取附件路由 : 删附件路由)(new Request(`http://x/api/attachments/${图}`, { method: 方法 }), { params: Promise.resolve({ id: 图 }) });

  it("互看开着：同事商机上的图片列得出来，传、删一律 403", async () => {
    await 云端说(true);
    const r = await 列();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { 附件: { id: string }[] }).附件.map((a) => a.id)).toEqual([图]);
    expect((await 传()).status).toBe(403);
    expect((await 按编号("DELETE")).status).toBe(403);
    expect(await raw.attachment.count({ where: { opportunityId: 李的商机 } })).toBe(1);
  });

  it("互看关着：看不到的商机，列、按编号取、删都是 404，图片还在", async () => {
    await 云端说(false);
    expect((await 列()).status).toBe(404);
    expect((await 按编号("GET")).status).toBe(404);
    expect((await 按编号("DELETE")).status).toBe(404);
    expect((await 传()).status).toBe(404);
    expect(await raw.attachment.count({ where: { opportunityId: 李的商机 } })).toBe(1);
  });
});
