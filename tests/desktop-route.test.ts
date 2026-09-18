/**
 * 重启回到原地（desktop/route-memory.js）。
 *
 * 更新之后应用重启，以前一律落回 /dashboard：刚看到一半的客户记录没了。
 * 记路径的规矩要钉两头：该记的记到（含 query），不该记的一个都不记——
 * 记了登录页，人被送回门口；记了别的站，等于把外链当首页。
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { 可恢复的路径 } = require_("../desktop/route-memory.js");
const 根 = "http://127.0.0.1:3100";

describe("可恢复的路径", () => {
  it("应用里的页记下来，query 一起带", () => {
    expect(可恢复的路径(`${根}/customers/abc`, 根)).toBe("/customers/abc");
    // new URL() 会把中文百分号编码——那正是浏览器实际发出去的形式，回去时也照样认
    expect(可恢复的路径(`${根}/customers?status=待跟进`, 根)).toBe(`/customers?status=${encodeURIComponent("待跟进")}`);
  });
  it("门口那些页不记：登录、注册、找回、API、后台、_next", () => {
    for (const p of ["/login", "/login?reason=revoked", "/signup", "/forgot", "/api/desktop/session?t=x", "/admin", "/_next/static/x"]) {
      expect(可恢复的路径(`${根}${p}`, 根), p).toBeNull();
    }
  });
  it("首页不记——它本来就是默认落点", () => {
    expect(可恢复的路径(`${根}/`, 根)).toBeNull();
  });
  it("别的站一律不记，坏 URL 不抛", () => {
    expect(可恢复的路径("https://ai-daedalus.com/customers/abc", 根)).toBeNull();
    expect(可恢复的路径("not a url", 根)).toBeNull();
    expect(可恢复的路径("", 根)).toBeNull();
    expect(可恢复的路径(`${根}/customers/abc`, "")).toBeNull();
  });
});
