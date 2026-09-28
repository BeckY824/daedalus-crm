/**
 * 金额框的 formatter（2026-09-28 审查 S6）。
 *
 * 本机复现过：原来的 parser 把空串读成 0，全选删掉后框里剩「¥ 0」、光标停在最前，
 * 接着敲 18000 存下来的是 180,000。现在敲的时候原样返回人敲的字，失焦后才加千分位。
 */
import { describe, it, expect } from "vitest";
import { 金额格式 } from "@/lib/money-input";

describe("金额框：敲的时候不动人敲的字，失焦后再加千分位", () => {
  it("正在敲：原样返回，不加逗号——光标底下没有东西会挪", () => {
    expect(金额格式(1800, { userTyping: true, input: "1800" })).toBe("1800");
  });
  it("失焦后：加千分位，不带 ¥（¥ 在框外）", () => {
    expect(金额格式(180000, { userTyping: false, input: "" })).toBe("180,000");
    expect(金额格式(18000, { userTyping: false, input: "" })).toBe("18,000");
  });
  it("空着就是空，不是 0", () => {
    expect(金额格式(undefined, { userTyping: false, input: "" })).toBe("");
  });
});
