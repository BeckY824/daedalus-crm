/**
 * 企业版开关：只有 CRM_ENTERPRISE 恰好是 "1" 才算开。
 * 写错成 true / yes 一律当关——宁可企业功能没出来，也不能让普通版莫名其妙多出企业规则。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { 企业版 } from "../src/lib/enterprise/switch";

afterEach(() => vi.unstubAllEnvs());

describe("企业版()", () => {
  it("没设 = 关", () => {
    vi.stubEnv("CRM_ENTERPRISE", undefined as unknown as string);
    expect(企业版()).toBe(false);
  });

  it("只认 \"1\"", () => {
    for (const v of ["0", "", "true", "yes", "enterprise", " 1"]) {
      vi.stubEnv("CRM_ENTERPRISE", v);
      expect(企业版(), v).toBe(false);
    }
    vi.stubEnv("CRM_ENTERPRISE", "1");
    expect(企业版()).toBe(true);
  });

  it("自部署 / 云端的 compose 都没开（只有 deploy/enterprise/ 那份开）", () => {
    const 根 = path.resolve(__dirname, "..");
    const 文件 = readdirSync(根).filter((f) => /^docker-compose.*\.yml$/.test(f));
    expect(文件.length).toBeGreaterThan(0);
    for (const f of 文件) expect(readFileSync(path.join(根, f), "utf8"), f).not.toMatch(/CRM_ENTERPRISE/);
  });
});
