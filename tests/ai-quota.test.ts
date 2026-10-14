/**
 * AI 配额。
 *
 * 防的是失控而不是恶意：循环脚本或连点的页面在没人察觉时刷掉调用量。
 * 窗口滑动要真滑——过了窗口必须自动恢复，不能变成变相封禁。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { consumeAiQuota, consumeUserAiQuota, resetAiQuota, AI_LIMIT, AI_WINDOW_MS } from "@/lib/ai-quota";

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
  it("复制模板业务ID相同，工作区不同不挤桶；同工作区不同账号也隔离", () => {
    const a = { id: "template-admin", workspaceId: "a", accountId: "acc-a" };
    for (let i = 0; i < AI_LIMIT; i++) consumeUserAiQuota(a, 1_000_000);
    expect(consumeUserAiQuota(a, 1_000_000)).not.toBeNull();
    expect(consumeUserAiQuota({ ...a, workspaceId: "b" }, 1_000_000)).toBeNull();
    expect(consumeUserAiQuota({ ...a, accountId: "acc-b" }, 1_000_000)).toBeNull();
    // 同一账号同一工作区即使业务映射ID变化，不能借此绕过已有频率限制。
    expect(consumeUserAiQuota({ ...a, id: "changed-id" }, 1_000_000)).not.toBeNull();
  });
});
