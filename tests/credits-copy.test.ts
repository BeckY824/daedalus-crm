/**
 * 「你为什么只有 3 次」那句话。
 *
 * 钉它是因为这句话的失败方式是静悄悄的：字段没传下来时它只是不出现，
 * 而「不出现」和「本来就不该出现」长得一模一样——正是 0.39.2 那轮 umami
 * 少一个字段查了半天的同一种病。
 *
 * 2026-10-03 起没有每日赠送了，只送开户那 30 次：这句话里不许再有「每天登录再送」。
 */
import { describe, it, expect } from "vitest";
import { 赠送说明 } from "@/lib/credits-copy";

describe("赠送说明", () => {
  it("没领到开户赠送：说清是「这台电脑已经有人领过」，给出填 Key 的出路", () => {
    const s = 赠送说明({ 每日赠送: 0, 注册赠送: 30, 注册赠送已发: false, 每日赠送截至: null });
    expect(s).toContain("一台电脑只送一份");
    expect(s).toContain("别的账号领过");
    expect(s).toContain("AI 接入");
    expect(s).not.toContain("每天");
  });

  it("领到了：说一句用完不再补，不提机器", () => {
    const s = 赠送说明({ 每日赠送: 0, 注册赠送: 30, 注册赠送已发: true });
    expect(s).toContain("不再补");
    expect(s).toContain("AI 接入");
    expect(s).not.toContain("电脑");
    expect(s).not.toContain("每天");
  });

  it("老服务端还报着每日 3 次和截至日：一概不理，不许诺", () => {
    for (const 已发 of [true, false]) {
      const s = 赠送说明({ 每日赠送: 3, 注册赠送: 30, 注册赠送已发: 已发, 每日赠送截至: "2026-10-27" });
      expect(s).not.toContain("每天");
      expect(s).not.toContain("10 月 27 日");
    }
  });

  it("老版本服务端不返回「发没发」时什么都不说，不猜", () => {
    expect(赠送说明({ 每日赠送: 3, 注册赠送: 30 })).toBeNull();
    expect(赠送说明(null)).toBeNull();
    expect(赠送说明(undefined)).toBeNull();
  });
});
