/**
 * 客户换了销售负责人，原负责人在他身上没做完的活跟着走（2026-10-02 排查 B3）——这里只放说法，浏览器和服务端共用。
 * 真正转交在 lib/carry-over-db.ts 的「带走没做完的」（改负责人、批量分配、公海领取共用）。
 */
export type 带走数 = { 计划和待办: number; 商机: number };

/** 「，连同 2 条没做完的计划和待办、1 个进行中商机」；什么都没带走就是空串 */
export function 带走说法(n: 带走数 | undefined): string {
  if (!n) return "";
  const 项 = [n.计划和待办 && `${n.计划和待办} 条没做完的计划和待办`, n.商机 && `${n.商机} 个进行中商机`].filter(Boolean);
  return 项.length ? `，连同${项.join("、")}` : "";
}
