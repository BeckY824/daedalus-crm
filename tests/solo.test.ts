import { describe, it, expect } from "vitest";
import { 列表不问归属, 列表不问归属ID } from "@/lib/solo";

describe("列表页一个人时不摆负责人（审查 D2）", () => {
  const 我 = [{ name: "林小雨" }];
  it("一个人、每行都是他：不摆", () => {
    expect(列表不问归属(我, ["林小雨", "林小雨", null])).toBe(true);
  });
  it("空库也不摆", () => {
    expect(列表不问归属(我, [])).toBe(true);
    expect(列表不问归属([], [])).toBe(true);
  });
  it("两个人：照摆", () => {
    expect(列表不问归属([{ name: "甲" }, { name: "乙" }], ["甲"])).toBe(false);
  });
  it("一个人，但还挂着停用同事名下的旧记录：照摆，不悄悄抹掉归属", () => {
    expect(列表不问归属(我, ["林小雨", "王老师"])).toBe(false);
  });
});

it("同名停用成员的历史ID不等于唯一在职成员，归属维度必须显示", () => {
  expect(列表不问归属ID([{id:"a"}], ["a", "b"])).toBe(false);
  expect(列表不问归属ID([{id:"a"}], ["a", null])).toBe(true);
});
