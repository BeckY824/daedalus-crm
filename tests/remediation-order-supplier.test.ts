import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa", role: "ADMIN", title: "管理员" } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => state.user }));
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { BUSINESS_PRESETS } from "@/lib/business-config";
import { saveContract } from "@/app/(app)/customers/actions";

let customerId: string;
let suppliers: { id: string; name: string }[];
beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  const u = await prisma.user.create({ data: { name: "QA", email: "qa-binding", password: "unused", role: "ADMIN" } });
  state.user.id = u.id;
  customerId = (await prisma.customer.create({ data: { name: "QA-绑定客户", phone: "", salesOwnerId: u.id } })).id;
  await setSetting("business", BUSINESS_PRESETS["外贸出口"]);
  invalidateSettingsCache();
  // 团队同步或旧数据可能留下同名档案，不能靠新建表单禁止重名来排除此场景。
  suppliers = [
    await prisma.supplier.create({ data: { name: "QA-同名工厂", createdAt: new Date("2026-01-01") } }),
    await prisma.supplier.create({ data: { name: "QA-同名工厂", createdAt: new Date("2026-02-01") } }),
  ];
});
afterAll(async () => { await prisma.$disconnect(); });
const base = () => ({ customerId, amount: 100, currency: "USD", signedAt: new Date("2026-10-08"), remark: null });

describe("W-049 订单供应商引用", () => {
  it("编辑时重复提交原供应商名字，也必须保留原ID", async () => {
    const k = await prisma.contract.create({ data: { customerId, amount: 100, signedAt: new Date("2026-10-08") } });
    const order = await prisma.tradeOrder.create({ data: { contractId: k.id, customerId, ownerId: state.user.id, no: "QA-KEEP", amount: 100, purchase: { create: { supplierId: suppliers[1].id } } } });
    expect((await saveContract({ ...base(), id: k.id, remark: "QA-只改备注", 订单: { supplier: "QA-同名工厂" } })).ok).toBe(true);
    expect((await prisma.tradeOrderPurchase.findUniqueOrThrow({ where: { orderId: order.id } })).supplierId).toBe(suppliers[1].id);
  });

  it("没有明确ID的新订单遇到重名应拒绝并回滚签约，不猜最早那家", async () => {
    expect(await saveContract({ ...base(), 订单: { supplier: "QA-同名工厂" } })).toMatchObject({ ok: false, error: expect.stringContaining("同名") });
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.tradeOrder.count()).toBe(0);
  });

  it("明确选中的ID优先于重复名字", async () => {
    const input = { ...base(), 订单: { supplier: "QA-同名工厂", supplierId: suppliers[1].id } };
    expect((await saveContract(input)).ok).toBe(true);
    expect((await prisma.tradeOrderPurchase.findFirstOrThrow()).supplierId).toBe(suppliers[1].id);
  });

  it("已删除的选中ID拒绝并回滚，不按名字偷偷选另一家", async () => {
    const input = { ...base(), 订单: { supplier: "QA-同名工厂", supplierId: "qa-missing" } };
    expect(await saveContract(input)).toMatchObject({ ok: false, error: expect.stringContaining("供应商") });
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.tradeOrder.count()).toBe(0);
  });
});
