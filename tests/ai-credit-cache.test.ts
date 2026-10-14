import { it, expect, vi } from "vitest";
import { 记AI余额, 已知AI用完 } from "@/lib/ai-credit-cache";

it("零额度短缓存隔离凭据和网关，允许已启动问题继续，补赠及30秒超时恢复", () => {
  let now = 1_000_000;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const cfg = { baseUrl: "https://qa.example/api/gateway/v1", apiKey: "test-cache-only-token" };
  try {
    记AI余额(cfg, 0, "q-last-credit");
    expect(已知AI用完(cfg, "q-last-credit")).toBe(false);
    expect(已知AI用完(cfg, "q-new")).toBe(true);
    // 单独刷新到0仍不截断已经开始的最后一个问题。
    记AI余额(cfg, 0);
    expect(已知AI用完(cfg, "q-last-credit")).toBe(false);
    expect(已知AI用完({ ...cfg, apiKey: "another-token" })).toBe(false);
    expect(已知AI用完({ ...cfg, baseUrl: "https://another.example/v1" })).toBe(false);
    记AI余额(cfg, 2);
    expect(已知AI用完(cfg)).toBe(false);
    记AI余额(cfg, 0);
    now += 30_001;
    expect(已知AI用完(cfg)).toBe(false);
  } finally { spy.mockRestore(); }
});
