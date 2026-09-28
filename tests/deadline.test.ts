import { describe, it, expect } from "vitest";
import { dayjs } from "@/lib/utils";
import { 截止说法, 已过期 } from "@/lib/deadline";

const now = dayjs("2026-09-28T15:00:00");

describe("计划和待办的截止说法（审查 D1）", () => {
  it("过了的写「逾期 N 天」，不写「N 天前」", () => {
    expect(截止说法("2026-09-26T10:00:00", now)).toBe("逾期 2 天");
    expect(截止说法("2026-09-27T23:00:00", now)).toBe("逾期 1 天");
  });
  it("今天、明天带钟点", () => {
    expect(截止说法("2026-09-28T09:00:00", now)).toBe("今天 09:00");
    expect(截止说法("2026-09-29T14:30:00", now)).toBe("明天 14:30");
  });
  it("更远写月日，跨年补年份", () => {
    expect(截止说法("2026-10-07T10:00:00", now)).toBe("10 月 7 日");
    expect(截止说法("2027-01-03T10:00:00", now)).toBe("2027 年 1 月 3 日");
  });
  it("没定时间就说没定", () => {
    expect(截止说法(null, now)).toBe("没定时间");
  });
  it("今天早些时候到期的也算过期", () => {
    expect(已过期("2026-09-28T09:00:00", now)).toBe(true);
    expect(已过期("2026-09-28T18:00:00", now)).toBe(false);
    expect(已过期(null, now)).toBe(false);
  });
});
