import { describe, it, expect } from "vitest";
import { 线索转档案, 转化会带上 } from "@/lib/lead-convert";

const 通用 = { school: "公司", major: "行业" };
const 教培 = { school: "院校", major: "专业" };

describe("线索转客户带全资料（审查 M13）", () => {
  it("有联系人：联系人当姓名，线索名进公司，行业、来源都带上", () => {
    expect(线索转档案({ name: "海川外贸", contact: "张经理", industry: "外贸", source: "展会获取", remark: "要样品" }, 通用)).toEqual({
      name: "张经理", school: "海川外贸", major: "外贸", remark: "线索来源：展会获取\n要样品", 档案: { source: "展会获取", email: null },
    });
  });
  it("没有联系人：只能拿线索名当姓名，公司不重复填", () => {
    expect(线索转档案({ name: "海川外贸", contact: null, industry: null, source: "其他", remark: null }, 通用)).toEqual({
      name: "海川外贸", school: null, major: null, remark: null, 档案: { source: null, email: null },
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

describe("业务配置改了档案字段叫法也照样带对（2026-10-04 L-016）", () => {
  const 改名 = { school: "单位", major: "所属行业" };
  it("档案字段改名为「单位」「所属行业」→ 线索名进单位、联系人当姓名、行业照样带上", () => {
    expect(线索转档案({ name: "海川外贸", contact: "张经理", industry: "外贸", source: "展会获取", remark: null }, 改名)).toEqual({
      name: "张经理", school: "海川外贸", major: "外贸", remark: "线索来源：展会获取", 档案: { source: "展会获取", email: null },
    });
  });
  it("没联系人但有邮箱 → 邮箱写进备注，不丢", () => {
    const r = 线索转档案({ name: "海川外贸", contact: null, email: "buyer@haichuan.com", industry: null, source: "其他", remark: "要样品" }, 通用);
    expect(r.remark).toBe("邮箱：buyer@haichuan.com\n要样品");
  });
  it("联系人只有空格 → 当没联系人：线索名当姓名、邮箱进备注", () => {
    const r = 线索转档案({ name: "海川外贸", contact: "  ", email: "a@b.com", industry: null, source: "其他", remark: null }, 通用);
    expect(r.name).toBe("海川外贸");
    expect(r.school).toBeNull();
    expect(r.remark).toBe("邮箱：a@b.com");
  });
  it("有联系人时邮箱跟着联系人走，不重复进备注", () => {
    const r = 线索转档案({ name: "海川外贸", contact: "张经理", email: "a@b.com", industry: null, source: "其他", remark: null }, 通用);
    expect(r.remark).toBeNull();
  });
  it("确认框按实际会填的格子和当前叫法说：改名后说「单位」「所属行业」，没有的不说", () => {
    const 说 = 转化会带上({ name: "海川外贸", contact: "张经理", email: "a@b.com", industry: "外贸", source: "展会获取", remark: null }, 改名);
    expect(说).toBe("联系人（张经理）、单位、所属行业、邮箱、来源");
    expect(转化会带上({ name: "海川外贸", contact: null, email: null, industry: null, source: "其他", remark: null }, 改名)).toBe("");
    // 教培那套：线索名当姓名，不往院校里塞，所以不说「院校」
    expect(转化会带上({ name: "王小明", contact: "王妈妈", email: null, industry: "教育", source: "转介绍", remark: null }, 教培)).toBe("联系人（王妈妈）、来源");
  });
});

describe("外贸模版有了外贸档案（2026-10-05）：来源、邮箱进档案，不再写进备注", () => {
  it("外贸：备注里没有来源行和邮箱行，档案里有", () => {
    const r = 线索转档案({ name: "Acme", contact: null, email: "a@acme.com", industry: null, source: "阿里国际站", remark: "要样品" }, { school: "公司", major: "行业" }, true);
    expect(r.remark).toBe("要样品");
    expect(r.档案).toEqual({ source: "阿里国际站", email: "a@acme.com" });
  });
});
