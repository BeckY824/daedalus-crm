/**
 * 操作留痕。
 *
 * 「全员可见可改」这个决策成立的前提就是有据可查，所以这组用例盯两件事：
 *   1. 该记的都记了，而且记的内容人能看懂
 *   2. 记录本身足够结实——成员被删也不该带走历史，写日志失败也不该拖垮业务
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { saveCustomer, deleteCustomers, saveContract, assignSalesOwner } from "@/app/(app)/customers/actions";
import { recordAudit } from "@/lib/audit";

let jia: { id: string };
let yi: { id: string };

beforeEach(async () => {
  await resetDb();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  yi = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});

afterAll(async () => { await prisma.$disconnect(); });

async function 建一个(name = "学员", phone = "13800000001") {
  const r = await saveCustomer({
    name, phone, school: null, grade: null, major: null,
    followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null,
    remark: null, salesOwnerId: jia.id, channelId: null, referrerCustomerId: null,
  });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

async function 最新日志() {
  return prisma.auditLog.findFirstOrThrow({ orderBy: { at: "desc" } });
}

describe("该记的都记了", () => {
  it("新建学员留下一条能读懂的记录", async () => {
    await 建一个("张三");
    const log = await 最新日志();
    expect(log.action).toBe("create");
    expect(log.entity).toBe("Customer");
    expect(log.summary).toContain("张三");
    expect(log.userName).toBe("甲");
  });

  it("修改学员要记下改了哪几项、前后各是什么", async () => {
    const id = await 建一个("张三");
    const 行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const base = {
      name: 行.name, phone: 行.phone, school: 行.school, grade: 行.grade, major: 行.major,
      followStatus: 行.followStatus, decisionStatus: 行.decisionStatus,
      expectedSignAt: 行.expectedSignAt, remark: 行.remark, salesOwnerId: 行.salesOwnerId,
      channelId: 行.channelId, referrerCustomerId: 行.referrerCustomerId,
    };
    await saveCustomer({
      id, updatedAt: 行.updatedAt.toISOString(), base,
      ...base, school: "北京大学", followStatus: "意向较高",
    } as Parameters<typeof saveCustomer>[0]);

    const log = await 最新日志();
    expect(log.action).toBe("update");
    expect(log.summary).toContain("院校");
    expect(log.summary).toContain("跟进状态");

    const detail = JSON.parse(log.detail!) as { 字段: string; 原值: string; 新值: string }[];
    const 院校 = detail.find((d) => d.字段 === "院校");
    expect(院校?.原值).toBe("（空）");
    expect(院校?.新值).toBe("北京大学");
  });

  it("删除学员要在删之前把名字留下来", async () => {
    const id = await 建一个("要删的", "13800000002");
    await deleteCustomers([id]);
    const log = await 最新日志();
    expect(log.action).toBe("delete");
    expect(log.summary).toContain("要删的");
  });

  it("批量转派记录实际影响的条数和目标负责人", async () => {
    const a = await 建一个("甲的", "13800000003");
    const b = await 建一个("乙的", "13800000004");
    await assignSalesOwner([a, b], yi.id);
    const log = await 最新日志();
    expect(log.action).toBe("assign");
    expect(log.summary).toContain("2 名学员");
    expect(log.summary).toContain("乙");
  });

  it("登记签约要记金额；确认过重复的那次要标出来", async () => {
    const id = await 建一个("签约的", "13800000005");
    const 今天 = new Date(2026, 7, 29, 10, 0, 0);
    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    expect((await 最新日志()).summary).toContain("19,800");

    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null, force: true });
    expect((await 最新日志()).summary).toContain("已确认不是重复录入");
  });

  it("被查重拦下、没真正写进去的那次，不该留下记录", async () => {
    const id = await 建一个("查重的", "13800000006");
    const 今天 = new Date(2026, 7, 29, 10, 0, 0);
    await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    const 之前 = await prisma.auditLog.count();

    const 被拦 = await saveContract({ customerId: id, amount: 19800, signedAt: 今天, remark: null });
    expect(被拦.ok).toBe(false);
    expect(await prisma.auditLog.count()).toBe(之前);
  });

  it("并发合并写入也要留痕，并标明是合并的", async () => {
    const id = await 建一个("被合并的", "13800000007");
    const 行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const base = {
      name: 行.name, phone: 行.phone, school: 行.school, grade: 行.grade, major: 行.major,
      followStatus: 行.followStatus, decisionStatus: 行.decisionStatus,
      expectedSignAt: 行.expectedSignAt, remark: 行.remark, salesOwnerId: 行.salesOwnerId,
      channelId: 行.channelId, referrerCustomerId: 行.referrerCustomerId,
    };
    const 甲版本 = 行.updatedAt.toISOString();

    // 乙先改院校
    const 乙行 = await prisma.customer.findUniqueOrThrow({ where: { id } });
    await saveCustomer({
      id, updatedAt: 乙行.updatedAt.toISOString(), base, ...base, school: "北京大学",
    } as Parameters<typeof saveCustomer>[0]);

    // 甲拿旧版本改专业，走合并路径
    const r = await saveCustomer({
      id, updatedAt: 甲版本, base, ...base, major: "计算机",
    } as Parameters<typeof saveCustomer>[0]);
    expect(r.ok).toBe(true);

    const log = await 最新日志();
    expect(log.summary).toContain("专业");
    expect(log.summary).toContain("自动合并");
  });
});

describe("记录本身要结实", () => {
  it("成员被删掉，他的历史操作记录仍然在", async () => {
    await 建一个("张三");
    const 之前 = await prisma.auditLog.count();
    expect(之前).toBeGreaterThan(0);

    // 先把学员清掉，否则 salesOwner 外键挡着删不了人
    await prisma.customer.deleteMany();
    await prisma.user.delete({ where: { id: jia.id } });

    const log = await 最新日志();
    expect(log.userName).toBe("甲"); // 姓名是冗余存的，不随人消失
    expect(await prisma.auditLog.count()).toBeGreaterThanOrEqual(之前);
  });

  it("写日志失败不能把业务操作带下水", async () => {
    const 原create = prisma.auditLog.create;
    // @ts-expect-error 故意塞一个会抛错的实现
    prisma.auditLog.create = async () => { throw new Error("模拟日志表写坏了"); };
    try {
      const id = await 建一个("日志坏了也要能建档", "13800000008");
      expect(id).toBeTruthy();
      expect(await prisma.customer.count({ where: { id } })).toBe(1);
    } finally {
      prisma.auditLog.create = 原create;
    }
  });

  it("不记录任何密码内容", async () => {
    await recordAudit({
      user: { id: jia.id, name: "甲" },
      action: "password", entity: "User", entityId: jia.id,
      summary: "甲 修改了自己的登录密码",
    });
    const log = await 最新日志();
    expect(log.summary).not.toMatch(/[Cc]rm@|password|密码是/);
    expect(log.detail).toBeNull();
  });
});
