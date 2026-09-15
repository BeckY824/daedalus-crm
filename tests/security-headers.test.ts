/**
 * 上线前审查（2026-09-15）发现托管版一条安全头都没有，还带着 x-powered-by。
 * 官网那边 nginx 加了，app 这边漏了。钉在这里，免得哪次重写 next.config 时又掉。
 */
import { describe, it, expect } from "vitest";
import nextConfig from "../next.config";

describe("安全响应头", () => {
  it("全路径都带，且不报框架名", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const 规则 = await nextConfig.headers!();
    const 全站 = 规则.find((r) => r.source === "/:path*");
    expect(全站, "要有一条覆盖所有路径的规则").toBeDefined();
    const 键 = Object.fromEntries(全站!.headers.map((h) => [h.key, h.value]));
    expect(键["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(键["X-Content-Type-Options"]).toBe("nosniff");
    expect(键["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(键["Strict-Transport-Security"]).toMatch(/^max-age=\d+$/);
    expect(键["Strict-Transport-Security"], "preload 撤不回来，不要加").not.toContain("preload");
  });
});
