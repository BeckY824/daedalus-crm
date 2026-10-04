/**
 * 上线前第 2 期 2b · 字段与叫法（「字段去除」这一类）。
 *
 * 三种理解都钉一遍：
 *   1. 业务配置里删掉一个选项（职位 / 行业）：老记录照样显示、能筛、能编辑不报错、导出再导入认得回来
 *   2. 改叫法 / 档案字段名：冲突提示、导出表头跟着变，导出的文件导回来照样认得（L-056 / L-057）
 *   3. 清空一格：存得住空、整表保存 / 行内改别的都不把它填回来、导出是空、导入「只补空」时表里空着的那格不算可补
 * 「删掉选项的线索来源照样能改备注」在 undo-and-guards.test.ts（D5）；同步不回填在 sync-local.test.ts。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "我", email: "me@local", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user, getCurrentUser: async () => mocks.user }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, redirect: () => { throw new Error("REDIRECT"); } }));
for (const m of ["@/app/(app)/customers/CustomersView", "@/app/(app)/customers/[id]/RecordView"]) vi.doMock(m, () => ({ default: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 造本人 } from "./r2-data-helpers";
import { saveCustomer, patchCustomer } from "@/app/(app)/customers/actions";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { 客户导出表 } from "@/app/(app)/customers/export-table";
import { 执行导入, type 导入方案 } from "@/app/(app)/customers/import-actions";
import { toCsv } from "@/lib/csv";
import { 解析CSV, 成表 } from "@/lib/import/parse";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { getBusiness, saveBusiness, DEFAULT_BUSINESS, type BusinessConfig } from "@/lib/business";
import { invalidateSettingsCache } from "@/lib/settings";

let 我: string;
beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  我 = (await 造本人()).id;
  mocks.user = { ...mocks.user, id: 我 };
});
afterAll(async () => {
  invalidateSettingsCache();
  await prisma.$disconnect();
});

/** 编辑框打开那一刻：拿库里的值当 base，提交时只盖 patch 那几格 */
async function 打开编辑框(id: string) {
  const r = await prisma.customer.findUniqueOrThrow({ where: { id } });
  const base = {
    name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major,
    followStatus: r.followStatus, decisionStatus: r.decisionStatus, expectedSignAt: r.expectedSignAt,
    remark: r.remark, salesOwnerId: r.salesOwnerId, channelId: r.channelId, referrerCustomerId: r.referrerCustomerId,
  };
  return (patch: Record<string, unknown>) =>
    saveCustomer({ id, updatedAt: r.updatedAt.toISOString(), base, ...base, ...patch } as Parameters<typeof saveCustomer>[0]);
}

/** 当前配置下：导出全部 → 拼成 CSV → 清库 → 原样导回来 */
async function 导出再导回(b: BusinessConfig) {
  const r = await 导出客户({});
  if (!r.ok) throw new Error(r.error);
  const { head, body } = 客户导出表(r.rows, b);
  const t = 成表(解析CSV(toCsv(head, body)));
  await prisma.customer.deleteMany();
  const w = await 执行导入({ 表头: t.表头, 数据: t.数据, 映射: 猜列(t.表头, 字段表(b)), 重复行: "跳过" }, "导出的.csv");
  if (!w.ok) throw new Error(w.error);
  return { head, 新建: w.新建 };
}

const 客户页 = async (sp: Record<string, string>) =>
  ((await (await import("@/app/(app)/customers/page")).default({ searchParams: Promise.resolve(sp) } as never)) as {
    props: { rows: { name: string; grade: string | null }[]; 旧职位: string[] };
  }).props;

describe("业务配置里删掉一个选项：老记录照常", () => {
  it("职位删了「高管」：老客户照样显示、筛选下拉还给这一项、按它筛得出、记录页打得开", async () => {
    await saveBusiness({ ...DEFAULT_BUSINESS, grades: DEFAULT_BUSINESS.grades.filter((g) => g !== "高管") });
    expect((await getBusiness()).grades).not.toContain("高管");
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", grade: "高管", salesOwnerId: 我 } });
    await prisma.customer.create({ data: { name: "李工", phone: "13800000002", grade: "技术", salesOwnerId: 我 } });

    const 全部 = await 客户页({});
    expect(全部.rows.find((r) => r.name === "王总")?.grade).toBe("高管");
    expect(全部.旧职位, "删掉的职位还有人在用：筛选下拉照样给").toEqual(["高管"]);
    expect((await 客户页({ grade: "高管" })).rows.map((r) => r.name)).toEqual(["王总"]);
    await expect((await import("@/app/(app)/customers/[id]/page")).default({ params: Promise.resolve({ id: c.id }), searchParams: Promise.resolve({}) } as never)).resolves.toBeTruthy();
  });

  it("职位删了「高管」：编辑框只改备注、行内改别的格都存得进去，职位原样留着", async () => {
    await saveBusiness({ ...DEFAULT_BUSINESS, grades: DEFAULT_BUSINESS.grades.filter((g) => g !== "高管") });
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", grade: "高管", salesOwnerId: 我 } });
    expect(await (await 打开编辑框(c.id))({ remark: "要样品" })).toMatchObject({ ok: true });
    expect(await patchCustomer(c.id, "school", "远山资本")).toMatchObject({ ok: true });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ grade: "高管", remark: "要样品", school: "远山资本" });
  });

  it("职位删了「高管」、行业删了「教育」：导出再导回来，两格原样落回", async () => {
    const b = { ...DEFAULT_BUSINESS, grades: DEFAULT_BUSINESS.grades.filter((g) => g !== "高管"), industries: DEFAULT_BUSINESS.industries.filter((x) => x !== "教育") };
    await saveBusiness(b);
    await prisma.customer.create({ data: { name: "王总", phone: "13800000001", grade: "高管", major: "教育", salesOwnerId: 我 } });
    expect((await 导出再导回(await getBusiness())).新建).toBe(1);
    expect(await prisma.customer.findFirstOrThrow({ select: { grade: true, major: true } })).toEqual({ grade: "高管", major: "教育" });
  });
});

describe("改叫法：提示和导出跟着变，导回来照样认得", () => {
  const 教培: BusinessConfig = { ...DEFAULT_BUSINESS, customer: "学员", fields: { school: "院校", grade: "年级", major: "专业" } };

  it("L-056 冲突提示按这家的叫法说：两个窗口都改了年级 → 「年级」，不是写死的「职位」", async () => {
    await saveBusiness(教培);
    const c = await prisma.customer.create({ data: { name: "小王", phone: "13800000001", grade: "大一", salesOwnerId: 我 } });
    const 窗口1 = await 打开编辑框(c.id);
    const 窗口2 = await 打开编辑框(c.id);
    expect(await 窗口1({ grade: "大二", name: "小王同学" })).toMatchObject({ ok: true });
    const r = await 窗口2({ grade: "大三", name: "王同学" });
    expect(r.ok).toBe(false);
    if (r.ok || !r.conflict) throw new Error("应该撞了");
    expect(r.conflict.fields.sort()).toEqual(["学员姓名", "年级"].sort());
    expect(r.conflict.fields.join("")).not.toMatch(/职位|客户/);
  });

  it("L-057 导出表头跟叫法走（学员姓名、院校、年级、专业），导回来每一列都认得", async () => {
    await saveBusiness(教培);
    await prisma.customer.create({ data: { name: "小王", phone: "13800000001", school: "北大", grade: "大一", major: "法学", salesOwnerId: 我 } });
    const { head } = await 导出再导回(await getBusiness());
    expect(head.slice(0, 5)).toEqual(["学员姓名", "联系电话", "院校", "专业", "年级"]);
    expect(head.join("")).not.toContain("客户");
    expect(猜列(head, 字段表(await getBusiness())).slice(0, 5)).toEqual(["name", "phone", "school", "major", "grade"]);
    expect(await prisma.customer.findFirstOrThrow({ select: { name: true, school: true, grade: true, major: true } })).toEqual({ name: "小王", school: "北大", grade: "大一", major: "法学" });
  });
});

describe("清空一格：存得住空，别处不给填回来", () => {
  it("编辑框清空公司 → 库里是空；再打开编辑框只改备注，公司还是空；行内改别的格也不回填", async () => {
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", school: "远山资本", grade: "高管", salesOwnerId: 我 } });
    expect(await (await 打开编辑框(c.id))({ school: "" })).toMatchObject({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).school).toBeNull();
    expect(await (await 打开编辑框(c.id))({ remark: "改个备注" })).toMatchObject({ ok: true });
    expect(await patchCustomer(c.id, "major", "金融")).toMatchObject({ ok: true });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ school: null, remark: "改个备注", major: "金融" });
  });

  it("行内清空职位（给空串 / 只有空格）→ 存成空，不存一个空格", async () => {
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", grade: "高管", salesOwnerId: 我 } });
    expect(await patchCustomer(c.id, "grade", "  ")).toMatchObject({ ok: true });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).grade).toBeNull();
  });

  it("清空之后导出那一格是空的，不写「null」「—」", async () => {
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", school: "远山资本", salesOwnerId: 我 } });
    await patchCustomer(c.id, "school", null);
    const r = await 导出客户({});
    if (!r.ok) throw new Error(r.error);
    const { head, body } = 客户导出表(r.rows, DEFAULT_BUSINESS);
    expect(body[0][head.indexOf("公司")]).toBe("");
  });

  /*
    预览那一步的「补空 N」现在按「库里认得出的人数」算、不看格子（J-050，已知未修，r2-data-import 里那条 skip），
    所以这里只钉真正落库的结果：表里空着的那格不算可补、库里照旧是空
  */
  it("导入「只补空」：表里那格也是空的 → 不算可补，库里照旧是空、算跳过", async () => {
    const c = await prisma.customer.create({ data: { name: "王总", phone: "13800000001", school: "远山资本", salesOwnerId: 我 } });
    await patchCustomer(c.id, "school", null);
    const t = 成表(解析CSV("姓名,手机号,公司\n王总,13800000001,\n"));
    const 方案: 导入方案 = { 表头: t.表头, 数据: t.数据, 映射: 猜列(t.表头, 字段表(DEFAULT_BUSINESS)), 重复行: "补空" };
    const w = await 执行导入(方案, "a.csv");
    expect(w).toMatchObject({ ok: true, 补空: 0, 跳过: 1 });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).school).toBeNull();
  });
});
