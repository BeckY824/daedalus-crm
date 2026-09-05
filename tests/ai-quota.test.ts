/**
 * AI 配额。
 *
 * 防的是失控而不是恶意：循环脚本或连点的页面在没人察觉时刷掉调用量。
 * 窗口滑动要真滑——过了窗口必须自动恢复，不能变成变相封禁。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { consumeAiQuota, resetAiQuota, AI_LIMIT, AI_WINDOW_MS } from "@/lib/ai-quota";

beforeEach(() => resetAiQuota());

describe("AI 配额", () => {
  it(`窗口内前 ${AI_LIMIT} 次放行，第 ${AI_LIMIT + 1} 次拒绝并给出等待秒数`, () => {
    const now = 1_000_000;
    for (let i = 0; i < AI_LIMIT; i++) expect(consumeAiQuota("u1", now + i)).toBeNull();
    const wait = consumeAiQuota("u1", now + AI_LIMIT);
    expect(wait).toBeGreaterThan(0);
  });

  it("超限的尝试不计数——等到窗口滑过就恢复，不会越拒越久", () => {
    const now = 1_000_000;
    for (let i = 0; i < AI_LIMIT + 20; i++) consumeAiQuota("u1", now);
    expect(consumeAiQuota("u1", now + AI_WINDOW_MS + 1)).toBeNull();
  });

  it("配额按用户隔离，一个人刷爆不影响同事", () => {
    const now = 1_000_000;
    for (let i = 0; i < AI_LIMIT; i++) consumeAiQuota("u1", now);
    expect(consumeAiQuota("u1", now)).not.toBeNull();
    expect(consumeAiQuota("u2", now)).toBeNull();
  });
});
