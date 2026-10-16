/**
 * 「像不像老客户」的材料（lib/research/similar.ts）：只挑已成交 / 在谈的，只拿名字、国家、档案字段——
 * **不碰电话、邮箱、WhatsApp、跟进原文**（方案里对用户的承诺）。
 */
import { describe, it, expect, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { customer: { findMany: (a: unknown) => findMany(a) } } }));

describe("老客户清单", () => {
  it("查询只选名字、档案字段、国家，不选联系方式和跟进", async () => {
    findMany.mockResolvedValue([
      { id: "c1", name: "Nordlicht", school: "电气批发", grade: null, major: null, followStatus: "已签约", extra: { country: "德国" }, _count: { contracts: 0, tradeOrders: 0 } },
      { id: "c2", name: "Sol Andino", school: null, grade: null, major: "照明", followStatus: "跟进中", extra: null, _count: { contracts: 0, tradeOrders: 0 } },
    ]);
    const { 老客户清单 } = await import("@/lib/research/similar");
    const list = await 老客户清单({ fields: { school: "公司", grade: "职位", major: "行业" } });
    const select = (findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(Object.keys(select).sort()).toEqual(["_count", "extra", "followStatus", "grade", "id", "major", "name", "school"].sort());
    expect(select.extra).toEqual({ select: { country: true } });
    expect(JSON.stringify(select)).not.toMatch(/phone|email|whatsapp|wechat|followUps|remark/);
    expect(list).toEqual([
      { id: "c1", name: "Nordlicht", 国家: "德国", 档案: "公司：电气批发", 状态: "已成交" },
      { id: "c2", name: "Sol Andino", 国家: null, 档案: "行业：照明", 状态: "在谈" },
    ]);
  });

  it("模型回的「像哪几位」按编号对回，最多 3 位、最像的在前", async () => {
    const { 认像的老客户, 老客户维度档 } = await import("@/lib/research/similar");
    const list = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: `客户${i}`, 国家: null, 档案: "", 状态: "已成交" as const }));
    const r = 认像的老客户(
      [
        { 编号: 2, 档: "low", 像在哪: "a" },
        { 编号: 1, 档: "high", 像在哪: "b" },
        { 编号: 1, 档: "mid", 像在哪: "重复" },
        { 编号: 3, 档: "超高", 像在哪: "档写错" },
        { 编号: 4, 档: "mid", 像在哪: "" },
        { 编号: 3, 档: "mid", 像在哪: "c" },
      ],
      list,
    );
    expect(r.map((x) => [x.id, x.档])).toEqual([["c1", "high"], ["c3", "mid"], ["c2", "low"]]);
    expect(老客户维度档(r, 4)).toBe("high");
    expect(老客户维度档([], 4)).toBe("low");
    expect(老客户维度档([], 0)).toBe("unknown");
  });
});
