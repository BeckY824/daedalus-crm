/**
 * 外贸「订单 = 签约」随机操作序列（2026-10-06 测试分期第 B 期 B.1 / B.2）。
 *
 * 一串随机操作（新建订单、改金额 / 单号 / 付款方式 / 供应商、删订单、商机转为订单、试着重开、挂跟进 / 删跟进 / 撤销、
 * 改档案、换负责人、来回切模版），每一步之后查一遍不变量：
 *   1. 有 contractId 的订单，那笔签约一定在，金额、币种和签约一致
 *   2. 订单号不重
 *   3. 外贸档案一位客户最多一行
 *   4. 跟进挂的订单和跟进是同一位客户的
 *   5. 挂着订单的商机一定是赢单（转为订单之后不会回到进行中 / 丢单）
 *   6. 签约总数 = 订单数 + 没有订单的签约（模版切换后登记的），且没有订单挂到不存在的客户上
 *
 * 平常跑：种子 3 个 × 每个 40 步（几秒）。长测：FUZZ_SEEDS=30 FUZZ_STEPS=400 npx vitest run tests/trade-fuzz.test.ts
 * 挂了：报错里有种子和第几步，把那个种子加进 固定种子 变成回归用例。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user, requireAdmin: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { saveContract, deleteContract, patchCustomer } from "@/app/(app)/customers/actions";
import { saveFollowUp, deleteFollowUp, restoreFollowUp } from "@/app/(app)/customers/[id]/actions";
import { setOppStatus } from "@/app/(app)/opportunities/actions";
import { 签约金额, 签约币种 } from "@/lib/money-db";

const 种子数 = Number(process.env.FUZZ_SEEDS ?? 3);
const 步数 = Number(process.env.FUZZ_STEPS ?? 40);
/** 挂过的种子：固定下来当回归用例 */
const 固定种子: number[] = [];

/** 小而确定的伪随机（mulberry32） */
function 随机(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, 挑: <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)], 整: (n: number) => Math.floor(next() * n) };
}

let 甲 = "";
let 乙 = "";

async function 设模版(外贸: boolean) {
  await setSetting("business", BUSINESS_PRESETS[外贸 ? "外贸出口" : "通用销售"]);
  invalidateSettingsCache();
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  甲 = (await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } })).id;
  乙 = (await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } })).id;
  mocks.user = { id: 甲, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});
afterAll(async () => { await prisma.$disconnect(); });

async function 查不变量(说: string) {
  const 单们 = await prisma.tradeOrder.findMany({ include: { contract: { include: { money: true } }, customer: { select: { id: true } } } });
  for (const o of 单们) {
    if (o.contractId) {
      expect(o.contract, `${说}：订单 ${o.no} 的签约不在了`).toBeTruthy();
      expect(o.contract!.customerId, `${说}：订单 ${o.no} 和签约不是同一位客户`).toBe(o.customerId);
      expect(o.amount, `${说}：订单 ${o.no} 金额和签约不一致`).toBeCloseTo(签约金额(o.contract!), 2);
      expect(o.currency, `${说}：订单 ${o.no} 币种和签约不一致`).toBe(签约币种(o.contract!));
    }
  }
  const 号 = 单们.map((o) => o.no);
  expect(new Set(号).size, `${说}：订单号重了 ${号.join(",")}`).toBe(号.length);
  const 档 = await prisma.customerExtra.groupBy({ by: ["customerId"], _count: { _all: true } });
  expect(档.every((g) => g._count._all === 1), `${说}：外贸档案一位客户不止一行`).toBe(true);
  const 挂 = await prisma.followUpOrder.findMany({ include: { followUp: { select: { customerId: true } }, order: { select: { customerId: true } } } });
  for (const x of 挂) expect(x.followUp.customerId, `${说}：跟进挂了别的客户的订单`).toBe(x.order.customerId);
  const 有单的商机 = await prisma.opportunity.findMany({ where: { tradeOrders: { some: {} } }, select: { name: true, status: true } });
  for (const o of 有单的商机) expect(o.status, `${说}：商机「${o.name}」挂着订单却不是赢单`).toBe("WON");
}

async function 跑一个种子(seed: number) {
  const r = 随机(seed);
  let 外贸 = true;
  await 设模版(true);
  const 客户们 = [];
  for (let i = 0; i < 3; i++) {
    客户们.push(await prisma.customer.create({ data: { name: `客户${i}`, phone: `1380000${seed % 1000}${i}`.slice(0, 11), salesOwnerId: 甲 } }));
  }
  const 删掉的跟进: Awaited<ReturnType<typeof deleteFollowUp>>[] = [];
  for (let 步 = 0; 步 < 步数; 步++) {
    const c = r.挑(客户们);
    const 动作 = r.整(12);
    const 说 = `种子 ${seed} 第 ${步} 步（动作 ${动作}）`;
    try {
      if (动作 === 0 || 动作 === 1) {
        // 新建订单（外贸）/ 登记签约（通用）
        await saveContract({
          customerId: c.id, amount: 1 + r.整(5000), currency: r.挑(["USD", "EUR", "CNY"]), signedAt: new Date(2026, r.整(12), 1 + r.整(27)), remark: null,
          订单: { no: r.next() < 0.3 ? `PI-${r.整(6)}` : "", payment: r.挑([null, "T/T", "L/C"]), supplier: r.挑([null, "", "甲厂", "乙厂"]) },
        });
      } else if (动作 === 2) {
        // 编辑一笔签约：改金额 / 币种 / 订单那几格
        const k = await prisma.contract.findFirst({ where: { customerId: c.id }, include: { order: true } });
        if (k) {
          await saveContract({
            id: k.id, customerId: c.id, amount: 1 + r.整(5000), currency: r.挑(["USD", "EUR", "CNY", undefined]) ?? undefined, signedAt: k.signedAt, remark: null, force: true,
            订单: { no: r.next() < 0.3 ? `PI-${r.整(6)}` : (k.order?.no ?? ""), payment: r.挑([null, "T/T"]), supplier: r.挑([undefined, "甲厂", ""]) },
          });
        }
      } else if (动作 === 3) {
        const k = await prisma.contract.findFirst({ where: { customerId: c.id } });
        if (k) await deleteContract(k.id, r.next() < 0.1 ? r.挑(客户们).id : c.id, null);
      } else if (动作 === 4) {
        // 商机 → 转为订单
        const o = await prisma.opportunity.create({ data: { name: `商机${步}`, customerId: c.id, amount: 1 + r.整(900), ownerId: 甲 } });
        await saveContract({ customerId: c.id, amount: 1 + r.整(900), currency: "USD", signedAt: new Date(), remark: null, force: true, 联动: { 赢单: [o.id], 完成计划: [], 完成待办: [] }, 订单: {} });
      } else if (动作 === 5) {
        // 试着把一个赢单商机改回进行中 / 丢单
        const o = await prisma.opportunity.findFirst({ where: { customerId: c.id, status: "WON" } });
        if (o) await setOppStatus(o.id, r.挑(["OPEN", "LOST"] as const));
      } else if (动作 === 6) {
        // 记一条跟进，可能挂订单（可能故意挂别人的）
        const 单 = await prisma.tradeOrder.findFirst({ where: r.next() < 0.8 ? { customerId: c.id } : {} });
        await saveFollowUp({ customerId: c.id, type: "OTHER", content: `记录${步}`, status: "已完成", occurredAt: new Date().toISOString(), ...(单 ? { orderId: 单.id } : {}) });
      } else if (动作 === 7) {
        const f = await prisma.followUp.findFirst({ where: { customerId: c.id } });
        if (f) {
          const d = await deleteFollowUp(f.id, c.id);
          if (d.ok) 删掉的跟进.push(d);
        }
      } else if (动作 === 8) {
        const d = 删掉的跟进.pop();
        if (d && d.ok) await restoreFollowUp(d.快照);
      } else if (动作 === 9) {
        await patchCustomer(c.id, r.挑(["country", "whatsapp", "email", "source", "wechat"] as const), r.挑([null, "美国", "+1 415 555 0101", "a@b.com", "展会"]));
      } else if (动作 === 10) {
        await patchCustomer(c.id, "salesOwnerId", r.挑([甲, 乙]));
      } else {
        外贸 = !外贸;
        await 设模版(外贸);
      }
    } catch (e) {
      throw new Error(`${说} 抛了：${(e as Error).message}`);
    }
    await 查不变量(说);
  }
}

describe("外贸订单 = 签约：随机操作序列下不变量都成立（B.2）", () => {
  const 种子们 = [...固定种子, ...Array.from({ length: 种子数 }, (_, i) => 1000 + i * 7919)];
  for (const seed of 种子们) {
    it(`种子 ${seed}`, async () => {
      await 跑一个种子(seed);
    }, Math.max(60_000, 步数 * 1500));
  }
});
