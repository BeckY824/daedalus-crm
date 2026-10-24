/**
 * 客户的「历史负责人」怎么摆（企业版 D-36，2026-10-24）。只管排和说，界面也引（不能碰 prisma）；
 * 读库在 owner-log-db.ts 的 历史负责人of
 */
export type 换负责人记录 = {
  at: string;
  /** 谁转的；人删了是 null */
  操作人: string | null;
  从: string | null;
  到: string | null;
  kind: string;
};

const 种类说法: Record<string, string> = {
  assign: "改负责人",
  claim: "从公海领取",
  "pool-assign": "从公海分配",
  deactivate: "成员停用转交",
  undo: "撤销",
};
export const 换负责人怎么来的 = (kind: string) => 种类说法[kind] ?? "改负责人";

/**
 * 历史负责人：原负责人们，最近换走的在前，同一个人只出现一次；现任不算（转走又转回来的，眼下就是他）。
 * 记录按时间正序传进来
 */
export function 历史负责人们(记录: 换负责人记录[], 现任: string): string[] {
  const 们: string[] = [];
  for (let i = 记录.length - 1; i >= 0; i--) {
    const 从 = 记录[i].从;
    if (从 && 从 !== 现任 && !们.includes(从)) 们.push(从);
  }
  return 们;
}

/** 悬停里那一行：「王五 把负责人从 张三 换成 李四（改负责人）」，时间另摆 */
export function 换负责人一句(r: 换负责人记录): string {
  return `${r.操作人 ?? "已删除的成员"} 把负责人从 ${r.从 ?? "（没有）"} 换成 ${r.到 ?? "（没有）"}（${换负责人怎么来的(r.kind)}）`;
}
