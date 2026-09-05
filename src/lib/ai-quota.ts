/**
 * AI 调用配额。
 *
 * 五个 AI 入口都是登录后可无限触发的真金白银调用（中转站按量计费）。
 * 团队只有几个人、彼此信任，防的不是恶意，而是失控：一个循环脚本、
 * 一个连点不止的卡顿页面，就能在没人察觉时刷掉一晚上的调用量。
 *
 * 滑动窗口按用户计数，超限拒绝并告知等待时间。与登录限流（rate-limit.ts）
 * 同一哲学：状态放内存，单容器够用，重启即清空，不为它引数据库。
 */

/** 每个用户在窗口内最多发起多少次 AI 动作 */
export const AI_LIMIT = 30;
/** 窗口长度（毫秒） */
export const AI_WINDOW_MS = 5 * 60 * 1000;

const 记录 = new Map<string, number[]>();

/**
 * 消耗一次配额。放行返回 null，超限返回还需等待的秒数（不计数）。
 * 放在 requireUser 之后、任何生成之前调用——无效输入也计数，
 * 限的是"尝试频率"本身，这比区分有效无效更简单也更保险。
 */
export function consumeAiQuota(userId: string, now = Date.now()): number | null {
  const stamps = (记录.get(userId) ?? []).filter((t) => t > now - AI_WINDOW_MS);
  if (stamps.length >= AI_LIMIT) {
    const wait = Math.ceil((stamps[0] + AI_WINDOW_MS - now) / 1000);
    记录.set(userId, stamps);
    return Math.max(wait, 1);
  }
  stamps.push(now);
  记录.set(userId, stamps);
  return null;
}

/** 测试用：清空所有计数 */
export function resetAiQuota() {
  记录.clear();
}
