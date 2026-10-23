/**
 * 团队版「多久没同步上了」（2026-10-23 用户报「上次同步」停在两个小时前、自己没发现）。
 * 设置 → 团队 用它决定要不要挂那条黄的提醒；纯函数，测试直接算
 */
/** 这么久没同步上就提醒（2026-10-23）：前台 8 秒一轮、人多放慢也不过 30 秒一轮，5 分钟没成一轮就是出问题了 */
export const 提醒分钟 = 5;

/** 上一次同步上是什么时候：老的 .team.json 没有 lastOkAt，上一轮没出错就拿 lastSyncAt 算 */
export function 上次同步上(s: { lastSyncAt?: string | null; lastOkAt?: string | null; lastError?: string | null }): string | null {
  return s.lastOkAt ?? (s.lastError ? null : s.lastSyncAt ?? null);
}

/** 多久没同步上（分钟）：不到 提醒分钟、或说不准 = null */
export function 没同步上分钟(s: { lastSyncAt?: string | null; lastOkAt?: string | null; lastError?: string | null }, 现在: number): number | null {
  const t = 上次同步上(s);
  if (!t) return null;
  const 分 = Math.floor((现在 - Date.parse(t)) / 60_000);
  return 分 >= 提醒分钟 ? 分 : null;
}
