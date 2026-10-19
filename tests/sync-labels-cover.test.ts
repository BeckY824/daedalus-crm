/** 待核对 / 被盖掉清单里的表名（lib/sync/labels.ts）：每张同步表都有中文叫法，新加的表忘了补这里就红（2026-10-19 团队版主动排查） */
import { describe, expect, it } from "vitest";
import { 同步表 } from "@/lib/sync/tables";
import { 表的叫法 } from "@/lib/sync/labels";

describe("同步表的中文叫法", () => {
  it("每张同步表都有，不露英文表名", () => {
    expect(同步表.filter((t) => 表的叫法(t) === t)).toEqual([]);
  });
});
