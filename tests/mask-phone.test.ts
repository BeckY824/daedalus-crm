/**
 * 共享试用区给人看的号码打码（lib/utils.ts 的 maskPhone）。
 * 2026-10-04（回归核对 H-033）：原来只打 ≥11 位，8 位座机、香港号、短海外号原样给所有试用团队看
 */
import { describe, it, expect } from "vitest";
import { maskPhone } from "@/lib/utils";
import { 认回打码号 } from "@/lib/phone";

describe("maskPhone", () => {
  it("11 位手机号：前三后四", () => {
    expect(maskPhone("13800001111")).toBe("138****1111");
  });
  it("8 位座机、香港号、短海外号也打码，不再原样露出", () => {
    for (const 号 of ["65432198", "91234567", "0755123", "4401234567"]) {
      const 打 = maskPhone(号);
      expect(打, 号).toContain("****");
      expect(打, 号).not.toBe(号);
      expect(打.replace(/\*/g, "").length, 号).toBeLessThanOrEqual(4);
    }
  });
  it("很短的只给星号；空的给破折号", () => {
    expect(maskPhone("12345")).toBe("****");
    expect(maskPhone("")).toBe("—");
    expect(maskPhone(null)).toBe("—");
  });
  it("短号打码后交回来，照样认回原号（表单没改电话就不该把星号存进库）", () => {
    expect(认回打码号(maskPhone("65432198"), "65432198")).toBe("65432198");
  });
});
