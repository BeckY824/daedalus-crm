/**
 * 首页「帮我背调 XX」的认法（lib/research/intent.ts）。宁可漏认，不要把问背调本身的问题当成要背调一家公司。
 */
import { describe, it, expect } from "vitest";
import { 认背调意图 } from "@/lib/research/intent";

describe("认背调意图", () => {
  it.each([
    ["帮我背调 Lumora Trading GmbH", "Lumora Trading GmbH"],
    ["背调一下 Lumora Trading GmbH，看值不值得开发", "Lumora Trading GmbH"],
    ["请背调：「Nordlicht Elektro」", "Nordlicht Elektro"],
    ["帮我背调一下深圳市某某照明有限公司", "深圳市某某照明有限公司"],
    ["做个背调 ACME Ltd.", "ACME Ltd."],
    ["Lumora Trading GmbH 背调一下", "Lumora Trading GmbH"],
    ["对 Sol Andino 做个背调", "Sol Andino"],
    ["帮我把 Sol Andino 这家公司背调一下", "Sol Andino"],
  ])("「%s」→ %s", (q, 公司) => {
    expect(认背调意图(q)).toBe(公司);
  });

  it.each(["背调要多少钱", "背调是什么功能", "怎么背调", "张三最近怎么样", "背调", "帮我背调"])("不当成背调：「%s」", (q) => {
    expect(认背调意图(q)).toBeNull();
  });
});
