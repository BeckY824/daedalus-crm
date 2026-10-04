/**
 * 桌面端本地服务的两道门（lib/desktop/local-guard.ts，2026-10-04，D-1）。
 * 原来本地 /login 对谁都 307 到 /api/desktop/session?t=<令牌>：同机别的系统账户、DNS 重绑定过来的网页都能拿到会话
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 是本机地址, 来自壳 } from "@/lib/desktop/local-guard";

describe("是本机地址", () => {
  it("127.0.0.1 / localhost / [::1]（带不带端口）都认", () => {
    for (const h of ["127.0.0.1", "127.0.0.1:3410", "localhost:51234", "[::1]", "[::1]:8080"]) expect(是本机地址(h), h).toBe(true);
  });
  it("重绑定过来的域名、局域网地址、空的一律不认", () => {
    for (const h of ["attacker.example.com", "attacker.example.com:3410", "127.0.0.1.attacker.com", "192.168.1.5:3410", "", null, undefined, "[::2]:80"]) {
      expect(是本机地址(h as string), String(h)).toBe(false);
    }
  });
});

describe("来自壳", () => {
  it("令牌对得上才算；空的、长度不同、内容不同都不算", () => {
    expect(来自壳("abc123", "abc123")).toBe(true);
    expect(来自壳("", "abc123")).toBe(false);
    expect(来自壳(null, "abc123")).toBe(false);
    expect(来自壳("abc12", "abc123")).toBe(false);
    expect(来自壳("abc124", "abc123")).toBe(false);
    expect(来自壳("abc123", undefined)).toBe(false);
  });
});

describe("接上了", () => {
  const 读 = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
  it("本地 /login 自动登录前要 来自壳 + 是本机地址", () => {
    const src = 读("src/app/login/page.tsx");
    const 段 = src.slice(src.indexOf("if (本地模式())"), src.indexOf("redirect(`/api/desktop/session"));
    expect(段).toContain("来自壳(");
    expect(段).toContain("是本机地址(");
  });
  it("session 路由拒非本机 Host；proxy 在本地模式下也拒", () => {
    expect(读("src/app/api/desktop/session/route.ts")).toMatch(/if \(!是本机地址\(req\.headers\.get\("host"\)/);
    expect(读("src/proxy.ts")).toMatch(/DESKTOP_LOCAL === "1" && !本机地址\(request\.headers\.get\("host"\)\)/);
  });
  it("壳给发往当前本地端口的请求带 x-desktop-token", () => {
    const src = 读("desktop/main.js");
    expect(src).toContain("session.defaultSession.webRequest.onBeforeSendHeaders(");
    expect(src).toMatch(/细\.requestHeaders\["x-desktop-token"\] = 本地\.token/);
  });
});
