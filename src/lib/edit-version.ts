/**
 * 编辑框的版本闸门（2026-10-01 排查 D3），商机、线索、联系人、渠道共用。
 *
 * 原来这几样保存是整条覆盖：编辑框开着的时候同事在管道页把商机拖到「谈判审核」，
 * 这边一保存，阶段又被打回旧值，谁都不知道。现在打开编辑框时带上 updatedAt，
 * 保存用 updateMany + updatedAt 当条件——期间有人改过就匹配不到、一行都不写，说一声。
 * 客户那张表有更细的「没撞到同一格就自动合并」（customers/actions.ts saveCustomer），这几样字段少，先做到不盖掉。
 */
/**
 * 话里不说「被别人改过」：桌面端一个人用，也能自己撞上（开着编辑框又在列表上拖了一下、开了第二个窗口），
 * 那时说「别人」就是错话（2026-10-02 按桌面端 / 网页端复核）
 */
export const 版本冲突 = "打开编辑框之后这条又变过了，这次没保存。关掉重新打开看最新的，再改一次";

/** 前端交回来的版本号 → where 条件里的那一格。没给（老页面、AI 卡）就不加闸门，照旧 */
export function 版本条件(版本: string | null | undefined): { updatedAt: Date } | Record<string, never> {
  if (!版本) return {};
  const d = new Date(版本);
  return Number.isNaN(d.getTime()) ? {} : { updatedAt: d };
}

/**
 * 过了闸门之后写进去的新版本号：max(现在, 旧版本 + 1 毫秒)。
 * updatedAt 只到毫秒，同一毫秒里连存两次版本号不变，旧版本会再次对上、闸门形同虚设——
 * 和 saveCustomer 的 bump 同一个道理（2026-10-04 J-105，跟进 / 计划 / 待办先用上）。没给版本就不碰，交给 @updatedAt
 */
export function 推进版本(版本: string | null | undefined): { updatedAt: Date } | Record<string, never> {
  const 条件 = 版本条件(版本);
  return "updatedAt" in 条件 ? { updatedAt: new Date(Math.max(Date.now(), 条件.updatedAt.getTime() + 1)) } : {};
}
