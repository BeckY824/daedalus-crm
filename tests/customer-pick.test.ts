import { describe, it, expect } from "vitest";
import { 客户候选 } from "@/lib/customer-pick";

describe("挑所属客户的下拉：重名分得出（2026-10-04 J-016）", () => {
  it("名字不重 → 只显示姓名，不添乱", () => {
    expect(客户候选([{ id: "1", name: "王强", school: "星辰科技", phone: "13800001111" }]).map((c) => c.label)).toEqual(["王强"]);
  });
  it("两位同名客户 → 各自带上公司和手机尾号，一眼分得出", () => {
    const r = 客户候选([
      { id: "1", name: "王强", school: "星辰科技", phone: "13800001111" },
      { id: "2", name: "王强", school: "海川外贸", phone: "13900002222" },
      { id: "3", name: "李娜", school: null, phone: "13700003333" },
    ]);
    expect(r.map((c) => c.label)).toEqual(["王强（星辰科技 · 尾号 1111）", "王强（海川外贸 · 尾号 2222）", "李娜"]);
  });
  it("同名还都没填公司 → 靠手机尾号分", () => {
    const r = 客户候选([
      { id: "1", name: "王强", school: null, phone: "13800001111" },
      { id: "2", name: "王强 ", school: "  ", phone: "13900002222" },
    ]);
    expect(r.map((c) => c.label)).toEqual(["王强（尾号 1111）", "王强（尾号 2222）"]);
  });
});
