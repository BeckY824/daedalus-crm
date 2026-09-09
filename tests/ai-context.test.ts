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

describe("编号与引用", () => {
  it("numbered 时每条前面是 [n]，供模型引用", async () => {
    const { formatTimeline } = await import("@/lib/ai-context");
    const out = formatTimeline(
      [
        { type: "SMS", content: "第一条", occurredAt: new Date("2026-09-03T10:00:00") },
        { type: "PHONE", content: "第二条", occurredAt: new Date("2026-08-20T10:00:00") },
      ],
      { numbered: true },
    );
    expect(out.split("\n")[0]).toMatch(/^\[1\] 09-03/);
    expect(out.split("\n")[1]).toMatch(/^\[2\] 08-20/);
  });

  it("splitCitations 把 [n] 切成编号，其它方括号不动", async () => {
    const { splitCitations } = await import("@/lib/ai-draft");
    expect(splitCitations("先问成绩[2]，再谈分期[2][5]。")).toEqual(["先问成绩", 2, "，再谈分期", 2, 5, "。"]);
    expect(splitCitations("没有引用")).toEqual(["没有引用"]);
    expect(splitCitations("[全程班] 可看回放 [123]")).toEqual(["[全程班] 可看回放 [123]"]);
  });

  it("mergeSteps 按 id 覆盖，顺序按首次出现", async () => {
    const { mergeSteps } = await import("@/lib/ai-steps");
    let list = mergeSteps([], { type: "step", id: "a", label: "A", status: "running", at: 1 });
    list = mergeSteps(list, { type: "step", id: "b", label: "B", status: "running", at: 2 });
    list = mergeSteps(list, { type: "step", id: "a", label: "A", status: "done", detail: "ok", at: 3 });
    expect(list.map((s) => `${s.id}:${s.status}`)).toEqual(["a:done", "b:running"]);
  });
});
