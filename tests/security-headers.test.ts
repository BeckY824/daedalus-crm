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
    expect(键["Permissions-Policy"], "其余页面相机、话筒、定位都关着").toBe("camera=(), microphone=(), geolocation=()");
  });

  /**
   * 2026-10-20：手机伴侣扫名片「点了没反应」，/m 也带着 camera=()。/m 放开相机给自己，别的路径不变。
   * Next 的规则按顺序叠，同名头后面的覆盖前面的，所以这里按 Next 的路径匹配把每条规则过一遍，取最后一个
   */
  it("手机伴侣 /m 放开相机（只给自己），其余路径照旧关着", async () => {
    const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match");
    const 规则 = await nextConfig.headers!();
    const 头 = (路径: string) => {
      let 值: string | undefined;
      for (const r of 规则) {
        if (!getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(路径)) continue;
        for (const h of r.headers) if (h.key.toLowerCase() === "permissions-policy") 值 = h.value;
      }
      return 值;
    };
    for (const p of ["/m", "/m/sw.js", "/m/manifest.webmanifest"]) expect(头(p), p).toBe("camera=(self), microphone=(), geolocation=()");
    for (const p of ["/login", "/customers", "/api/mobile/sync", "/mobile", "/ma", "/ocr/v1/paddle.js"]) {
      expect(头(p), p).toBe("camera=(), microphone=(), geolocation=()");
    }
  });
});
