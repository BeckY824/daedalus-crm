/**
 * 企业版开关关着时，和 main 逐字段一致（差分测试，2026-10-24）。
 *
 * 一家 25 人的公司（老板、3 位主管、21 位销售）连跑 7 天：建档、记跟进、推节点、放回 / 领取项目公海、
 * 客户公海放进 / 领取 / 分配、改负责人、加项目组员、勾验收、离职转交，每天收工时扫一遍公海。
 * 只用 main 上已有的写操作；企业版新加的维护（超时回收）有就调、没有就跳，关着时应当什么都不做。
 * 跨月末（3 月 28 日到 4 月 3 日），每天还有零点前后各一批操作，看日界线。
 *
 * 单独跑只是冒烟：动作都跑得完。CI 里设 OFF_DIFF_OUT，把整个库和每一步的返回倒成 JSON，
 * 同一个场景在这次改动和 main 上各跑一遍，再用 compare.mjs 逐字段比（见 .github/workflows/ci.yml 的 off-diff）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "", email: "", role: "ADMIN", title: "", avatar: null as string | null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "../reset";
import { saveBusiness, getBusiness } from "@/lib/business";
import { saveUser, deactivateUser } from "@/app/(app)/settings/actions";
import { saveCustomer, patchCustomer, assignSalesOwner, type CustomerInput } from "@/app/(app)/customers/actions";
import { 放进公海, 领取, 分配公海 } from "@/app/(app)/customers/pool-actions";
import { saveFollowUp, saveContact } from "@/app/(app)/customers/[id]/actions";
import { 建档向导, 改项目节点, 放回项目公海, 领取项目, 勾项目交付, 编辑项目, 加项目组员 } from "@/app/(app)/projects/actions";
import { 自动掉公海 } from "@/lib/pool-db";
import { 节点们 } from "@/lib/project/nodes";
import { 倒库, 规整 } from "./dump";

type 人 = { id: string; name: string; email: string; role: string; title: string; avatar: null };
type 步 = { 天: number; 时: string; 谁: string; 做: string; 参: unknown; 回: unknown };

const 步们: 步[] = [];
let 天 = 0;

/** 固定种子的随机数（mulberry32）：两边跑出同一串选择 */
function 随机(种子: number) {
  let a = 种子 >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const 骰 = 随机(20261024);
const 挑 = <T,>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(骰() * xs.length)] : undefined);

/** 上海时间 2030-03-28 起第 d 天的 h:m */
const 时刻 = (d: number, h: number, m = 0) => new Date(Date.UTC(2030, 2, 28 + d, h - 8, m));
let 钟 = 时刻(0, 9);
function 拨到(t: Date) {
  钟 = t;
  vi.setSystemTime(钟);
}
/** 每做一步往前走几分钟，同一天里先后分得清 */
function 走一步() {
  拨到(new Date(钟.getTime() + (1 + Math.floor(骰() * 9)) * 60_000));
}

async function 做(谁: 人, 名: string, 参: unknown, f: () => Promise<unknown>) {
  走一步();
  mocks.user = 谁;
  let 回: unknown;
  try {
    回 = await f();
  } catch (e) {
    回 = { 抛出: e instanceof Error ? e.message : String(e) };
  }
  步们.push({ 天, 时: 钟.toISOString(), 谁: 谁.email, 做: 名, 参, 回 });
  return 回 as { ok?: boolean; error?: string; projectId?: string; customerId?: string; id?: string };
}

/** 按插入顺序（rowid）取，两边一致；createdAt 是库用真实时钟填的，不能拿来排 */
async function 按序<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}
type 项目行 = { id: string; ownerId: string; phase: string; node: string; result: string | null; pooledAt: unknown; customerId: string };
const 项目们 = () => 按序<项目行>(`SELECT id, ownerId, phase, node, result, pooledAt, customerId FROM Project ORDER BY rowid`);
type 客户行 = { id: string; salesOwnerId: string | null; 在公海: number };
const 客户们 = () => 按序<客户行>(
  `SELECT c.id, c.salesOwnerId, (SELECT COUNT(*) FROM CustomerPool p WHERE p.customerId = c.id) AS 在公海 FROM Customer c ORDER BY c.rowid`,
);

const 全部节点 = (Object.entries(节点们) as [string, readonly string[]][]).flatMap(([phase, ns]) => ns.map((node) => ({ phase, node })));
function 下一节点(p: 项目行) {
  const i = 全部节点.findIndex((x) => x.phase === p.phase && x.node === p.node);
  return i >= 0 ? 全部节点[i + 1] : undefined;
}

let 老板: 人;
const 主管们: 人[] = [];
const 销售们: 人[] = [];
const 在职 = new Set<string>();
let 号 = 0;
const 新号 = () => `139${String(++号).padStart(8, "0")}`;

function 客户输入(谁: 人, 名: string): CustomerInput {
  return {
    name: 名, phone: 新号(), school: null, grade: null, major: null,
    followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null,
    salesOwnerId: 谁.id, channelId: null, referrerCustomerId: null,
  };
}

async function 一个人的一天(u: 人, d: number) {
  const 我的项目 = (await 项目们()).filter((p) => p.ownerId === u.id && !p.pooledAt && !p.result);
  const 我的客户 = (await 客户们()).filter((c) => c.salesOwnerId === u.id && !c.在公海);

  if (骰() < 0.5) {
    const 名 = `客户${d}-${u.email}`;
    const 参 = {
      客户: 客户输入(u, 名),
      联系人: { name: `${名}联系人`, position: "采购", phone: 新号() },
      项目: { name: `${名}项目`, amount: 1000 * (1 + Math.floor(骰() * 50)), currency: "CNY" },
      跟进: { type: "PHONE", content: "第一次电话", occurredAt: 钟.toISOString() },
    };
    await 做(u, "建档向导", 参, () => 建档向导(参));
  } else if (骰() < 0.3) {
    const 参 = 客户输入(u, `散客${d}-${u.email}`);
    await 做(u, "saveCustomer", 参, () => saveCustomer(参));
  }

  const c = 挑(我的客户);
  if (c && 骰() < 0.7) {
    const 参 = { customerId: c.id, type: "PHONE", content: `第 ${d} 天跟进`, status: "已完成", occurredAt: 钟.toISOString() };
    await 做(u, "saveFollowUp", 参, () => saveFollowUp(参));
  }
  if (c && 骰() < 0.2) {
    const 参 = { customerId: c.id, name: `补的联系人${d}`, phone: 新号(), isPrimary: false };
    await 做(u, "saveContact", 参, () => saveContact(参));
  }
  if (c && 骰() < 0.2) {
    const [k, v] = 挑([["country", "德国"], ["remark", `第 ${d} 天备注`], ["followStatus", "跟进中"], ["level", "A"]] as const)!;
    await 做(u, "patchCustomer", { id: c.id, k, v }, () => patchCustomer(c.id, k, v));
  }

  const p = 挑(我的项目);
  if (p && 骰() < 0.6) {
    const 到 = 下一节点(p);
    if (到) await 做(u, "改项目节点", { id: p.id, 到 }, () => 改项目节点(p.id, 到));
  }
  if (p && 骰() < 0.15) {
    await 做(u, "放回项目公海", { id: p.id }, () => 放回项目公海(p.id));
    // 放回去的人当场想领回来：main 上不让（关着时也必须不让）
    await 做(u, "领取项目(本人)", { id: p.id }, () => 领取项目(p.id));
  }
  if (p && 骰() < 0.15) {
    const 参 = { name: `${d} 改名`, amount: 8800 };
    await 做(u, "编辑项目", { id: p.id, ...参 }, () => 编辑项目(p.id, 参));
  }
  if (p && 骰() < 0.1) {
    const 谁 = 挑(销售们.filter((x) => x.id !== u.id && 在职.has(x.id)))!;
    await 做(u, "加项目组员", { id: p.id, 谁: 谁.id }, () => 加项目组员(p.id, 谁.id, null));
  }
  if (p && p.phase === "订单" && 骰() < 0.5) {
    await 做(u, "勾项目交付", { id: p.id }, () => 勾项目交付(p.id, "acceptancePassed", true));
  }

  // 项目公海里有别人的，领一个；同一个第二个人再领应当说已经被领走
  const 公海项目 = (await 项目们()).filter((x) => x.pooledAt && x.ownerId !== u.id);
  const q = 挑(公海项目);
  if (q && 骰() < 0.4) {
    await 做(u, "领取项目", { id: q.id }, () => 领取项目(q.id));
    const 又一个 = 挑(销售们.filter((x) => x.id !== u.id && 在职.has(x.id)));
    if (又一个) await 做(又一个, "领取项目(晚一步)", { id: q.id }, () => 领取项目(q.id));
  }

  if (c && 骰() < 0.1) await 做(u, "放进公海", { ids: [c.id] }, () => 放进公海([c.id]));
  const 公海客户 = (await 客户们()).filter((x) => x.在公海);
  const 捡 = 挑(公海客户);
  if (捡 && 骰() < 0.2) await 做(u, "领取", { ids: [捡.id] }, () => 领取([捡.id]));
}

async function 主管的一天(m: 人) {
  const 公海客户 = (await 客户们()).filter((x) => x.在公海);
  const c = 挑(公海客户);
  const 给 = 挑(销售们.filter((x) => 在职.has(x.id)));
  if (c && 给) await 做(m, "分配公海", { ids: [c.id], 给: 给.id }, () => 分配公海([c.id], 给.id));
  const 别人的 = (await 客户们()).filter((x) => !x.在公海 && x.salesOwnerId);
  const d = 挑(别人的);
  const 接 = 挑(销售们.filter((x) => 在职.has(x.id)));
  if (d && 接 && 骰() < 0.5) await 做(m, "assignSalesOwner", { ids: [d.id], 给: 接.id }, () => assignSalesOwner([d.id], 接.id));
  // 主管替人推一步节点、领公海项目
  const p = 挑((await 项目们()).filter((x) => !x.pooledAt && !x.result));
  const 到 = p && 下一节点(p);
  if (p && 到 && 骰() < 0.5) await 做(m, "改项目节点(主管)", { id: p.id, 到 }, () => 改项目节点(p.id, 到));
}

/** 收工：首页加载时会做的维护。企业版的超时回收 main 上没有，有就调（关着时应当一行不写） */
async function 收工(d: number) {
  拨到(时刻(d, 23, 59));
  await 做(老板, "自动掉公海", {}, () => 自动掉公海(老板));
  const 企业版维护 = await import(/* @vite-ignore */ ["@/lib/project", "db"].join("/")).catch(() => ({})) as Record<string, unknown>;
  if (typeof 企业版维护.公海超时收回 === "function") {
    mocks.user = 老板;
    await (企业版维护.公海超时收回 as (me: 人) => Promise<number>)(老板);
  }
}

beforeAll(async () => {
  delete process.env.CRM_ENTERPRISE;
  vi.useFakeTimers({ toFake: ["Date"] });
  拨到(时刻(0, 8));
  await resetDb();
  await saveBusiness({ ...(await getBusiness()), projectMode: true, poolDays: 3 });
  const a = await prisma.user.create({ data: { email: "boss", name: "老板", title: "总经理", role: "ADMIN", password: "x" } });
  老板 = { id: a.id, name: a.name, email: a.email, role: a.role, title: a.title, avatar: null };
  在职.add(a.id);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("开关关着跑一周（差分测试的场景）", () => {
  it("25 人 7 天，动作都跑得完", async () => {
    // 第 0 天早上：老板建 24 位成员
    for (let i = 1; i <= 24; i++) {
      const role = i <= 3 ? "MANAGER" : "SALES";
      const email = role === "MANAGER" ? `m${i}` : `s${String(i).padStart(2, "0")}`;
      const 参 = { name: `${role === "MANAGER" ? "主管" : "销售"}${i}`, email, title: "", role, password: "password-123", active: true };
      await 做(老板, "saveUser", 参, () => saveUser(参));
    }
    for (const u of await prisma.user.findMany({ where: { id: { not: 老板.id } }, orderBy: { email: "asc" } })) {
      const x = { id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, avatar: null };
      (u.role === "MANAGER" ? 主管们 : 销售们).push(x);
      在职.add(u.id);
    }
    expect(主管们.length + 销售们.length).toBe(24);

    for (天 = 0; 天 < 7; 天++) {
      拨到(时刻(天, 9));
      for (const u of 销售们) if (在职.has(u.id)) await 一个人的一天(u, 天);
      for (const m of 主管们) await 主管的一天(m);

      // 第 3 天下午：一位销售离职，名下全转给另一位（转移离职）
      if (天 === 3) {
        const 走 = 销售们[4], 接 = 销售们[5];
        拨到(时刻(天, 17));
        await 做(老板, "deactivateUser", { 走: 走.id, 接: 接.id }, () => deactivateUser(走.id, 接.id));
        在职.delete(走.id);
        // 离职的人还想领公海里的项目：账号已停用
        const q = (await 项目们()).find((x) => x.pooledAt && x.ownerId !== 走.id);
        if (q) await 做(走, "领取项目(已离职)", { id: q.id }, () => 领取项目(q.id));
      }

      // 零点前后：23:59 收工扫一遍，00:00:30 有人记跟进（看日界线）
      await 收工(天);
      拨到(new Date(时刻(天 + 1, 0).getTime() + 30_000));
      const 夜猫 = 销售们[0];
      const c = (await 客户们()).find((x) => x.salesOwnerId === 夜猫.id && !x.在公海);
      if (c) await 做(夜猫, "saveFollowUp(零点后)", { customerId: c.id }, () =>
        saveFollowUp({ customerId: c.id, type: "PHONE", content: "零点后补记", status: "已完成", occurredAt: 钟.toISOString() }));
    }

    expect(步们.length).toBeGreaterThan(150);
    const 成了 = 步们.filter((s) => (s.回 as { ok?: boolean } | null)?.ok === true).length;
    expect(成了).toBeGreaterThan(50);

    const out = process.env.OFF_DIFF_OUT;
    if (out) {
      const { 表, 列 } = await 倒库();
      const 好 = 规整(表, 步们);
      writeFileSync(out, JSON.stringify({ 列, 表: 好.表, 步: 好.其它 }, null, 1));
    }
  }, 300_000);
});
