/**
 * 列表页服务端取数交给界面的东西（2026-10-04 回归核对 J-018 / J-014）。
 *
 * 四张列表页（线索 / 商机 / 联系人 / 跟进）都是服务端组件：取数在 page.tsx 里，结果当 props 交给 *View。
 * 把视图换成桩、直接调 page，就能看它交出去的「共 N 条」和行。
 *
 *   J-018 「共 N 条」原来是 take: 300 取回来的行数——库里 305 条，界面写「共 300 条」。现在单独 count
 *   J-014 联系人页搜索框写着能搜微信，原来不搜；挂在客户上的和「未归属」的都要搜得到
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/app/(app)/leads/LeadsView", () => ({ default: () => null }));
vi.mock("@/app/(app)/opportunities/OpportunitiesView", () => ({ default: () => null }));
vi.mock("@/app/(app)/contacts/ContactsView", () => ({ default: () => null }));
vi.mock("@/app/(app)/follow-ups/FollowUpsView", () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人, 造客户 } from "./r2-data-helpers";
import LeadsPage from "@/app/(app)/leads/page";
import OpportunitiesPage from "@/app/(app)/opportunities/page";
import ContactsPage from "@/app/(app)/contacts/page";
import FollowUpsPage from "@/app/(app)/follow-ups/page";

type 元素 = { props: Record<string, unknown> };
const 空 = () => Promise.resolve({});

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => { await prisma.$disconnect(); });

const 条数 = 305;
const 一串 = <T,>(生成: (i: number) => T) => Array.from({ length: 条数 }, (_, i) => 生成(i));

describe("J-018 四张列表页「共 N 条」是真总数，不是 take: 300 的上限", () => {
  it("线索 305 条 → 总数 305", async () => {
    await prisma.lead.createMany({ data: 一串((i) => ({ name: `线索${i}`, ownerId: 我 })) });
    const el = (await LeadsPage({ searchParams: 空() })) as unknown as 元素;
    expect(el.props.总数).toBe(条数);
    expect((el.props.rows as unknown[]).length).toBe(300);
  });

  it("商机 305 条 → 总数 305", async () => {
    const c = await 造客户(我);
    await prisma.opportunity.createMany({ data: 一串((i) => ({ name: `商机${i}`, customerId: c.id, ownerId: 我, amount: 1 })) });
    const el = (await OpportunitiesPage({ searchParams: 空() })) as unknown as 元素;
    expect(el.props.总数).toBe(条数);
  });

  it("联系人 308 位（挂着的 303 + 未归属 5）→ 总数 308，不是取回来的 300 + 5", async () => {
    const c = await 造客户(我);
    await prisma.contact.createMany({ data: Array.from({ length: 303 }, (_, i) => ({ name: `联系人${i}`, customerId: c.id })) });
    await prisma.unassignedContact.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ id: `散${i}`, name: `散的${i}` })) });
    const el = (await ContactsPage({ searchParams: 空() })) as unknown as 元素;
    expect(el.props.总数).toBe(308);
  });

  it("跟进 305 条 → 总数 305", async () => {
    const c = await 造客户(我);
    await prisma.followUp.createMany({ data: 一串((i) => ({ type: "PHONE", title: `跟进${i}`, content: "聊过", customerId: c.id, ownerId: 我 })) });
    const el = (await FollowUpsPage({ searchParams: 空() })) as unknown as 元素;
    expect(el.props.总数).toBe(条数);
  });
});

describe("J-014 联系人页按微信号搜", () => {
  it("只有微信号的联系人：挂在客户上的、未归属的，按微信号都搜得到", async () => {
    const c = await 造客户(我, { name: "远山资本" });
    await prisma.contact.create({ data: { name: "王总", customerId: c.id, wechat: "wx_wang_2026" } });
    await prisma.contact.create({ data: { name: "李总", customerId: c.id, wechat: "li_other" } });
    await prisma.unassignedContact.create({ data: { id: "散1", name: "赵姐", wechat: "wx_zhao_2026" } });
    const el = (await ContactsPage({ searchParams: Promise.resolve({ keyword: "_2026" }) })) as unknown as 元素;
    const rows = el.props.rows as { name: string; 未归属: boolean }[];
    expect(rows.map((r) => [r.name, r.未归属])).toEqual([["王总", false], ["赵姐", true]]);
    expect(el.props.总数).toBe(2);
  });
});
