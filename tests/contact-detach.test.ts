/**
 * 联系人「只移出、不删」（2026-10-01 用户反馈：在客户详情里删联系人，联系人页里也跟着没了）。
 *
 * 移出的人搬进 UnassignedContact，不留在 Contact 里加标记——钉的头一条就是为什么：
 * 原来那位客户之后被删了，他也还在（留在 Contact 里会被级联删掉）。
 * 其余是撤销能原样撤回去：同一个 id、关键联系人、原来指着他的跟进记录。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/app/(app)/contacts/ContactsView", () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { deleteCustomers, saveCustomer } from "@/app/(app)/customers/actions";
import ContactsPage from "@/app/(app)/contacts/page";
import {
  detachContact, undoDetachContact, saveUnassignedContact,
  deleteContact, deleteUnassignedContact, restoreContact,
} from "@/app/(app)/customers/[id]/actions";
import { 名字在别处 } from "@/lib/agent/find-name";

let A: { id: string };
let B: { id: string };

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { email: "a@x", name: "甲", title: "管理员", role: "ADMIN", password: "x" } });
  mocks.user.id = u.id;
  A = await prisma.customer.create({ data: { name: "甲公司", phone: "13800000001", salesOwnerId: u.id } });
  B = await prisma.customer.create({ data: { name: "乙公司", phone: "13800000002", salesOwnerId: u.id } });
});

afterAll(async () => { await prisma.$disconnect(); });

/** 删除成功才有快照（对方已经删了时回 ok: false） */
function 快照<T>(r: { ok: true; 快照: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.快照;
}

/** A 下面一位关键联系人王经理，外加一位普通的李助理；王经理名下有一条跟进 */
async function 造人() {
  const 王 = await prisma.contact.create({ data: { customerId: A.id, name: "王经理", phone: "13900000001", isPrimary: true } });
  const 李 = await prisma.contact.create({ data: { customerId: A.id, name: "李助理" } });
  const f = await prisma.followUp.create({
    data: { customerId: A.id, contactId: 王.id, ownerId: mocks.user.id, type: "CALL", title: "电话", content: "聊了报价", status: "已完成", occurredAt: new Date() },
  });
  return { 王, 李, f };
}

describe("只移出", () => {
  it("J-022 撤销条消失后仍保留关键身份；编辑未归属资料、挂回原客户均不丢", async () => {
    const { 王, f } = await 造人(); await detachContact(王.id);
    expect((await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).wasPrimary).toBe(true);
    expect((await saveUnassignedContact({ id: 王.id, name: "王经理改名", remark: "补充" })).ok).toBe(true);
    expect((await saveUnassignedContact({ id: 王.id, name: "王经理改名", customerId: A.id })).ok).toBe(true);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ isPrimary: true, customerId: A.id });
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBe(王.id);
  });
  it("J-022 挂到其他客户不擅自替换他的关键联系人，显式取消原关键也生效", async () => {
    const { 王 } = await 造人(); const other = await prisma.contact.create({ data: { name: "乙客户关键", customerId: B.id, isPrimary: true } });
    await detachContact(王.id); await saveUnassignedContact({ id: 王.id, name: "王经理", customerId: B.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).isPrimary).toBe(false);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: other.id } })).isPrimary).toBe(true);
    await detachContact(other.id); await saveUnassignedContact({ id: other.id, name: "乙客户关键", customerId: B.id, isPrimary: false });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: other.id } })).isPrimary).toBe(false);
  });
  it("J-022 未归属彻底删除再撤销，持久关键身份仍在；未知旧数据保持未知", async () => {
    const { 王 } = await 造人(); await detachContact(王.id); const snapshot = 快照(await deleteUnassignedContact(王.id));
    expect((await restoreContact(snapshot)).ok).toBe(true);
    expect((await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).wasPrimary).toBe(true);
    await saveUnassignedContact({ id: 王.id, name: "王经理", customerId: A.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).isPrimary).toBe(true);
    await prisma.unassignedContact.create({ data: { id: "legacy", name: "旧联系人", fromCustomerId: A.id, ownerId: mocks.user.id } });
    expect((await prisma.unassignedContact.findUniqueOrThrow({ where: { id: "legacy" } })).wasPrimary).toBeNull();
    await saveUnassignedContact({ id: "legacy", name: "旧联系人", customerId: A.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: "legacy" } })).isPrimary).toBe(false);
  });
  it("J-022 删除客户保留联系人时也记录原身份；挂回失败不损坏原人或身份", async () => {
    const { 王 } = await 造人(); await deleteCustomers([A.id]);
    const u = await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } }); expect(u.wasPrimary).toBe(true);
    await prisma.$executeRawUnsafe("CREATE TRIGGER qa_attach_fail BEFORE INSERT ON Contact BEGIN SELECT RAISE(ABORT, 'QA attach unavailable'); END");
    try { expect(await saveUnassignedContact({ id: 王.id, name: "王经理", customerId: B.id, isPrimary: true })).toMatchObject({ ok: false, error: expect.any(String) }); }
    finally { await prisma.$executeRawUnsafe("DROP TRIGGER qa_attach_fail"); }
    expect(await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).toEqual(u);
    expect(await prisma.contact.count({ where: { id: 王.id } })).toBe(0);
  });
  it("J-017 原客户名带空白可搜出移出的人，客户删除后仍可查", async () => {
    const { 王 } = await 造人(); await detachContact(王.id);
    for (const deleted of [false, true]) {
      if (deleted) await deleteCustomers([A.id]);
      const page = await ContactsPage({ searchParams: Promise.resolve({ keyword: " 甲公司 " }) });
      expect(page.props.总数).toBeGreaterThan(0); expect(page.props.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: 王.id, 原来: "甲公司", wasPrimary: true, fromCustomerId: A.id })]));
    }
  });
  it("J-006 直接调用仍拒绝把自己当推荐人", async () => {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: A.id } });
    expect(await saveCustomer({ ...c, updatedAt: c.updatedAt.toISOString(), expectedSignAt: null, referrerCustomerId: A.id })).toMatchObject({ ok: false, error: expect.stringContaining("本人") });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: A.id } })).referrerCustomerId).toBeNull();
  });
  it("客户名下没了，未归属里有他；跟进记录留着、只是不再写跟谁谈的", async () => {
    const { 王, f } = await 造人();
    const r = await detachContact(王.id);
    expect(r).toMatchObject({ ok: true, 原来是关键: true });

    expect(await prisma.contact.findUnique({ where: { id: 王.id } })).toBeNull();
    const u = await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } });
    expect(u).toMatchObject({ name: "王经理", phone: "13900000001", fromCustomerId: A.id, fromCustomerName: "甲公司", ownerId: mocks.user.id });
    expect(JSON.parse(u.followUpIds!)).toEqual([f.id]);
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBeNull();
  });

  it("原来那位客户之后被删了，他还在", async () => {
    const { 王 } = await 造人();
    await detachContact(王.id);
    expect(await deleteCustomers([A.id])).toMatchObject({ ok: true, deleted: 1 });
    expect(await prisma.unassignedContact.findUnique({ where: { id: 王.id } })).toMatchObject({ ownerId: mocks.user.id });
  });

  it("撤销：同一个 id 回到原来那位，关键联系人原样回来、跟进接回去", async () => {
    const { 王, 李, f } = await 造人();
    const r = await detachContact(王.id);
    // 移出那几秒里有人把李助理设成了关键——撤销回来以后关键只能有一个
    await prisma.contact.update({ where: { id: 李.id }, data: { isPrimary: true } });
    await undoDetachContact(王.id, r.ok ? r.原来是关键 : false);

    const 回来 = await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } });
    expect(回来).toMatchObject({ customerId: A.id, isPrimary: true, phone: "13900000001" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: 李.id } })).isPrimary).toBe(false);
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBe(王.id);
    expect(await prisma.unassignedContact.count()).toBe(0);
  });

  it("原来那位已经删了，撤销撤不回去，人还留在未归属", async () => {
    const { 王 } = await 造人();
    await detachContact(王.id);
    await deleteCustomers([A.id]);
    expect(await undoDetachContact(王.id, true)).toMatchObject({ ok: false });
    expect(await prisma.unassignedContact.findUnique({ where: { id: 王.id } })).not.toBeNull();
  });
});

describe("联系人页上改未归属的人", () => {
  it("不挑客户只改资料，还留在未归属", async () => {
    const { 王 } = await 造人();
    await detachContact(王.id);
    const r = await saveUnassignedContact({ id: 王.id, name: "王经理", phone: "13900000009", wechat: "wang" });
    expect(r).toMatchObject({ ok: true, 挂到: null });
    expect(await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ phone: "13900000009", wechat: "wang" });
  });

  it("挂到别的客户下面：成了乙公司的联系人，甲公司那条跟进不跟过去", async () => {
    const { 王, f } = await 造人();
    await detachContact(王.id);
    const r = await saveUnassignedContact({ id: 王.id, name: "王经理", phone: "13900000001", customerId: B.id, isPrimary: false });
    expect(r).toMatchObject({ ok: true, 挂到: "乙公司" });
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ customerId: B.id });
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBeNull();
    expect(await prisma.unassignedContact.count()).toBe(0);
  });

  it("挂回原来那位：跟进接回去", async () => {
    const { 王, f } = await 造人();
    await detachContact(王.id);
    await saveUnassignedContact({ id: 王.id, name: "王经理", customerId: A.id, isPrimary: false });
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBe(王.id);
  });
});

describe("彻底删除 + 撤销", () => {
  it("挂着的：删了两边都没了；撤销后同一个 id 回来，跟进接回去", async () => {
    const { 王, f } = await 造人();
    const r = await deleteContact(王.id);
    expect(await prisma.contact.findUnique({ where: { id: 王.id } })).toBeNull();
    expect(await prisma.unassignedContact.count()).toBe(0);

    expect(await restoreContact(快照(r))).toMatchObject({ ok: true });
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ customerId: A.id, isPrimary: true });
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: f.id } })).contactId).toBe(王.id);
  });

  it("未归属的：删了再撤销，还是未归属、原来是谁的也记着", async () => {
    const { 王 } = await 造人();
    await detachContact(王.id);
    const r = await deleteUnassignedContact(王.id);
    expect(await prisma.unassignedContact.count()).toBe(0);
    await restoreContact(快照(r));
    expect(await prisma.unassignedContact.findUniqueOrThrow({ where: { id: 王.id } })).toMatchObject({ fromCustomerName: "甲公司", ownerId: mocks.user.id });
  });

  it("撤销点两次不会建出两条", async () => {
    const { 王 } = await 造人();
    const r = await deleteContact(王.id);
    await restoreContact(快照(r));
    await restoreContact(快照(r));
    expect(await prisma.contact.count({ where: { id: 王.id } })).toBe(1);
  });
});

describe("AI 按名字找人", () => {
  it("未归属的人也找得到，写明未归属、原来是谁的", async () => {
    const { 王 } = await 造人();
    await detachContact(王.id);
    const 命中 = await 名字在别处("王经理", (p) => p);
    const 联系人 = 命中.find((h) => h.表 === "联系人");
    expect(联系人?.记录).toEqual([expect.objectContaining({ 姓名: "王经理", 属于: "未归属（原来在甲公司下面）" })]);
  });
});

describe("对方已经删了", () => {
  it("再删一次不抛，回一句话", async () => {
    const { 王 } = await 造人();
    await deleteContact(王.id);
    expect(await deleteContact(王.id)).toMatchObject({ ok: false });
    expect(await deleteUnassignedContact(王.id)).toMatchObject({ ok: false });
  });
});
