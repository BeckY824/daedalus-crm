/**
 * 企业版号码类型的格式校验（lib/enterprise/contact-format.ts，测试清单 B1–B6）：每种类型合格 / 不合格各几条，
 * 旺旺 ID 带子账号，+86 / 0086 写法当国内号。纯函数，不碰库
 */
import { describe, it, expect } from "vitest";
import { 验号码, 号码提示, 带进联系人 } from "@/lib/enterprise/contact-format";

const 过 = (类型: string, 值: string) => {
  const r = 验号码(类型, 值);
  if (!r.ok) throw new Error(`${类型} ${值} 应该过：${r.提示}`);
  return r;
};
const 状态 = (类型: string, 值: string, 有图?: boolean) => {
  const r = 验号码(类型, 值, { 有图 });
  return r.ok ? "ok" : r.状态;
};

describe("号码类型", () => {
  it("没选类型 / 不认识的类型：请选择号码类型", () => {
    expect(验号码(undefined, "13900000001")).toMatchObject({ ok: false, 状态: "未选类型", 提示: 号码提示.未选类型 });
    expect(验号码("WhatsApp", "13900000001")).toMatchObject({ ok: false, 状态: "未选类型" });
  });
});

describe("手机号（B1 / B2）", () => {
  it("国内 11 位；+86 / 0086 / 86 开头、空格横杠括号都规整成 11 位", () => {
    for (const s of ["13900000101", "+86 139 0000 0101", "+86-139-0000-0101", "0086 13900000101", "8613900000101", "(+86)13900000101", "１３９００００01０１"]) {
      expect(过("手机号", s)).toMatchObject({ 值: "13900000101", 键: "13900000101" });
    }
  });
  it("国外：+ 后面 8–15 位，00 开头当 +；值留 +、键去掉 +", () => {
    expect(过("手机号", "+1 415 555 0123")).toMatchObject({ 值: "+14155550123", 键: "14155550123", 国外: true });
    expect(过("手机号", "0044 20 7946 0958")).toMatchObject({ 值: "+442079460958", 国外: true });
    expect(过("手机号", "+12345678")).toMatchObject({ 国外: true });
  });
  it("格式错误：位数不对、+86 后不是 11 位、夹字母、国外超长", () => {
    for (const s of ["1390000010", "139000001011", "+86 1390000010", "139abc00101", "+1234567", "+1234567890123456", "139-0000-01x1"]) {
      expect(验号码("手机号", s)).toMatchObject({ ok: false, 状态: "格式错误", 提示: 号码提示.格式错误.手机号 });
    }
  });
  it("无法识别：空、全是符号、打了码的", () => {
    for (const s of ["", "   ", "--()", "139****0101", "无"]) expect(状态("手机号", s)).toBe("无法识别");
  });
});

describe("邮箱（B3）", () => {
  it("合格：去首尾空格，键小写", () => {
    expect(过("邮箱", "  Wang.Li@Example.COM ")).toMatchObject({ 值: "Wang.Li@Example.COM", 键: "wang.li@example.com" });
    expect(过("邮箱", "a_b-c@mail.co.uk").ok).toBe(true);
  });
  it("格式错误：没 @、两个 @、@ 开头、点挨着 @、连着两个点、全角句点、后缀不对、中间空格", () => {
    for (const s of ["abc.com", "a@b@c.com", "@abc.com", "a@.abc.com", "a..b@abc.com", "a@abc。com", "a@abc.c", "a@abc.c0m", "a@abc.comcomc", "a b@abc.com", "a@abc"]) {
      expect(验号码("邮箱", s)).toMatchObject({ ok: false, 状态: "格式错误", 提示: 号码提示.格式错误.邮箱 });
    }
  });
  it("无法识别：空、打了码", () => {
    expect(状态("邮箱", "")).toBe("无法识别");
    expect(状态("邮箱", "wa***@qq.com")).toBe("无法识别");
  });
});

describe("微信（B4）", () => {
  it("合格：字母开头 6–20 位，字母数字 _ -", () => {
    for (const s of ["wxid_abc", "Abc-123", "a12345", "a1234567890123456789"]) expect(过("微信", s).ok).toBe(true);
    expect(过("微信", " WangLi_88 ")).toMatchObject({ 值: "WangLi_88", 键: "wangli_88" });
  });
  it("格式错误：数字开头、太短、太长、带别的符号或汉字", () => {
    for (const s of ["1abcdef", "abc12", "a12345678901234567890", "abc.def", "abc 123", "王力abc123"]) {
      expect(验号码("微信", s)).toMatchObject({ ok: false, 状态: "格式错误", 提示: 号码提示.格式错误.微信 });
    }
  });
});

describe("旺旺 ID（B5）", () => {
  it("去掉空格和符号；4–30 位；键小写", () => {
    expect(过("旺旺ID", " tb-Shop 88 ")).toMatchObject({ 值: "tbShop88", 键: "tbshop88" });
    expect(过("旺旺ID", "ab_c").ok).toBe(true);
    expect(过("旺旺ID", "a".repeat(30)).ok).toBe(true);
  });
  it("一个 : 带子账号（全角冒号也认），整串比：主账号和子账号是两个号", () => {
    const 子 = 过("旺旺ID", "MyShop:kefu01");
    expect(子).toMatchObject({ 值: "MyShop:kefu01", 键: "myshop:kefu01" });
    expect(过("旺旺ID", "MyShop：kefu01").值).toBe("MyShop:kefu01");
    expect(过("旺旺ID", "MyShop").键).not.toBe(子.键);
  });
  it("格式错误：太短、太长、两个 :、: 在头尾、汉字", () => {
    for (const s of ["abc", "a".repeat(31), "a:b:c1", ":abcd", "abcd:", "旺旺店铺abc"]) {
      expect(验号码("旺旺ID", s)).toMatchObject({ ok: false, 状态: "格式错误", 提示: 号码提示.格式错误.旺旺ID });
    }
  });
  it("无法识别：空、全是符号、打了码", () => {
    for (const s of ["", " - . ", "abc***"]) expect(状态("旺旺ID", s)).toBe("无法识别");
  });
});

describe("二维码（B6）", () => {
  it("没图：请上传二维码图片；有图就过", () => {
    expect(验号码("二维码", "")).toMatchObject({ ok: false, 状态: "待上传", 提示: 号码提示.待上传 });
    expect(状态("二维码", "", true)).toBe("ok");
  });
});

describe("向导：查重后带进联系人（验收 #2）", () => {
  const 空 = { phone: "", email: "", wechat: "" };
  it("空着就带；改了号再查，没动过的那格跟着换成新号", () => {
    const 一 = 带进联系人(空, undefined, "手机号", "13900000001");
    expect(一).toEqual({ 改: { phone: "13900000001" }, 带过: { phone: "13900000001" } });
    const 现在 = { ...空, ...一.改 };
    const 二 = 带进联系人(现在, 一.带过, "手机号", "13900000009");
    expect(二).toEqual({ 改: { phone: "13900000009" }, 带过: { phone: "13900000009" } });
  });
  it("自己改过的那格不碰", () => {
    const 一 = 带进联系人(空, undefined, "邮箱", "a@corp.com");
    const 改过 = { ...空, email: "boss@corp.com" };
    expect(带进联系人(改过, 一.带过, "邮箱", "b@corp.com")).toEqual({ 改: {}, 带过: {} });
    expect(带进联系人({ ...空, phone: "13900000005" }, undefined, "手机号", "13900000001").改).toEqual({});
  });
  it("换了类型：旧类型那格没动过就清掉，新号带进新格", () => {
    const 一 = 带进联系人(空, undefined, "手机号", "13900000001");
    const 二 = 带进联系人({ ...空, ...一.改 }, 一.带过, "微信", "WangLi_88");
    expect(二).toEqual({ 改: { phone: "", wechat: "WangLi_88" }, 带过: { wechat: "WangLi_88" } });
  });
  it("旺旺 / 二维码没有对应的格：只清掉没动过的旧带入", () => {
    const 一 = 带进联系人(空, undefined, "邮箱", "a@corp.com");
    expect(带进联系人({ ...空, ...一.改 }, 一.带过, "旺旺ID", "MyShop")).toEqual({ 改: { email: "" }, 带过: {} });
  });
});
