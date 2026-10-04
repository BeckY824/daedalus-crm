/**
 * 查完再写（lib/check-then-write.ts，2026-10-04 J-104）的前提：同一个进程里两段事务不会交错。
 *
 * 签约查重、建客户查号、导入每行再认一次，全靠这一条——Prisma 哪天换了开事务的方式
 * （比如 SQLite 改成延迟加锁、或者连接池行为变了），这里先红，而不是等业绩翻倍了才发现。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 查完再写 } from "@/lib/check-then-write";

let 我: string;
beforeEach(async () => {
  await resetDb();
  我 = (await prisma.user.create({ data: { email: "me", name: "我", title: "x", role: "ADMIN", password: "x" } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe("查完再写", () => {
  it("两段「查一下没有 → 停一会儿 → 写」同时跑：后一段查的时候前一段已经写完，只建出一位", async () => {
    const 建 = () => 查完再写(async (tx) => {
      if (await tx.customer.count({ where: { phone: "13800001111" } })) return "已经有了";
      // 故意在查和写之间留一段：没有闸门时另一段正好插进来
      await new Promise((r) => setTimeout(r, 50));
      await tx.customer.create({ data: { name: "王强", phone: "13800001111", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我 } });
      return "建了";
    });
    const rs = await Promise.all([建(), 建()]);
    expect(rs.sort()).toEqual(["已经有了", "建了"]);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("里面抛的不是「库忙」：原样抛出去、不重来、什么都没写进去", async () => {
    let 跑了 = 0;
    await expect(查完再写(async (tx) => {
      跑了++;
      await tx.customer.create({ data: { name: "半截", phone: "13800002222", followStatus: "待跟进", decisionStatus: "了解中", salesOwnerId: 我 } });
      throw new Error("别的错");
    })).rejects.toThrow("别的错");
    expect(跑了).toBe(1);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("「库忙」重来一次就过", async () => {
    let 跑了 = 0;
    const r = await 查完再写(async () => {
      跑了++;
      if (跑了 === 1) throw Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" });
      return "过了";
    });
    expect([r, 跑了]).toEqual(["过了", 2]);
  });
});
