/**
 * 中转站余额不足的告警（lib/upstream-alert.ts）：认得出几家的说法、每次打日志、邮件 30 分钟最多一封
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 是余额不足, 余额告警, 设置告警发信 } from "@/lib/upstream-alert";

const 有SMTP = { SMTP_HOST: "smtp.x", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "a@x", ALERT_TO: "ops@x" } as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  设置告警发信(null);
  vi.restoreAllMocks();
});

describe("是余额不足", () => {
  it("认得出 b.ai / OpenAI / 中文的几种说法", () => {
    expect(是余额不足('{"error":{"code":"insufficient_user_quota","message":"credit insufficient balance: balance=129174 required=160530"}}')).toBe(true);
    expect(是余额不足('{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}')).toBe(true);
    expect(是余额不足("令牌额度不足")).toBe(true);
    expect(是余额不足("用户余额不足")).toBe(true);
  });
  it("普通 400 不算", () => {
    expect(是余额不足('{"error":{"message":"Invalid value for messages[0].role"}}')).toBe(false);
    expect(是余额不足("Rate limit reached for requests")).toBe(false);
    expect(是余额不足("")).toBe(false);
  });
});

describe("余额告警", () => {
  it("每次都打 [告警] 日志；没配 SMTP 不发信", async () => {
    const 日志 = vi.spyOn(console, "error").mockImplementation(() => {});
    const 发 = vi.fn(async () => {});
    设置告警发信(发);
    await 余额告警("gateway", "insufficient_user_quota", 1_000, {} as NodeJS.ProcessEnv);
    expect(String(日志.mock.calls[0][0])).toContain("[告警][中转站余额不足] gateway");
    expect(发).not.toHaveBeenCalled();
  });
  it("配了 SMTP：30 分钟内只发一封，过了再发；发给 ALERT_TO", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const 发 = vi.fn(async (_m: { to: string; subject: string; text: string }) => {});
    设置告警发信(发);
    const t0 = 10 * 3600_000;
    await 余额告警("gateway", "x", t0, 有SMTP);
    await 余额告警("research/search", "x", t0 + 29 * 60_000, 有SMTP);
    expect(发).toHaveBeenCalledTimes(1);
    expect(发.mock.calls[0][0].to).toBe("ops@x");
    await 余额告警("gateway", "x", t0 + 31 * 60_000, 有SMTP);
    expect(发).toHaveBeenCalledTimes(2);
  });
  it("发信失败不往外抛", async () => {
    const 日志 = vi.spyOn(console, "error").mockImplementation(() => {});
    设置告警发信(async () => { throw new Error("smtp down"); });
    await expect(余额告警("gateway", "x", 5_000_000, 有SMTP)).resolves.toBeUndefined();
    expect(日志.mock.calls.some((c) => String(c[0]).includes("邮件发不出去"))).toBe(true);
  });
});
