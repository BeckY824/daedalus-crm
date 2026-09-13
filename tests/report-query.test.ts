/**
 * 问数据的规格校验与聚合。
 *
 * AI 只能产出受限的 QuerySpec，这层闸门决定了"最坏是答不了，不会是答错"：
 * 未知指标要拒绝、不支持的组合要拒绝、坏日期要丢弃。
 * 聚合按 id 归组——姓名允许重复，按名归组会把两个人的数字加进同一行。
 */
import { describe, it, expect } from "vitest";
import { dayjs } from "@/lib/utils";
import { sanitizeQuerySpec, sumRows, rateRows } from "@/lib/report-query";

describe("规格校验", () => {
  it("未知指标直接拒绝（包括 AI 标记的 unsupported）", () => {
    expect(() => sanitizeQuerySpec({ metric: "unsupported" })).toThrow();
    expect(() => sanitizeQuerySpec({ metric: "revenue_forecast" })).toThrow();
    expect(() => sanitizeQuerySpec(null)).toThrow();
  });

  it("指标不支持的拆分维度要拒绝，宁可答不了也不答错", () => {
    // 签约金额按年级拆——学员才有年级，合同上这个组合没有意义
    expect(() => sanitizeQuerySpec({ metric: "contract_amount", groupBy: "grade" })).toThrow();
    expect(() => sanitizeQuerySpec({ metric: "leads_count", groupBy: "自创维度" })).toThrow();
  });

  it("合法组合原样通过，from > to 自动交换", () => {
    const s = sanitizeQuerySpec({ metric: "contract_amount", groupBy: "channel", from: "2026-08-31", to: "2026-08-01" });
    expect(s.groupBy).toBe("channel");
    expect(s.from).toBe("2026-08-01");
    expect(s.to).toBe("2026-08-31");
  });

  it("解析不了的日期置空而不是报错——时间没听懂就查全量，数字仍是对的", () => {
    const s = sanitizeQuerySpec({ metric: "leads_count", groupBy: null, from: "上个月", to: "" });
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
  });

  /**
   * 日期一律按**本地时区**算，不能用 toISOString。
   * 被这条坑过一次：凌晨 0 点刚过跑测试，UTC 还停在前一天，
   * toISOString 算出来的"明天"正好等于本地的今天，于是这条用例在
   * 每天 00:00–08:00 之间必挂，白天怎么跑都是绿的。
   */
  const 本地日期 = (偏移天 = 0) => dayjs().add(偏移天, "day").format("YYYY-MM-DD");

  it("起点在未来的查询要拒绝——答「明天签约 0 笔」会被当成预测，比不支持更糟", () => {
    const 明天 = 本地日期(1);
    expect(() => sanitizeQuerySpec({ metric: "contract_count", from: 明天, to: 明天 })).toThrow(/将来/);
  });

  it("今天仍然可查——边界不能误伤当天", () => {
    const 今天 = 本地日期();
    expect(sanitizeQuerySpec({ metric: "contract_count", from: 今天, to: 今天 }).from).toBe(今天);
  });
});

describe("计数/求和聚合", () => {
  it("按 key（id）归组，同名不同人的数字不能混进一行", () => {
    const rows = sumRows([
      { key: "u1", label: "张伟", value: 100 },
      { key: "u2", label: "张伟", value: 50 },
      { key: "u1", label: "张伟", value: 30 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "张伟", value: 130 });
    expect(rows[1]).toMatchObject({ label: "张伟", value: 50 });
  });

  it("默认按数值倒序，第一行就是答案", () => {
    const rows = sumRows([
      { key: "a", label: "A", value: 1 },
      { key: "b", label: "B", value: 9 },
    ]);
    expect(rows[0].label).toBe("B");
  });

  it("按月走势按时间排序，不按大小", () => {
    const rows = sumRows(
      [
        { key: "2026-08", label: "2026-08", value: 9 },
        { key: "2026-07", label: "2026-07", value: 1 },
      ],
      { byMonth: true },
    );
    expect(rows.map((r) => r.label)).toEqual(["2026-07", "2026-08"]);
  });

  it("最多返回 12 行", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, value: i }));
    expect(sumRows(items)).toHaveLength(12);
  });
});

describe("转化率聚合", () => {
  it("率 = 转化/新增，保留 1 位小数，note 带上分子分母", () => {
    const rows = rateRows([
      { key: "s1", label: "转介绍", created: 1, converted: 1 },
      { key: "s1", label: "转介绍", created: 1, converted: 0 },
      { key: "s1", label: "转介绍", created: 1, converted: 0 },
    ]);
    expect(rows[0]).toMatchObject({ label: "转介绍", value: 33.3, note: "1/3" });
  });

  it("分母为零时率记 0，不产出 NaN", () => {
    const rows = rateRows([{ key: "s1", label: "广告", created: 0, converted: 0 }]);
    expect(rows[0].value).toBe(0);
  });
});
