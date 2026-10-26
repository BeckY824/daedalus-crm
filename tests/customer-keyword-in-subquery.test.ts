/**
 * 客户关键词搜索：三张子表的 EXISTS 改成不相关的 IN 子查询（2026-10-26）。
 * 对拍：同一个关键词，抓下新写法真发出去的 SQL 和参数，把三段子查询换回原来的 EXISTS 原文、参数原样再跑一遍，
 * 两边命中的客户 id 逐个一致。数据里每张子表都有命中、有不命中、有一位客户多条联系人/订单、有完全没有子表行的客户。
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { defaultClient as db, prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 客户关键词条件 } from "@/lib/search-keyword";

const 原来 = [
  ['c.id IN (SELECT e."customerId" FROM "CustomerExtra" e WHERE e.whatsapp GLOB ? OR e.whatsapp GLOB ? OR e.email GLOB ? OR e.wechat GLOB ? OR e.country GLOB ? OR e.website GLOB ? OR e."alibabaId" GLOB ?)',
    'EXISTS (SELECT 1 FROM "CustomerExtra" e WHERE e."customerId"=c.id AND (e.whatsapp GLOB ? OR e.whatsapp GLOB ? OR e.email GLOB ? OR e.wechat GLOB ? OR e.country GLOB ? OR e.website GLOB ? OR e."alibabaId" GLOB ?))'],
  ['c.id IN (SELECT t."customerId" FROM "Contact" t WHERE t.name GLOB ? OR t.phone GLOB ? OR t.phone GLOB ? OR t.email GLOB ? OR t.wechat GLOB ?)',
    'EXISTS (SELECT 1 FROM "Contact" t WHERE t."customerId"=c.id AND (t.name GLOB ? OR t.phone GLOB ? OR t.phone GLOB ? OR t.email GLOB ? OR t.wechat GLOB ?))'],
  ['c.id IN (SELECT o."customerId" FROM "TradeOrder" o WHERE o.no GLOB ?)',
    'EXISTS (SELECT 1 FROM "TradeOrder" o WHERE o."customerId"=c.id AND o.no GLOB ?)'],
] as const;

let owner = "";
beforeAll(async () => {
  await resetDb();
  owner = (await db.user.create({ data: { email: "kw-in@qa.local", name: "QA", password: "qa", role: "ADMIN" } })).id;
  const 国家 = ["美国", "德国", "日本", null];
  await db.customer.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      id: `kw-${String(i).padStart(2, "0")}`,
      name: i % 7 === 0 ? `Acme Trading ${i}` : `客户${i}`,
      phone: i % 5 === 0 ? "" : `1381234${String(i).padStart(4, "0")}`,
      school: i % 4 === 0 ? `华东大学${i}` : null,
      remark: i % 9 === 0 ? "关注价格 100%[A]*?" : null,
      salesOwnerId: owner,
    })),
  });
  // 扩展资料：前 40 位有，后 20 位没有
  await db.customerExtra.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      customerId: `kw-${String(i).padStart(2, "0")}`,
      country: 国家[i % 4],
      whatsapp: i % 3 === 0 ? `+44 7700 9${String(i).padStart(5, "0")}` : null,
      email: i % 2 === 0 ? `buyer${i}@acme-mail.com` : null,
      wechat: i % 6 === 0 ? `wx_buyer${i}` : null,
      website: i % 5 === 0 ? `www.shop${i}.co.uk` : null,
      alibabaId: i % 8 === 0 ? `ALI-${i}` : null,
    })),
  });
  // 联系人：偶数位客户 1–3 条，奇数位没有
  const 联系人 = [];
  for (let i = 0; i < 60; i += 2) for (let j = 0; j <= i % 3; j++) {
    联系人.push({
      customerId: `kw-${String(i).padStart(2, "0")}`,
      name: j === 0 ? `采购经理${i}` : `Assistant ${i}-${j}`,
      phone: j === 1 ? `1399876${String(i).padStart(4, "0")}` : null,
      email: j === 2 ? `asst${i}@acme-mail.com` : null,
      wechat: j === 0 && i % 4 === 0 ? `wx_contact${i}` : null,
      isPrimary: j === 0,
    });
  }
  await db.contact.createMany({ data: 联系人 });
  // 订单：每 3 位一位，有的两张
  const 订单 = [];
  for (let i = 0; i < 60; i += 3) {
    订单.push({ customerId: `kw-${String(i).padStart(2, "0")}`, ownerId: owner, no: `PI-2026-${String(i).padStart(3, "0")}` });
    if (i % 2 === 0) 订单.push({ customerId: `kw-${String(i).padStart(2, "0")}`, ownerId: owner, no: `PO_${i}[x]` });
  }
  await db.tradeOrder.createMany({ data: 订单 });
});
afterAll(async () => { await db.$disconnect(); });

/** 新写法命中的 id，和把同一条 SQL 换回 EXISTS 后命中的 id */
async function 两边(k: string) {
  const spy = vi.spyOn(prisma, "$queryRawUnsafe");
  try {
    const where = await 客户关键词条件(k);
    const 新 = (await db.customer.findMany({ where, select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id);
    expect(spy).toHaveBeenCalledTimes(1);
    const [sql, ...values] = spy.mock.calls[0] as [string, ...unknown[]];
    let 旧sql = sql;
    for (const [现, 旧] of 原来) {
      expect(旧sql.split(现).length - 1).toBe(1);
      旧sql = 旧sql.replace(现, 旧);
    }
    const 旧 = (await db.$queryRawUnsafe<{ id: string }[]>(旧sql, ...values)).map((r) => r.id).sort();
    return { 新, 旧 };
  } finally { spy.mockRestore(); }
}

const 关键词 = [
  // 客户本表
  "客户1", "acme", "ACME TRADING", "华东大学", "100%[A]*?", "1381234",
  // 扩展资料各列
  "美国", "德国", "acme-mail", "buyer12@", "wx_buyer", "www.shop10.co.uk", "https://www.shop15.co.uk/contact", "ali-", "+44 7700", "7700 900003",
  // 联系人各列
  "采购经理", "assistant", "1399876", "139 9876 0002", "asst", "wx_contact",
  // 订单号
  "PI-2026", "PI-2026-009", "PO_", "[x]",
  // 多处同时命中、谁也不命中
  "buyer", "2", "0", "没有这个人",
];

it.each(关键词)("「%s」：IN 子查询和原来的 EXISTS 命中同一批客户", async (k) => {
  const { 新, 旧 } = await 两边(k);
  expect(新).toEqual(旧);
});

it("对拍不是空对空：子表各自真有命中，且有只靠子表才命中的客户", async () => {
  const 只看子表 = async (k: string) => (await 两边(k)).新;
  expect((await 只看子表("美国")).length).toBeGreaterThan(0);
  expect((await 只看子表("采购经理")).length).toBe(30);
  expect((await 只看子表("PI-2026")).length).toBe(20);
  expect(await 只看子表("PI-2026-009")).toEqual(["kw-09"]);
  expect(await 只看子表("没有这个人")).toEqual([]);
});
