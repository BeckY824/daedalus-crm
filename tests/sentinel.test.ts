/**
 * 盯盘规则。
 *
 * 这份清单的两条命门：漏报（真被遗忘的没上榜）和噪音（不该打扰的上了榜）。
 * 暂缓跟进是销售有意搁置的，唤醒它是打脸；逾期计划是白纸黑字的承诺，
 * 必须压过一切排在最前。每条规则的边界都在这里钉死。
 */
import { describe, it, expect } from "vitest";
import { buildWatchlist, STALE_DAYS, type SentinelInput } from "@/lib/sentinel";

const now = new Date("2026-08-31T12:00:00+08:00");
const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5);

const empty: SentinelInput = { overduePlans: [], customers: [], opportunities: [] };

function customer(over: Partial<SentinelInput["customers"][number]> = {}) {
  return {
    id: "c1",
    name: "王同学",
    followStatus: "跟进中",
    lastFollowAt: daysAgo(20),
    createdAt: daysAgo(60),
    ownerName: "张三",
    ...over,
  };
}

describe("沉睡学员", () => {
  it(`不满 ${STALE_DAYS} 天不算沉睡，满了才上榜`, () => {
    expect(buildWatchlist({ ...empty, customers: [customer({ lastFollowAt: daysAgo(STALE_DAYS - 1) })] }, now)).toHaveLength(0);
    const items = buildWatchlist({ ...empty, customers: [customer({ lastFollowAt: daysAgo(STALE_DAYS) })] }, now);
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain(`${STALE_DAYS} 天`);
  });

  it("从未跟进过的按录入时间算，理由要说清是「从未跟进」", () => {
    const items = buildWatchlist({ ...empty, customers: [customer({ lastFollowAt: null, createdAt: daysAgo(30) })] }, now);
    expect(items[0].reason).toContain("从未跟进");
  });

  it("已签约/已流失/暂缓跟进不打扰——暂缓是销售有意搁置的", () => {
    for (const status of ["已签约", "已流失", "暂缓跟进"]) {
      const items = buildWatchlist(
        { ...empty, customers: [customer({ followStatus: status, lastFollowAt: daysAgo(90) })] },
        now,
      );
      expect(items).toHaveLength(0);
    }
  });

  it("同样沉睡 20 天，意向较高的排在待跟进前面——越接近成交被遗忘代价越大", () => {
    const items = buildWatchlist(
      {
        ...empty,
        customers: [
          customer({ id: "a", followStatus: "待跟进" }),
          customer({ id: "b", followStatus: "意向较高" }),
        ],
      },
      now,
    );
    expect(items[0].customerId).toBe("b");
  });
});

describe("优先级与去重", () => {
  it("逾期计划压过一切——那是销售自己写下的承诺", () => {
    const items = buildWatchlist(
      {
        overduePlans: [
          { customerId: "p", customerName: "李同学", ownerName: "张三", subject: "聊报价", plannedAt: daysAgo(2) },
        ],
        customers: [customer({ id: "s", followStatus: "意向较高", lastFollowAt: daysAgo(40) })],
        opportunities: [
          { customerId: "o", customerName: "张同学", ownerName: "张三", name: "考研全程班", stage: "方案报价", updatedAt: daysAgo(50) },
        ],
      },
      now,
    );
    expect(items[0].kind).toBe("overdue_plan");
  });

  it("同一学员命中多条信号只留最高的一条，清单的敌人是噪音", () => {
    const items = buildWatchlist(
      {
        overduePlans: [
          { customerId: "c1", customerName: "王同学", ownerName: "张三", subject: "约试听", plannedAt: daysAgo(3) },
        ],
        customers: [customer()],
        opportunities: [],
      },
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("overdue_plan");
  });

  it("商机不满阈值不算停滞；满了理由带天数和阶段", () => {
    const fresh = { customerId: "o", customerName: "张同学", ownerName: "张三", name: "全程班", stage: "方案报价", updatedAt: daysAgo(5) };
    expect(buildWatchlist({ ...empty, opportunities: [fresh] }, now)).toHaveLength(0);
    const items = buildWatchlist({ ...empty, opportunities: [{ ...fresh, updatedAt: daysAgo(20) }] }, now);
    expect(items[0].reason).toContain("方案报价");
    expect(items[0].reason).toContain("20 天");
  });

  it("最多 8 条——超过 8 条的提醒等于没有提醒", () => {
    const customers = Array.from({ length: 15 }, (_, i) => customer({ id: `c${i}`, name: `学员${i}` }));
    expect(buildWatchlist({ ...empty, customers }, now)).toHaveLength(8);
  });
});
