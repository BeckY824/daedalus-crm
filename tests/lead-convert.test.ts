import { describe, it, expect } from "vitest";
import { 线索转档案 } from "@/lib/lead-convert";

const 通用 = { school: "公司", major: "行业" };
const 教培 = { school: "院校", major: "专业" };

describe("线索转客户带全资料（审查 M13）", () => {
  it("有联系人：联系人当姓名，线索名进公司，行业、来源都带上", () => {
    expect(线索转档案({ name: "海川外贸", contact: "张经理", industry: "外贸", source: "展会获取", remark: "要样品" }, 通用)).toEqual({
      name: "张经理", school: "海川外贸", major: "外贸", remark: "线索来源：展会获取\n要样品",
    });
  });
  it("没有联系人：只能拿线索名当姓名，公司不重复填", () => {
    expect(线索转档案({ name: "海川外贸", contact: null, industry: null, source: "其他", remark: null }, 通用)).toEqual({
      name: "海川外贸", school: null, major: null, remark: null,
    });
  });
  it("教培那套字段：线索名照旧当姓名，不往院校里塞", () => {
    const r = 线索转档案({ name: "王小明", contact: "王妈妈", industry: "教育", source: "转介绍", remark: null }, 教培);
    expect(r.name).toBe("王小明");
    expect(r.school).toBeNull();
    expect(r.major).toBeNull();
    expect(r.remark).toBe("线索来源：转介绍");
  });
});
