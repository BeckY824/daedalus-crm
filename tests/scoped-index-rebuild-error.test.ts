/**
 * 索引缓存增量重建时读库出错（2026-10-21 质量审 #78）：取走的脏键不能丢。
 * 原来 建() 一开头就把脏键删了再读库，读库抛一次错，下一次拿旧缓存 + 空脏键重建、按新版本存下——
 * 转走的客户在索引里一直挂在原负责人名下（新负责人收不到、老板看不到改动，也不报错），直到这位再被推一次或者云端重启。
 * 这里把控制库换成内存里的两张表，让增量那次 findMany 抛一次错。
 */
import { describe, expect, it, vi } from "vitest";

const 库 = vi.hoisted(() => ({ 记录: new Map<string, string>(), 批次: [] as { id: number; recordKey: string }[], 坏几次: 0 }));
vi.mock("@/lib/tenant/control", () => ({
  control: {
    syncScopedRecord: {
      findMany: async ({ where }: { where: { key?: { in: string[] } } }) => {
        if (库.坏几次 > 0) { 库.坏几次--; throw new Error("库忙（测试注入）"); }
        return [...库.记录].filter(([k]) => !where.key || where.key.in.includes(k)).map(([key, metadata]) => ({ key, metadata }));
      },
    },
    syncScopedBatch: {
      groupBy: async ({ where }: { where: { recordKey?: { in: string[] } } }) => {
        const 最大 = new Map<string, number>();
        for (const b of 库.批次) if (!where.recordKey || where.recordKey.in.includes(b.recordKey)) 最大.set(b.recordKey, Math.max(最大.get(b.recordKey) ?? 0, b.id));
        return [...最大].map(([recordKey, id]) => ({ recordKey, _max: { id } }));
      },
    },
  },
}));

import { 团队索引, 记改过, 清索引缓存 } from "@/lib/tenant/scoped-index";

const 客户 = (负责人: string, routeSeq: number) =>
  JSON.stringify({ t: "Customer", k: "c1", fields: { salesOwnerId: 负责人, channelOwnerId: null }, clocks: {}, deleted: false, clock: "", routeSeq });

describe("索引缓存：增量重建读库出错", () => {
  it("转给赵之后读库抛一次错，下一次取索引照样是赵、head 是新的", async () => {
    清索引缓存();
    库.记录.set("Customer:c1", 客户("acct_li", 1));
    库.批次.push({ id: 1, recordKey: "Customer:c1" });
    const 先 = await 团队索引("t1");
    expect(先.groups.get("Customer:c1")).toMatchObject({ head: 1, scope: { owners: ["acct_li"] } });

    // 收范围推送：转给赵（新批次 2），推送记脏、加版本
    库.记录.set("Customer:c1", 客户("acct_zhao", 2));
    库.批次.push({ id: 2, recordKey: "Customer:c1" });
    记改过("t1", ["Customer:c1"]);

    库.坏几次 = 1;
    await expect(团队索引("t1")).rejects.toThrow("库忙");

    const 后 = await 团队索引("t1");
    expect(后.groups.get("Customer:c1")).toMatchObject({ head: 2, scope: { owners: ["acct_zhao"] } });
    expect(后.rows.get("Customer:c1")?.fields.salesOwnerId).toBe("acct_zhao");
  });

  it("出错期间又来一次推送：两次的脏键都在，下一次都重读", async () => {
    清索引缓存();
    库.记录.clear(); 库.批次.length = 0;
    库.记录.set("Customer:c1", 客户("acct_li", 1));
    库.记录.set("Customer:c2", 客户("acct_li", 1).replace('"k":"c1"', '"k":"c2"'));
    库.批次.push({ id: 1, recordKey: "Customer:c1" }, { id: 2, recordKey: "Customer:c2" });
    await 团队索引("t2");

    库.记录.set("Customer:c1", 客户("acct_zhao", 2));
    库.批次.push({ id: 3, recordKey: "Customer:c1" });
    记改过("t2", ["Customer:c1"]);
    库.坏几次 = 1;
    await expect(团队索引("t2")).rejects.toThrow();
    库.记录.set("Customer:c2", 客户("acct_wang", 2).replace('"k":"c1"', '"k":"c2"'));
    库.批次.push({ id: 4, recordKey: "Customer:c2" });
    记改过("t2", ["Customer:c2"]);

    const 后 = await 团队索引("t2");
    expect(后.groups.get("Customer:c1")).toMatchObject({ head: 3, scope: { owners: ["acct_zhao"] } });
    expect(后.groups.get("Customer:c2")).toMatchObject({ head: 4, scope: { owners: ["acct_wang"] } });
  });
});
