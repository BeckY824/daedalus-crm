/**
 * 背调入口摆不摆（lib/research/channel.ts 背调有入口，10-24）：自部署 / 企业版网页上背调永远走不通，
 * 以前「背调」键照摆，一点就是「背调目前只在桌面端可用」。现在那里不摆；桌面端、开发、mock 照旧摆。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 背调有入口 } from "@/lib/research/channel";

afterEach(() => {
  vi.unstubAllEnvs();
});

function 环境(e: Record<string, string>) {
  vi.stubEnv("DESKTOP_LOCAL", "");
  vi.stubEnv("CRM_RESEARCH_CHANNEL", "");
  for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
}

describe("背调有入口", () => {
  it("自部署 / 企业版网页（正式环境、不在桌面端、不是 mock）：不摆", () => {
    环境({ NODE_ENV: "production", CRM_ENTERPRISE: "1" });
    expect(背调有入口()).toBe(false);
  });

  it("桌面端：摆（没登录也摆，点了说请先登录）", () => {
    环境({ NODE_ENV: "production", DESKTOP_LOCAL: "1" });
    expect(背调有入口()).toBe(true);
  });

  it("开发环境：摆（走模拟通道）", () => {
    环境({ NODE_ENV: "development" });
    expect(背调有入口()).toBe(true);
  });

  it("正式环境但 CRM_RESEARCH_CHANNEL=mock（e2e）：摆", () => {
    环境({ NODE_ENV: "production", CRM_RESEARCH_CHANNEL: "mock" });
    expect(背调有入口()).toBe(true);
  });
});
