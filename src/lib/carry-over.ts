/**
 * 客户换了销售负责人，原负责人在他身上没做完的活跟着走（2026-10-02 排查 B3）——这里只放说法，浏览器和服务端共用。
 * 真正转交在 lib/carry-over-db.ts 的「带走没做完的」（改负责人、批量分配、公海领取共用）。
 */
/** 项目：团队版项目模式里跟着客户走的项目，开关从没开过就是 0（老版本没这一项） */
export type 带走数 = { 计划和待办: number; 商机: number; 项目?: number };

/** 「，连同 2 条没做完的计划和待办、1 个进行中商机」；什么都没带走就是空串 */
export function 带走说法(n: 带走数 | undefined): string {
  if (!n) return "";
  const 项 = [n.计划和待办 && `${n.计划和待办} 条没做完的计划和待办`, n.商机 && `${n.商机} 个进行中商机`, n.项目 && `${n.项目} 个项目`].filter(Boolean);
  return 项.length ? `，连同${项.join("、")}` : "";
}

/** 转之前先列出会一起转走的项目（企业版 D-36，2026-10-24）。列名字最多这么多个，再多说「等 N 个」 */
export const 预览列几个 = 8;
export type 转走项目预览 = { 项目数: number; 项目: { name: string; 客户: string }[] };

/** 确认框里那几行：标题「会一起转走的 3 个项目」+ 每行「项目名（客户名）」，多出来的说一句；一个都没有 = null（不弹框） */
export function 转走项目说法(p: 转走项目预览 | null | undefined): { 标题: string; 行: string[]; 还有: string } | null {
  if (!p?.项目数) return null;
  return {
    标题: `会一起转走的 ${p.项目数} 个项目`,
    行: p.项目.map((x) => `${x.name}（${x.客户}）`),
    还有: p.项目数 > p.项目.length ? `等共 ${p.项目数} 个` : "",
  };
}
