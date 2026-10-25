/**
 * 企业版网页里不留我们云端 / 桌面端的页面（2026-10-24）：注册、条款、隐私、手机伴侣、反馈都跳走；
 * 开关关着时（桌面端、团队版、云端、开源自部署）这几页照旧。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { 企业版跳转 } from "../src/lib/enterprise/web-paths";
import { proxy } from "../src/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("企业版跳转()", () => {
  it("注册、条款、隐私回登录页", () => {
    for (const p of ["/signup", "/terms", "/privacy"]) expect(企业版跳转(p), p).toBe("/login");
  });

  it("手机伴侣、反馈回首页", () => {
    for (const p of ["/m", "/m/", "/m/sw.js", "/feedback"]) expect(企业版跳转(p), p).toBe("/dashboard");
  });

  it("别的页不动，长得像的也不误伤", () => {
    for (const p of ["/login", "/forgot", "/dashboard", "/customers", "/settings", "/me", "/members", "/mobile", "/feedbacks", "/signup-x", "/admin"]) {
      expect(企业版跳转(p), p).toBeNull();
    }
  });
});

const 请求 = (p: string) => new NextRequest(new URL(p, "http://crm.example.test"));

describe("proxy", () => {
  it("企业版：没登录打开注册 / 条款跳登录，手机页跳首页（再由下一趟送去登录）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "1");
    for (const [p, 去] of [["/signup", "/login"], ["/terms", "/login"], ["/privacy", "/login"], ["/m", "/dashboard"], ["/feedback", "/dashboard"]] as const) {
      const r = await proxy(请求(p + "?from=x"));
      expect(r.status, p).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname, p).toBe(去);
      expect(new URL(r.headers.get("location")!).search, p).toBe("");
    }
  });

  it("开关关着：条款、隐私、手机页没登录也照常打开", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    for (const p of ["/signup", "/terms", "/privacy", "/m"]) {
      const r = await proxy(请求(p));
      expect(r.headers.get("location"), p).toBeNull();
    }
  });
});
