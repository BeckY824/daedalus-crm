/**
 * 范围同步灰度开关（服务端，2026-10-14 候选 9）。
 *
 * - CRM_SCOPED_SYNC=1：开。没迁移过的团队，老板那台新版桌面端下一轮同步就自动迁移（不要求桌面端设环境变量）；
 *   业务员的旧接口（全队包）一律 409。
 * - CRM_SCOPED_SYNC_LEGACY_TEAMS=团队编号,团队编号：开关开着时仍按旧协议的团队（逃生口，见 docs/范围同步启用操作手册.md 回滚 3）。
 *   对这些团队开关等于关：state 回 enabled=false，老板不会开始迁移，业务员的旧接口照常可用。
 *   **已经有 SyncPrivacy 行的团队不受影响**（已开始 / 完成迁移的继续走新协议，不能退回全队包）——要退回须按手册先删那几行。
 *
 * 单独一个文件：sync-relay（旧中转）和 sync-scoped（新协议）都要用，sync-scoped 又引用了 sync-relay，放哪边都会互相引用。
 */
function 留旧协议的团队(): Set<string> {
  return new Set((process.env.CRM_SCOPED_SYNC_LEGACY_TEAMS ?? "").split(/[\s,]+/).filter(Boolean));
}

/** 开关开着、且这个团队不在例外名单里。不给 teamId = 只看总开关 */
export function 范围开关(teamId?: string): boolean {
  if (process.env.CRM_SCOPED_SYNC !== "1") return false;
  return !teamId || !留旧协议的团队().has(teamId);
}
