/**
 * 企业版导入 · 裁判：拿 tests/fixtures/ent-sample/ 那份脏样例（scripts/make-ent-import-sample.py 生成）整套走一遍。
 * 对账：试跑报告的数 = 写入结果的数 = 库里真实多出来的行，逐条对得上；跳过的正好是 说明.md 里放的那几种脏数据。
 * 零丢失：源表每一行不是写进去了（有对照），就是报告里说了跳过；写进去的名称 / 电话 / 跟进内容和源表一样。
 * 幂等：同一批再导一次，库里一条不多、一格不变。
 * 来回：两批都撤回后，除了日志表，库里每张表和导入前逐行一样。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 试跑 } from "@/lib/enterprise-import/report";
import { 写一批, type 写入结果 } from "@/lib/enterprise-import/apply";
import { 撤回一批 } from "@/lib/enterprise-import/revert";
import { 读文件, type 读出的表 } from "@/lib/enterprise-import/excel";
import { 实体顺序, type 实体, type 待写 } from "@/lib/enterprise-import/types";

const 目录 = join(__dirname, "fixtures", "ent-sample");
const 读 = (名: string) => 读文件({ 名, bytes: new Uint8Array(readFileSync(join(目录, 名))) });
const 我 = { id: "tester-id", name: "测试员" };
const 表名: Record<实体, string> = { customer: "customer", contact: "contact", lead: "lead", opportunity: "opportunity", followup: "followUp" };

/** 说明.md 里放的、该跳过的脏数据（类别 → 条数） */
const 该跳过: Partial<Record<实体, Record<string, number>>> = {
  customer: { 缺必填: 1, "ID 重复": 1 },
  contact: { 客户不唯一: 2, 找不到客户: 2, 缺必填: 1 },
  opportunity: { 找不到客户: 1 },
  followup: { 找不到客户: 1 },
};

/* 日志 / 回收区本来就会多出来，不算在「来回」里；其余每张表都比 */
const 不比 = new Set(["AuditLog", "EntImportBatch", "EntImportRow", "EntTrash", "EntSnapshot"]);
type 快照 = Record<string, string[]>;
async function 拍(): Promise<快照> {
  const 照: 快照 = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    if (不比.has(m.name)) continue;
    const d = (prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[m.name[0].toLowerCase() + m.name.slice(1)];
    照[m.name] = (await d.findMany()).map((r) => JSON.stringify(r)).sort();
  }
  return 照;
}
const 行数 = (照: 快照) => Object.fromEntries(Object.entries(照).map(([k, v]) => [k, v.length]));

function 列(t: 读出的表, 头: string) {
  const i = t.表头.indexOf(头);
  expect(i, `${t.名} 没有「${头}」列`).toBeGreaterThanOrEqual(0);
  return t.行.map((r) => String(r[i] ?? "").trim());
}
const 合计 = (报告: typeof 报告1) => (k: "新建" | "更新" | "没变" | "并入" | "待写") => 实体顺序.reduce((a, e) => a + 报告.按类[e][k], 0);
const 数字 = (s: string) => s.replace(/\D/g, "").replace(/^86(?=1\d{10}$)/, "");

let 表们: 读出的表[] = [];
let 已有客户Id = "";
let 默认负责人 = "";
let 导入前: 快照 = {};
let 批1 = "";
let 报告1: Awaited<ReturnType<typeof 试跑>>["报告"];
let 写1: 写入结果;
let 导入后: 快照 = {};
let 批2 = "";

beforeAll(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });

  // 测试机上的准备：按员工名单建在职的账号（王芳、李强各两个），再建说明里那家已有客户
  const 员工 = 读("员工与部门.xlsx");
  const [名, 邮箱, 职位, 状态] = ["姓名", "邮箱", "职位", "在职状态"].map((h) => 列(员工, h));
  for (let i = 0; i < 名.length; i++) {
    if (状态[i] === "在职") await prisma.user.create({ data: { email: 邮箱[i], name: 名[i], title: 职位[i], role: "SALES", password: "x" } });
  }
  expect(await prisma.user.count({ where: { role: "SALES" } })).toBe(26);
  const 说明 = readFileSync(join(目录, "说明.md"), "utf8").match(/已有客户：「(.+?)」，电话 (\d+)/)!;
  已有客户Id = (await prisma.customer.create({ data: { name: 说明[1], phone: 说明[2], salesOwnerId: 我.id, remark: "测试机上本来就有" } })).id;

  表们 = ["客户.xlsx", "联系人.xlsx", "商机.xlsx", "跟进记录.xlsx"].map(读);
  导入前 = await 拍();

  const 试 = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
  批1 = 试.批次Id;
  报告1 = 试.报告;
  默认负责人 = 报告1.映射.默认负责人.id;
  写1 = await 写一批(批1, 我);
  导入后 = await 拍();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("裁判 · 对账", () => {
  it("四个文件都认对了实体，没有读文件的提醒", () => {
    expect(表们.map((t) => [t.名, t.实体, t.提醒])).toEqual([
      ["客户.xlsx", "customer", []],
      ["联系人.xlsx", "contact", []],
      ["商机.xlsx", "opportunity", []],
      ["跟进记录.xlsx", "followup", []],
    ]);
  });

  it("跳过的正好是说明里放的那几种脏数据，一条不多一条不少", () => {
    for (const e of 实体顺序) {
      const 实际: Record<string, number> = {};
      for (const q of 报告1.问题) if (q.实体 === e && q.级别 === "跳过") 实际[q.类别] = (实际[q.类别] ?? 0) + 1;
      expect(实际, e).toEqual(该跳过[e] ?? {});
      expect(报告1.按类[e].跳过, e).toBe(Object.values(实际).reduce((a, b) => a + b, 0));
    }
  });

  it("报告 = 写入结果：新建、更新逐类加起来对得上；跳过 = 报告里跳过的 + 同批并入的 + 没变的；零失败零冲突", () => {
    const 合 = 合计(报告1);
    expect(写1).toMatchObject({ 状态: "done", 完了: true, 失败: 0, 冲突: 0 });
    expect(写1.总数).toBe(合("待写"));
    expect(写1.写到).toBe(写1.总数);
    expect(写1.新建).toBe(合("新建"));
    expect(写1.更新).toBe(合("更新"));
    expect(写1.跳过).toBe(报告1.合计.跳过 + 合("并入") + 合("没变"));
    expect(合("没变")).toBe(0);
    // 同电话的三对并成三家；测试机上那家已有客户被连上（更新一条），不另建
    expect(报告1.按类.customer).toMatchObject({ 并入: 3, 更新: 1 });
  });

  it("报告 = 库里真实多出来的行：每类新建数 = 行数增量；对照数 = 待写数", () => {
    const 前 = 行数(导入前);
    const 后 = 行数(导入后);
    const 模型: Record<实体, string> = { customer: "Customer", contact: "Contact", lead: "Lead", opportunity: "Opportunity", followup: "FollowUp" };
    for (const e of 实体顺序) expect(后[模型[e]] - 前[模型[e]], e).toBe(报告1.按类[e].新建);
    expect(后.EntExternalRef - 前.EntExternalRef).toBe(报告1.合计.待写);
    expect(后.User).toBe(前.User);
  });

  it("逐条：计划里每一条都有一行记账和一条对照，动作和报告说的一样，指向的记录真在库里", async () => {
    const 批 = await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批1 } });
    const 计划 = JSON.parse(批.plan!) as 待写[];
    const 账 = new Map((await prisma.entImportRow.findMany({ where: { batchId: 批1 } })).map((r) => [`${r.entity}|${r.externalId}`, r]));
    const 照 = new Map((await prisma.entExternalRef.findMany({ where: { batchId: 批1 } })).map((r) => [`${r.entity}|${r.externalId}`, r]));
    expect(账.size).toBe(计划.length);
    expect(照.size).toBe(计划.length);
    for (const w of 计划) {
      const k = `${w.实体}|${w.外部ID}`;
      const r = 账.get(k)!;
      expect(r, k).toBeDefined();
      expect(照.get(k)?.targetId, k).toBe(r.targetId);
      if (w.并入) {
        expect(r.kind, k).toBe("update");
        expect(r.targetId, k).toBe(照.get(`${w.实体}|${w.并入}`)?.targetId);
      } else if (w.目标) {
        expect([k, r.kind, r.targetId]).toEqual([k, "update", w.目标.本地ID]);
      } else {
        expect(r.kind, k).toBe("create");
      }
      const d = (prisma as unknown as Record<string, { count: (a: object) => Promise<number> }>)[表名[w.实体]];
      expect(await d.count({ where: { id: r.targetId } }), k).toBe(1);
    }
  });
});

describe("裁判 · 零丢失", () => {
  it("源表每一行：要么写进去了（有对照），要么报告里说了跳过", async () => {
    for (const t of 表们) {
      const e = t.实体!;
      const 写了 = await prisma.entExternalRef.count({ where: { batchId: 批1, entity: e } });
      const 跳了 = 报告1.问题.filter((q) => q.实体 === e && q.级别 === "跳过").length;
      expect([t.名, 写了 + 跳了]).toEqual([t.名, t.行.length]);
    }
    expect(报告1.合计.记录).toBe(报告1.合计.待写 + 报告1.合计.跳过);
  });

  it("写进去的客户：名称、电话和源表一样；同号并入的指向同一家；已有客户只补空，名字和负责人不动", async () => {
    const t = 表们[0];
    const [编号, 名称, 电话] = ["客户编号", "客户名称", "联系电话"].map((h) => 列(t, h));
    const 跳 = new Set(报告1.问题.filter((q) => q.实体 === "customer" && q.级别 === "跳过").map((q) => q.行号));
    const 已有 = await prisma.customer.findUniqueOrThrow({ where: { id: 已有客户Id } });
    let 比了 = 0;
    for (let i = 0; i < 编号.length; i++) {
      if (跳.has(t.行号[i])) continue;
      const ref = await prisma.entExternalRef.findUniqueOrThrow({ where: { source_entity_externalId: { source: "excel", entity: "customer", externalId: 编号[i] } } });
      const c = await prisma.customer.findUniqueOrThrow({ where: { id: ref.targetId } });
      expect(数字(c.phone ?? ""), 编号[i]).toBe(数字(电话[i]));
      expect(c.name, 编号[i]).toBe(c.id === 已有客户Id ? 已有.name : 名称[i]);
      比了++;
    }
    expect(比了).toBe(编号.length - 跳.size);
    expect(已有).toMatchObject({ salesOwnerId: 我.id });
    expect(已有.remark).toContain("测试机上本来就有");
    // 两家不同电话的「华信电子有限公司」照写两家
    expect(await prisma.customer.count({ where: { name: "华信电子有限公司" } })).toBe(2);
  });

  it("报告上的默认负责人是能当负责人的业务员（导入的是管理员也一样），不会报告说给 A、实际落到 B", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: 默认负责人 } });
    expect(u.role).toBe("SALES");
  });

  it("负责人：写邮箱的认到本人；只写重名名字、离职、英文名、空着的落默认负责人，报告里都提醒了", async () => {
    const t = 表们[0];
    const [编号, 负责人] = ["客户编号", "客户负责人"].map((h) => 列(t, h));
    const 跳 = new Set(报告1.问题.filter((q) => q.实体 === "customer" && q.级别 === "跳过").map((q) => q.行号));
    const 并入的 = new Set((JSON.parse((await prisma.entImportBatch.findUniqueOrThrow({ where: { id: 批1 } })).plan!) as 待写[]).filter((w) => w.并入 || w.目标).map((w) => w.外部ID));
    const 提醒了 = new Set(报告1.问题.filter((q) => q.实体 === "customer" && q.类别 === "负责人对不上").map((q) => q.外部ID));
    const 用户们 = await prisma.user.findMany();
    const 邮箱到人 = new Map(用户们.map((u) => [u.email, u.id]));
    const 见过 = { 邮箱: 0, 落默认: 0 };
    for (let i = 0; i < 编号.length; i++) {
      if (跳.has(t.行号[i]) || 并入的.has(编号[i])) continue; // 并入 / 连上已有的：负责人跟着那一家
      const ref = await prisma.entExternalRef.findUniqueOrThrow({ where: { source_entity_externalId: { source: "excel", entity: "customer", externalId: 编号[i] } } });
      const c = await prisma.customer.findUniqueOrThrow({ where: { id: ref.targetId } });
      const 写法 = 负责人[i];
      if (写法.includes("@")) {
        expect(c.salesOwnerId, 编号[i]).toBe(邮箱到人.get(写法));
        见过.邮箱++;
      } else if (["王芳", "李强", "钱进", "Kevin", ""].includes(写法)) {
        expect(c.salesOwnerId, 编号[i]).toBe(默认负责人);
        if (写法) expect(提醒了.has(编号[i]), 编号[i]).toBe(true);
        见过.落默认++;
      } else {
        // 「梁晓燕（广州组）」这种带部门的写法：落到同名的某一位（重名靠部门分）
        const 名 = 写法.replace(/（.*）$/, "");
        const 同名 = 用户们.filter((u) => u.name === 名);
        if (同名.length === 1) expect(c.salesOwnerId, 编号[i]).toBe(同名[0].id);
        else if (名 !== 写法) expect(同名.map((u) => u.id), 编号[i]).toContain(c.salesOwnerId);
        else {
          expect(c.salesOwnerId, 编号[i]).toBe(默认负责人);
          expect(提醒了.has(编号[i]), 编号[i]).toBe(true);
        }
      }
    }
    expect(见过.邮箱).toBeGreaterThan(5);
    expect(见过.落默认).toBeGreaterThan(9);
  });

  it("跟进内容：源表里没跳过的每一条内容都在库里，条数一样", async () => {
    const t = 表们[3];
    const 内容 = 列(t, "跟进内容");
    const 跳 = new Set(报告1.问题.filter((q) => q.实体 === "followup" && q.级别 === "跳过").map((q) => q.行号));
    const 源 = 内容.filter((_, i) => !跳.has(t.行号[i])).sort();
    const 库 = (await prisma.followUp.findMany({ select: { content: true } })).map((f) => f.content).sort();
    expect(库).toEqual(源);
    // 按商机名称挂上的那 25 条都挂上了
    expect(await prisma.followUp.count({ where: { opportunityId: { not: null } } })).toBe(25);
  });
});

describe("裁判 · 幂等", () => {
  it("同一批再导一次：报告零新建，写入零新建零更新，库里一格不变", async () => {
    const 试 = await 试跑({ 来源: "excel", 用户Id: 我.id, 表: 表们, 建议器: null });
    批2 = 试.批次Id;
    for (const e of 实体顺序) {
      const c = 试.报告.按类[e];
      expect([e, c.新建, c.更新, c.没变 + c.并入]).toEqual([e, 0, 0, c.待写]);
    }
    const r = await 写一批(批2, 我);
    expect(r).toMatchObject({ 完了: true, 新建: 0, 更新: 0, 冲突: 0, 失败: 0 });
    expect(r.跳过).toBe(试.报告.合计.跳过 + 合计(试.报告)("并入") + 合计(试.报告)("没变"));
    const 再 = await 拍();
    for (const k of Object.keys(导入后)) expect(再[k], k).toEqual(导入后[k]);
  });
});

describe("裁判 · 来回", () => {
  it("两批倒着撤回：除日志表外每张表和导入前逐行一样（已有客户补的空也退回去）", async () => {
    for (const id of [批2, 批1]) {
      const r = await 撤回一批(id, 我);
      expect(r, id).toMatchObject({ 状态: "reverted", 完了: true, 留下数: 0 });
    }
    const 撤后 = await 拍();
    // 撤回把值退回去了，但 Prisma 的 @updatedAt 会跟着动（补过空的那家已有客户）：只这一项不比
    const 去时间 = (行们: string[] = []) => 行们.map((r) => r.replace(/"updatedAt":"[^"]*"/, "")).sort();
    for (const k of Object.keys(导入前)) expect(去时间(撤后[k]), k).toEqual(去时间(导入前[k]));
  });
});
