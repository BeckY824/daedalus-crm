import { describe, it, expect } from "vitest";
import { formatTimeline, SOURCE_EACH_MAX } from "@/lib/ai-context";

const at = new Date("2026-09-01T10:00:00");

describe("formatTimeline", () => {
  it("有原文就附上原文，换行压成一行", () => {
    const out = formatTimeline([{ type: "SMS", content: "要点", occurredAt: at, owner: { name: "甲" }, source: { text: "a\nb" } }]);
    expect(out).toContain("原文：a / b");
  });

  it("没原文不出现「原文」字样", () => {
    const out = formatTimeline([{ type: "PHONE", content: "要点", occurredAt: at, owner: { name: "甲" } }]);
    expect(out).not.toContain("原文");
  });

  it("单条超长截断并标省略号；总预算耗尽后旧记录只留要点", () => {
    const long = "字".repeat(SOURCE_EACH_MAX + 10);
    const out = formatTimeline(
      [
        { type: "SMS", content: "新", occurredAt: at, source: { text: long } },
        { type: "SMS", content: "旧", occurredAt: at, source: { text: "旧原文" } },
      ],
      { budget: SOURCE_EACH_MAX },
    );
    expect(out).toContain("…");
    expect(out).not.toContain("旧原文");
  });
});
