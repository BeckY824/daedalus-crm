/**
 * 订单一览企业版服务端分页（lib/orders-paging.ts，2026-10-25）和原来浏览器里那一套对拍。
 *
 * 「原来」= 改之前 OrdersView 里的原样代码：轻量版先按确认时间新的在前排一遍、列上两个比较函数、
 * 表头合计 / 停在哪一步，再交给 antd 自己的排序（antd/lib/table/hooks/useSorter 的 getSortData，不是照抄的）和 20 条一页。
 *
 *   - 翻到底：每种排序 × 每页条数，各页拼起来 = 原来浏览器里排出来的整张，一单不多一单不少、先后一样
 *   - 同值很多（确认时间、超期大量重复）：稳定排序的先后也一样
 *   - 合计、条数、停在哪一步、已走完：在全部上算，和原来一样
 *   - 页码超了落最后一页、乱填的 sort 当没排
 *   - 页面：不是企业版、企业版不到 分页起 单 → 和原来一样整张发；超过才分页
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// antd 表格自己排序用的那个函数
import { getSortData } from "antd/lib/table/hooks/useSorter";
import { 按币种合计 } from "@/lib/currency";
import { 节点名们 } from "@/lib/order";
import type { 订单行 } from "@/lib/order-db";
import { 切订单页, 算汇总, 分页起 } from "@/lib/orders-paging";
import { 订单节点 } from "@/lib/features";

/** 固定种子的伪随机数：失败时能原样复现 */
function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function 造(种子: number, 个数: number): 订单行[] {
  const r = 随机(种子);
  const 挑 = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  // 确认时间只从十几天里挑、超期只有 0–3：大量同值，稳定排序的先后才看得出来
  const 天 = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i * 3)).toISOString());
  return Array.from({ length: 个数 }, (_, i) => {
    const 当前 = r() < 0.2 ? null : (() => { const idx = 1 + Math.floor(r() * 节点名们.length); return { idx, name: 节点名们[idx - 1] }; })();
    const amount = r() < 0.1 ? 0 : Math.round(r() * 1e8) / 100 + r() / 7;
    return {
      id: `o${种子}-${String(i).padStart(4, "0")}`,
      no: `SO-${i}`,
      customerId: `c${i % 17}`,
      customerName: `客户${i % 17}`,
      customerCompany: null,
      ownerId: `u${i % 3}`,
      ownerName: `业务员${i % 3}`,
      amount,
      currency: 挑(["CNY", "USD", "usd", "EUR", "XYZ", ""]),
      incoterm: null,
      payment: null,
      supplier: null,
      confirmedAt: 挑(天),
      createdAt: 挑(天),
      nodes: [],
      当前,
      超期: 当前 ? 挑([0, 0, 0, 1, 2, 3]) : 0,
      进度: 0,
      未收: r() < 0.3 ? 0 : amount * r(),
      返工: false, 样品: "未寄" as const, eta: null, ata: null, 到港灯: "无" as const, 催尾款: false,
    };
  });
}

/* ---------- 原来（改之前 OrdersView 里的原样） ---------- */
const 原来比较 = {
  confirmed: (a: 订单行, b: 订单行) => a.confirmedAt.localeCompare(b.confirmedAt),
  late: (a: 订单行, b: 订单行) => a.超期 - b.超期,
};
const 原来顺序 = (行: 订单行[], 节点: boolean) => (节点 ? 行 : [...行].sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)));
function 原来浏览器里(行: 订单行[], 节点: boolean, sort: string): 订单行[] {
  const base = 原来顺序(行, 节点);
  if (!sort) return getSortData(base, [], "children") as 订单行[];
  const [k, 向] = sort.split("-") as ["confirmed" | "late", "asc" | "desc"];
  return getSortData(
    base,
    [{ column: { sorter: 原来比较[k] }, key: k, sortOrder: 向 === "asc" ? "ascend" : "descend", multiplePriority: false }],
    "children",
  ) as 订单行[];
}
function 原来合计(rows: 订单行[]) {
  const 停 = 节点名们.map((name, i) => {
    const 在这 = rows.filter((r) => r.当前?.idx === i + 1);
    return { idx: i + 1, name, 单: 在这.length, 超期: 在这.filter((r) => r.超期 > 0).length };
  }).filter((x) => x.单 > 0);
  const 结了 = rows.filter((r) => !r.当前).length;
  return {
    单: rows.length,
    金额: 按币种合计(rows, (r) => r.amount, (r) => r.currency),
    未收: 按币种合计(rows, (r) => r.未收, (r) => r.currency),
    停,
    结了,
  };
}

/** 一页一页翻到底，拼起来 */
function 翻到底(rows: 订单行[], 节点: boolean, sort: string, 每页: number) {
  const 拼: 订单行[] = [];
  const 第一页 = 切订单页(rows, { 节点, sort, page: "1", pageSize: String(每页) });
  const 页数 = Math.ceil(第一页.分页.总数 / 第一页.分页.每页);
  for (let p = 1; p <= 页数; p++) {
    const 这页 = 切订单页(rows, { 节点, sort, page: String(p), pageSize: String(每页) });
    expect(这页.分页.页).toBe(p);
    expect(这页.rows.length).toBeLessThanOrEqual(每页);
    拼.push(...这页.rows);
  }
  return 拼;
}

describe("订单一览服务端分页：翻到底和原来浏览器里排出来的一样", () => {
  for (const 节点 of [false, true]) {
    const 排法 = 节点 ? ["", "late-asc", "late-desc"] : ["", "confirmed-asc", "confirmed-desc"];
    it(`${节点 ? "节点版" : "轻量版"}：随机数据 × 3 个种子 × 每种排序 × 几种每页条数`, () => {
      for (const 种子 of [1, 2, 3]) {
        const rows = 造(种子, 分页起 + 137);
        for (const sort of 排法) {
          const 原来 = 原来浏览器里(rows, 节点, sort);
          // 不是对拍空气：同值的真的多（稳定排序的先后看得出来），排出来和库里原来的先后真的不一样
          // （轻量版点「确认时间降序」和不点一样，本来就新的在前）
          expect(new Set(rows.map((r) => (节点 ? r.超期 : r.confirmedAt))).size).toBeLessThan(20);
          if (sort || !节点) expect(原来.map((r) => r.id)).not.toEqual(rows.map((r) => r.id));
          for (const 每页 of [10, 20, 50, 100]) {
            const 拼 = 翻到底(rows, 节点, sort, 每页);
            expect(拼.map((r) => r.id), `种子 ${种子} ${sort || "不排"} 每页 ${每页}`).toEqual(原来.map((r) => r.id));
            expect(new Set(拼.map((r) => r.id)).size).toBe(rows.length);
          }
          // 第一页和原来 antd 20 条一页的第一页逐个字段一样（行对象原样发，不改字段）
          expect(切订单页(rows, { 节点, sort }).rows).toEqual(原来.slice(0, 20));
        }
      }
    });
  }

  it("合计、条数、停在哪一步、已走完：在全部上算，和原来一样（不管翻到哪一页、怎么排）", () => {
    for (const 种子 of [4, 5]) {
      const rows = 造(种子, 分页起 + 51);
      const 原来 = 原来合计(rows);
      expect(原来.停.length).toBeGreaterThan(3);
      expect(原来.金额.length).toBeGreaterThan(2);
      expect(算汇总(rows)).toEqual(原来);
      for (const [page, sort] of [["1", ""], ["3", "confirmed-desc"], ["9", "late-asc"]]) {
        const { 分页 } = 切订单页(rows, { 节点: sort.startsWith("late"), sort, page });
        expect(分页.汇总).toEqual(原来);
        expect(分页.总数).toBe(rows.length);
      }
    }
  });

  it("页码超了落最后一页；每页条数照客户页的规矩夹在 10–100；乱填的 sort、另一种一览的 sort 当没排", () => {
    const rows = 造(6, 分页起 + 5); // 205 单
    const 尾 = 切订单页(rows, { 节点: false, page: "999" });
    expect(尾.分页.页).toBe(11);
    expect(尾.rows.map((r) => r.id)).toEqual(原来浏览器里(rows, false, "").slice(200).map((r) => r.id));
    expect(切订单页(rows, { 节点: false, pageSize: "3" }).分页.每页).toBe(10);
    expect(切订单页(rows, { 节点: false, pageSize: "5000" }).分页.每页).toBe(100);
    for (const page of ["0", "-2", "abc", "1.5"]) expect(切订单页(rows, { 节点: false, page }).分页.页).toBe(1);
    for (const [节点, sort] of [[false, "late-asc"], [true, "confirmed-desc"], [false, "amount-desc"], [false, "confirmed"]] as const) {
      const 这 = 切订单页(rows, { 节点, sort });
      expect(这.分页.sort).toBe("");
      expect(这.rows.map((r) => r.id)).toEqual(原来浏览器里(rows, 节点, "").slice(0, 20).map((r) => r.id));
    }
  });
});

/* ---------- 页面：什么时候分页 ---------- */
const 全部 = vi.hoisted(() => ({ rows: [] as 订单行[] }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "u0" }) }));
vi.mock("@/lib/owners", () => ({ 负责人候选: async () => [{ id: "u0", name: "老板" }, { id: "u1", name: "业务员" }] }));
vi.mock("@/lib/order-db", () => ({ 订单列表: async () => 全部.rows }));
vi.mock("@/lib/team-scope", async (原) => ({ ...(await 原<typeof import("@/lib/team-scope")>()), 限定的我: async () => null }));

describe("订单页：企业版超过 分页起 单才分页，别的一样都不变", () => {
  const 原环境 = process.env.CRM_ENTERPRISE;
  beforeEach(() => {
    if (原环境 === undefined) delete process.env.CRM_ENTERPRISE;
    else process.env.CRM_ENTERPRISE = 原环境;
  });
  const 开 = async (sp: Record<string, string> = {}) => {
    const { default: OrdersPage } = await import("@/app/(app)/orders/page");
    const el = (await OrdersPage({ searchParams: Promise.resolve(sp) })) as { props: { rows: 订单行[]; 分页?: unknown; filters: unknown; users: unknown } };
    return el.props;
  };

  it("不是企业版：再多单也整张发，不带分页（个人版、团队版）", async () => {
    delete process.env.CRM_ENTERPRISE;
    全部.rows = 造(7, 2000);
    const p = await 开({ page: "3", sort: "confirmed-asc" });
    expect(p.rows).toBe(全部.rows);
    expect(p.分页).toBeUndefined();
    expect(Object.keys(p).sort()).toEqual(["filters", "rows", "users"]);
  });

  it("企业版不到 分页起 单（含正好）：整张发，不带分页", async () => {
    process.env.CRM_ENTERPRISE = "1";
    for (const n of [0, 30, 分页起]) {
      全部.rows = 造(8, n);
      const p = await 开();
      expect(p.rows).toBe(全部.rows);
      expect(Object.keys(p).sort()).toEqual(["filters", "rows", "users"]);
    }
  });

  it("企业版超过 分页起 单：只发这一页，带全部的合计；网址里的页码、每页、排序都认", async () => {
    process.env.CRM_ENTERPRISE = "1";
    全部.rows = 造(9, 分页起 + 1);
    // 节点开着（0.46.30 起）排序按超期，关着按确认日期
    const sort = 订单节点 ? "late-asc" : "confirmed-asc";
    const p = await 开({ page: "2", pageSize: "50", sort, ownerId: "u1" });
    expect(p.filters).toEqual({ ownerId: "u1", 我: "" });
    expect(p.分页).toMatchObject({ 页: 2, 每页: 50, 总数: 分页起 + 1, sort, 汇总: 原来合计(全部.rows) });
    expect(p.rows.map((r) => r.id)).toEqual(原来浏览器里(全部.rows, 订单节点, sort).slice(50, 100).map((r) => r.id));
  });
});
