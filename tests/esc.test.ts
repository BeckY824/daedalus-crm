import { describe, it, expect } from "vitest";
import { Esc归别人 } from "@/lib/esc";

const 键 = (o: Partial<Parameters<typeof Esc归别人>[0]> = {}) => ({ key: "Escape", defaultPrevented: false, target: null, ...o });
const 没浮层 = () => false;

describe("Esc 只在没人要它的时候才打断回答（审查 M7）", () => {
  it("干干净净按一下 Esc：归页面", () => {
    expect(Esc归别人(键(), 没浮层)).toBe(false);
  });
  it("别的键不管", () => {
    expect(Esc归别人(键({ key: "Enter" }), 没浮层)).toBe(true);
  });
  it("已经有人处理过（关了斜杠菜单）：让出去", () => {
    expect(Esc归别人(键({ defaultPrevented: true }), 没浮层)).toBe(true);
  });
  it("输入法正在组字：那一下是取消拼音", () => {
    expect(Esc归别人(键({ isComposing: true }), 没浮层)).toBe(true);
    expect(Esc归别人(键({ keyCode: 229 }), 没浮层)).toBe(true);
  });
  it("按在浮层里：让出去", () => {
    const target = { closest: (s: string) => (s.includes(".ant-picker-dropdown") ? {} : null) };
    expect(Esc归别人(键({ target: target as unknown as EventTarget }), 没浮层)).toBe(true);
  });
  it("焦点不在浮层里、但页面上开着一层（⌘K、日期选择）：也让出去", () => {
    expect(Esc归别人(键(), () => true)).toBe(true);
  });
});
