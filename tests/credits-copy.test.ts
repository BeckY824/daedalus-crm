/**
 * 「你为什么只有 3 次」那句话。
 *
 * 钉它是因为这句话的失败方式是静悄悄的：字段没传下来时它只是不出现，
 * 而「不出现」和「本来就不该出现」长得一模一样——正是 0.39.2 那轮 umami
 * 少一个字段查了半天的同一种病。
 */
import { describe, it, expect } from "vitest";
import { 赠送说明 } from "@/lib/credits-copy";

describe("赠送说明", () => {
  it("没领到注册赠送时要说清是「这台电脑已经有人领过」，并且仍然告诉他每天还有几次", () => {
    const s = 赠送说明({ 每日赠送: 3, 注册赠送: 30, 注册赠送已发: false });
    expect(s).toContain("一台电脑只送一份");
    expect(s).toContain("别的账号领过");
    expect(s).toContain("3 次");
  });

  it("领到了就只说每日那句，不提机器——正常情况下没人需要听这段解释", () => {
    const s = 赠送说明({ 每日赠送: 3, 注册赠送: 30, 注册赠送已发: true });
    expect(s).toBe("每天登录再送 3 次");
  });

  it("老版本服务端不返回这个字段时什么都不说，不猜", () => {
    expect(赠送说明({ 每日赠送: 3 })).toBe("每天登录再送 3 次");
    expect(赠送说明({})).toBeNull();
    expect(赠送说明(null)).toBeNull();
  });

  it("每日赠送也不知道时，该解释的还是要解释", () => {
    const s = 赠送说明({ 注册赠送: 30, 注册赠送已发: false });
    expect(s).toContain("一台电脑只送一份");
    expect(s).not.toContain("每天登录");
  });
});
