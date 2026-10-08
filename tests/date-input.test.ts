import { it, expect } from "vitest";
import { parseDateInput } from "@/lib/date-input";
it("非法日历、时间、偏移及含糊格式全部拒绝", () => {
  for (const s of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-01-01T24:00", "2026-01-01T12:60", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00", "10/08/2026", "", null, {}, 12]) expect(parseDateInput(s), String(s)).toBeNull();
  expect(parseDateInput("2024-02-29T12:30:05.123+08:00")?.toISOString()).toBe("2024-02-29T04:30:05.123Z");
});
it("纽约夏令时缺失钟点拒绝；日期和合法钟点仍可解析", () => {
  const tz = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    expect(parseDateInput("2026-03-08T02:30")).toBeNull();
    expect(parseDateInput("2026-03-08T03:30")?.getHours()).toBe(3);
    expect(parseDateInput("2026-03-08")?.getDate()).toBe(8);
  } finally { process.env.TZ = tz; }
});
