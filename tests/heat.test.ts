/**
 * 冷热：多久没跟 → 四格。分档是产品上定的（两天 / 一周 / 两周 / 一个月），
 * 列表、记录页、窄名单三处都读这一个函数，所以在这里钉住，别哪处自己再算一遍。
 */
import { describe, it, expect } from "vitest";
import { dayjs, 冷热 } from "@/lib/utils";

const 今天 = dayjs("2026-09-28T09:00:00");
const 前 = (天: number, 时 = "20:00") => 今天.subtract(天, "day").format(`YYYY-MM-DDT${时}:00`);

describe("冷热", () => {
  it("从没跟过是空格，天数是 null——不能当成「今天跟过」", () => {
    expect(冷热(null, 今天)).toEqual({ 格: 0, 天: null });
    expect(冷热(undefined, 今天)).toEqual({ 格: 0, 天: null });
  });

  it("分档的边界", () => {
    const 格 = (天: number) => 冷热(前(天), 今天).格;
    expect([0, 1, 2].map(格)).toEqual([4, 4, 4]);
    expect([3, 6].map(格)).toEqual([3, 3]);
    expect([7, 13].map(格)).toEqual([2, 2]);
    expect([14, 29].map(格)).toEqual([1, 1]);
    expect([30, 400].map(格)).toEqual([0, 0]);
  });

  it("按日历天数：昨晚 11 点跟的，今天早上 9 点算 1 天，不是 0", () => {
    expect(冷热(前(1, "23:00"), 今天).天).toBe(1);
    expect(冷热(今天.format("YYYY-MM-DDT07:00:00"), 今天).天).toBe(0);
  });

  it("未来的时间（录错了日期）按今天算，不出负数", () => {
    expect(冷热(今天.add(3, "day").toISOString(), 今天)).toEqual({ 格: 4, 天: 0 });
  });
});

describe("哪些人不画冷热", () => {
  it("签了的、丢了的不用跟，不画——亮一格「凉了」只会把真该跟的人淹掉", async () => {
    const { 要看冷热 } = await import("@/components/Heat");
    expect(要看冷热("已签约")).toBe(false);
    expect(要看冷热("已流失")).toBe(false);
    expect(要看冷热("跟进中")).toBe(true);
    expect(要看冷热(null)).toBe(true);
  });
});

describe("建议卡的回执跟着任务表走", () => {
  it("重挂后还读得到；撤销、清掉任务时一起清", async () => {
    const { 记下回执, 读回执, 清掉建议结果, 记下建议结果, clearJob } = await import("@/lib/ai-jobs");
    记下建议结果("home:t1:p1", "done");
    记下回执("home:t1:p1", { at: "21:51", 撤销: { kind: "add_followup" } });
    expect(读回执("home:t1:p1")?.at).toBe("21:51");
    清掉建议结果("home:t1:p1");
    expect(读回执("home:t1:p1")).toBeUndefined();

    记下回执("home:t2:p1", { at: "09:00" });
    clearJob("home:t2");
    expect(读回执("home:t2:p1")).toBeUndefined();
  });
});
