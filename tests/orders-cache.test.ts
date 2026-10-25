/**
 * 订单一览原始行的短时缓存（lib/order-db.ts 订单列表 的 共用）。钉的是：
 * - 对拍：开着缓存和关着，订单列表给的行一模一样（不筛、按负责人筛各一份缓存）
 * - 超期依赖 现在，命中缓存也照传进来的 现在 现算
 * - 刚写的马上反映：新建订单、节点做完、负责人改名、删单，下一次就是新的
 * - 给出去的行改了不影响下一次（共用的行、节点、当前节点都没被碰）
 * - 缓存里放的是拼好的行：命中时不再逐单拼（不再调 toISOString），给出去的和改之前的拼法逐字一样（含键的顺序）
 * - 个人版不走缓存；页面接的是 限定的我
 * 用拷出来的一份库（绝对路径，企业版开只读通道），不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 临时 = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const os = process.getBuiltinModule("node:os") as typeof import("node:os");
  const path = process.getBuiltinModule("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-orders-cache-"));
  const 原连接串 = process.env.DATABASE_URL;
  fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db"), path.join(dir, "O.db"));
  if (fs.existsSync(path.resolve(__dirname, "../prisma/test.db-wal"))) fs.copyFileSync(path.resolve(__dirname, "../prisma/test.db-wal"), path.join(dir, "O.db-wal"));
  process.env.DATABASE_URL = `file:${path.join(dir, "O.db")}`;
  return { dir, 原连接串 };
});

import { defaultClient as raw } from "@/lib/prisma";
import { 关读通道 } from "@/lib/read-pool";
import { 缓存着, 清首页缓存, 首页缓存条数 } from "@/lib/home-cache";
import { 订单列表 } from "@/lib/order-db";
import { 当前节点, 超期数, 进度, 订单的钱 } from "@/lib/order";
import { 规整币种 } from "@/lib/currency";
import { 签约币种, 签约金额 } from "@/lib/money-db";

const 原环境 = { ...process.env };
const 设 = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
const 开 = () => { 设("CRM_ENTERPRISE", "1"); 设("CRM_READ_POOL", undefined); 设("CRM_HOME_CACHE", undefined); };
const 关 = () => 设("CRM_HOME_CACHE", "0");
const 天 = 86_400_000;

let 老板 = "";
let 业务员 = "";
let 客户 = "";

beforeAll(async () => {
  设("DESKTOP_LOCAL", undefined);
  设("MULTI_TENANT", undefined);
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "FollowUpOrder", "TradeOrderDoc", "TradeOrderNode", "TradeOrderPurchase", "TradeOrder", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "ContractOwner", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerPool", "CustomerClaim", "EntMember", "EntDept"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await raw.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await raw.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  老板 = (await raw.user.create({ data: { email: "oc-boss@x.com", name: "老板", password: "x", role: "ADMIN" } })).id;
  业务员 = (await raw.user.create({ data: { email: "oc-sales@x.com", name: "业务员", password: "x", role: "USER" } })).id;
  客户 = (await raw.customer.create({ data: { name: "客户", school: "某公司", phone: "13600000002", salesOwnerId: 老板 } })).id;
  const now = Date.now();
  // 1200 单：跨两批（每批 1000）；每单 4 个节点，到期日前后都有，部分做完、部分不适用
  await raw.tradeOrder.createMany({
    data: Array.from({ length: 1200 }, (_, i) => ({ id: `o${String(i).padStart(4, "0")}`, no: `NO-${i}`, customerId: 客户, ownerId: i % 3 ? 老板 : 业务员, amount: 100 + i, currency: i % 2 ? "USD" : "CNY", depositPaid: i % 5 ? 0 : 50, createdAt: new Date(now - i * 3_600_000) })),
  });
  await raw.tradeOrderNode.createMany({
    data: Array.from({ length: 1200 * 4 }, (_, k) => {
      const i = Math.floor(k / 4), idx = k % 4;
      return { orderId: `o${String(i).padStart(4, "0")}`, idx, name: `节点${idx}`, dueAt: new Date(now + ((i % 21) - 10 + idx * 3) * 天), status: (i + idx) % 6 === 0 ? "已完成" : (i + idx) % 11 === 0 ? "不适用" : "未开始" };
    }),
  });
});

afterEach(() => {
  for (const k of ["CRM_ENTERPRISE", "CRM_READ_POOL", "CRM_HOME_CACHE", "DESKTOP_LOCAL", "MULTI_TENANT"]) 设(k, 原环境[k]);
  清首页缓存();
});

afterAll(async () => {
  await 关读通道();
  await raw.$disconnect();
  process.env.DATABASE_URL = 临时.原连接串;
  fs.rmSync(临时.dir, { recursive: true, force: true });
});

/** 关着缓存现取一份 */
async function 现取(where: { ownerId?: string } = {}, 现在 = new Date()) {
  关();
  const r = await 订单列表(where, 现在);
  开();
  return r;
}

/** 改之前（2026-10-25 拼行进缓存之前）的订单列表原样抄下来当裁判：现查现拼，不走缓存 */
async function 老办法(where: { ownerId?: string } = {}, 现在 = new Date()) {
  const rows = await raw.tradeOrder.findMany({
    where,
    orderBy: { id: "asc" },
    include: {
      customer: { select: { name: true, school: true } },
      nodes: { orderBy: { idx: "asc" }, select: { idx: true, name: true, dueAt: true, status: true, doneAt: true } },
      contract: { select: { signedAt: true, amount: true, money: true } },
      purchase: { select: { supplier: { select: { name: true } } } },
    },
  });
  const 人 = new Map((await raw.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows
    .map((o) => {
      const nodes = o.nodes.map((n) => ({ idx: n.idx, name: n.name, dueAt: n.dueAt?.toISOString() ?? null, status: n.status, doneAt: n.doneAt?.toISOString() ?? null }));
      const 当 = 当前节点(nodes);
      return {
        id: o.id,
        no: o.no,
        customerId: o.customerId,
        customerName: o.customer.name,
        customerCompany: o.customer.school,
        ownerId: o.ownerId,
        ownerName: 人.get(o.ownerId) ?? "（已删除的成员）",
        amount: o.contract ? 签约金额(o.contract) : o.amount,
        currency: o.contract ? 签约币种(o.contract) : 规整币种(o.currency),
        incoterm: o.incoterm,
        payment: o.payment,
        supplier: o.purchase?.supplier?.name ?? null,
        confirmedAt: (o.contract?.signedAt ?? o.createdAt).toISOString(),
        createdAt: o.createdAt.toISOString(),
        nodes,
        当前: 当 ? { idx: 当.idx, name: 当.name } : null,
        超期: 超期数(nodes, 现在),
        进度: 进度(nodes),
        未收: 订单的钱({ ...o, amount: o.contract ? 签约金额(o.contract) : o.amount }).未收,
      };
    })
    .sort((a, b) => b.超期 - a.超期 || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

describe("订单列表：不限定时拼好的行走短时缓存", () => {
  it("开着缓存和关着给的一样；不筛、按人筛各一份", async () => {
    开();
    const 此刻 = new Date();
    const 全 = await 订单列表({}, 此刻, 缓存着);
    expect(全).toHaveLength(1200);
    expect(全.some((r) => r.超期 > 0)).toBe(true);
    expect(全.some((r) => r.nodes.length === 4)).toBe(true);
    expect(全).toEqual(await 现取({}, 此刻));
    expect(await 订单列表({}, 此刻, 缓存着)).toEqual(全);
    const 他的 = await 订单列表({ ownerId: 业务员 }, 此刻, 缓存着);
    expect(他的).toHaveLength(400);
    expect(他的).toEqual(await 现取({ ownerId: 业务员 }, 此刻));
    expect(首页缓存条数()).toBe(2);
  });

  it("超期按传进来的 现在 现算，命中缓存也一样", async () => {
    开();
    const 此刻 = new Date();
    const 一月后 = new Date(此刻.getTime() + 30 * 天);
    const 早 = await 订单列表({}, 此刻, 缓存着);
    const 晚 = await 订单列表({}, 一月后, 缓存着);
    expect(首页缓存条数()).toBe(1);
    const 合计 = (rs: typeof 早) => rs.reduce((n, r) => n + r.超期, 0);
    expect(合计(晚)).toBeGreaterThan(合计(早));
    expect(晚).toEqual(await 现取({}, 一月后));
  });

  it("刚写的下一次就看得到：新建订单、节点做完、负责人改名、删单", async () => {
    开();
    await 订单列表({}, new Date(), 缓存着);
    await raw.tradeOrder.create({ data: { id: "o-new", no: "NO-NEW", customerId: 客户, ownerId: 业务员, amount: 1 } });
    let 末 = await 订单列表({}, new Date(), 缓存着);
    expect(末.some((r) => r.id === "o-new")).toBe(true);

    const 红的 = 末.find((r) => r.超期 > 0)!;
    await raw.tradeOrderNode.updateMany({ where: { orderId: 红的.id }, data: { status: "已完成", doneAt: new Date() } });
    末 = await 订单列表({}, new Date(), 缓存着);
    expect(末.find((r) => r.id === 红的.id)!.超期).toBe(0);

    await raw.user.update({ where: { id: 业务员 }, data: { name: "业务员改名" } });
    末 = await 订单列表({}, new Date(), 缓存着);
    expect(末.find((r) => r.id === "o-new")!.ownerName).toBe("业务员改名");

    await raw.tradeOrder.delete({ where: { id: "o-new" } });
    const 此刻 = new Date();
    末 = await 订单列表({}, 此刻, 缓存着);
    expect(末.some((r) => r.id === "o-new")).toBe(false);
    expect(末).toEqual(await 现取({}, 此刻));
  });

  it("和改之前的拼法逐字一样（含键的顺序）：现取、第一次进缓存、命中缓存、换个 现在 再命中", async () => {
    开();
    // 签约（带精确外币金额和不带的各一张）、供应商、已删除的负责人也走一遍
    const 签 = await raw.contract.create({ data: { customerId: 客户, amount: 8000, signedAt: new Date(Date.now() - 5 * 天), money: { create: { amountExact: 1234.56, currency: "EUR" } } } });
    const 签二 = await raw.contract.create({ data: { customerId: 客户, amount: 900, signedAt: new Date(Date.now() - 2 * 天) } });
    await raw.tradeOrder.update({ where: { id: "o0003" }, data: { contractId: 签.id } });
    await raw.tradeOrder.update({ where: { id: "o0004" }, data: { contractId: 签二.id, incoterm: "FOB", payment: "T/T" } });
    const 供 = await raw.supplier.create({ data: { name: "某工厂" } });
    await raw.tradeOrderPurchase.create({ data: { orderId: "o0005", supplierId: 供.id } });
    await raw.tradeOrder.update({ where: { id: "o0006" }, data: { ownerId: "已经没有这个人" } });
    const 此刻 = new Date();
    const 一月后 = new Date(此刻.getTime() + 30 * 天);
    const 裁判 = JSON.stringify(await 老办法({}, 此刻));
    expect(JSON.stringify(await 现取({}, 此刻))).toBe(裁判);
    expect(JSON.stringify(await 订单列表({}, 此刻, 缓存着))).toBe(裁判);
    expect(JSON.stringify(await 订单列表({}, 此刻, 缓存着))).toBe(裁判);
    expect(JSON.stringify(await 订单列表({}, 一月后, 缓存着))).toBe(JSON.stringify(await 老办法({}, 一月后)));
    expect(JSON.stringify(await 订单列表({ ownerId: 业务员 }, 此刻, 缓存着))).toBe(JSON.stringify(await 老办法({ ownerId: 业务员 }, 此刻)));
    expect(首页缓存条数()).toBe(2);
    const 拼好 = await 订单列表({}, 此刻, 缓存着);
    expect(拼好.find((r) => r.id === "o0003")).toMatchObject({ amount: 1234.56, currency: "EUR" });
    expect(拼好.find((r) => r.id === "o0004")).toMatchObject({ amount: 900, incoterm: "FOB", payment: "T/T" });
    expect(拼好.find((r) => r.id === "o0005")!.supplier).toBe("某工厂");
    expect(拼好.find((r) => r.id === "o0006")!.ownerName).toBe("（已删除的成员）");
    await raw.tradeOrder.updateMany({ where: { id: { in: ["o0003", "o0004"] } }, data: { contractId: null, incoterm: null, payment: null } });
    await raw.tradeOrder.update({ where: { id: "o0006" }, data: { ownerId: 老板 } });
    await raw.tradeOrderPurchase.delete({ where: { orderId: "o0005" } });
    await raw.supplier.delete({ where: { id: 供.id } });
    await raw.contract.deleteMany({ where: { id: { in: [签.id, 签二.id] } } });
  });

  it("命中缓存时不再逐单拼（不调 toISOString），超期照样现算", async () => {
    开();
    const 此刻 = new Date();
    await 订单列表({}, 此刻, 缓存着);
    const 数 = vi.spyOn(Date.prototype, "toISOString");
    try {
      const 晚 = await 订单列表({}, new Date(此刻.getTime() + 30 * 天), 缓存着);
      expect(数).not.toHaveBeenCalled();
      expect(晚.reduce((n, r) => n + r.超期, 0)).toBeGreaterThan((await 订单列表({}, 此刻, 缓存着)).reduce((n, r) => n + r.超期, 0));
    } finally {
      数.mockRestore();
    }
  });

  it("命中缓存给出去的行、节点、当前节点改了，也不影响下一次", async () => {
    开();
    const 此刻 = new Date();
    await 订单列表({}, 此刻, 缓存着);
    const 一 = await 订单列表({}, 此刻, 缓存着);
    const 原样 = structuredClone(一);
    const 有当前 = 一.find((r) => r.当前)!;
    有当前.当前!.name = "被改了";
    有当前.当前!.idx = 99;
    一[1].nodes[0].dueAt = null;
    一[1].nodes.length = 0;
    一[2].超期 = 99;
    一.reverse();
    const 二 = await 订单列表({}, 此刻, 缓存着);
    expect(首页缓存条数()).toBe(1);
    expect(二).toEqual(原样);
  });

  it("给出去的行改了不影响下一次", async () => {
    开();
    const 此刻 = new Date();
    const 一 = await 订单列表({}, 此刻, 缓存着);
    const 原样 = structuredClone(一);
    一[0].nodes[0].status = "被改了";
    一[0].customerName = "被改了";
    一.length = 0;
    const 二 = await 订单列表({}, 此刻, 缓存着);
    expect(首页缓存条数()).toBe(1);
    expect(二).toEqual(原样);
  });

  it("个人版不走缓存", async () => {
    设("CRM_ENTERPRISE", undefined);
    await 订单列表({}, new Date(), 缓存着);
    expect(首页缓存条数()).toBe(0);
  });

  it("页面：不限定才传 缓存着", () => {
    const 源 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/orders/page.tsx"), "utf8");
    expect(源).toMatch(/订单列表\(sp\.ownerId \? \{ ownerId: sp\.ownerId \} : \{\}, new Date\(\), \(await 限定的我\(defaultClient\)\) \? undefined : 缓存着\)/);
  });
});
