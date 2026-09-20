/**
 * 官网首页那个「下载次数」的口径。
 *
 * 一个数，两个出处：GitHub 资产的 download_count，加上国内节点自己数的那一份。
 * 2026-09-20 起官网的下载按钮指向杭州那台（跨境线路实测 200–700 KB/s 且剧烈抖动，
 * GitHub、香港、公共代理都一样，瓶颈在线路不在源头），于是绝大多数人下载时
 * **GitHub 那个计数根本不动**——只有点了「从 GitHub 下载」备用链接的人才算进去。
 *
 * 逻辑单独放在这儿而不是写在 route.ts 里，是因为 Next 的 route 文件只允许导出
 * GET / POST / dynamic 这些约定的名字，多导出一个函数会在构建时报类型错误——
 * 也就没法给它写守卫用例。而这两条规则错了都不会报错，只会让首页安静地说一个假数。
 *
 * 数据来自官网仓库的 deploy/dl-count.py（每十分钟从 nginx 日志重算一次）。
 */

/** 国内节点的 counts.json 长这样：{"按版本": {"0.45.0": 3}} */
type 镜像计数 = { 按版本?: Record<string, unknown> };

/**
 * 从 counts.json 里取某一版的次数。
 *
 * **「这一版没有这个键」= 0，不是「取不到」**：一版刚发出去还没人下的时候，
 * dl-count.py 根本不会给它建键。把这种情况当成取不到的话，每发一版首页那一格
 * 都会消失几小时，而那几小时恰恰是最想看这个数的时候。
 *
 * 返回 undefined 表示**这份数据不可信**（结构不对、不是数、是负数），
 * 调用方应当整个不给「下载次数」这个字段。
 */
export function 镜像计数里的(版本: string, 原始: unknown): number | undefined {
  if (原始 === null || typeof 原始 !== "object") return undefined;
  const 按版本 = (原始 as 镜像计数).按版本;
  if (按版本 === undefined) return undefined; // 文件在、但结构不对，不能当 0
  if (按版本 === null || typeof 按版本 !== "object") return undefined;
  const n = (按版本 as Record<string, unknown>)[版本];
  if (n === undefined) return 0;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/**
 * 两边相加。
 *
 * **任一边取不到，整个数就不给**（返回 undefined，官网那边看到没有字段就不渲染那一格）。
 * 少数了一半的「下载次数」比没有这个数更糟——这是 api/public/stats 开头那条规矩：
 * 算不出来就不显示，绝不摆一个看起来像那么回事的数。
 */
export function 合并下载数(GitHub次数: number | undefined, 镜像次数: number | undefined): number | undefined {
  if (GitHub次数 === undefined || 镜像次数 === undefined) return undefined;
  return GitHub次数 + 镜像次数;
}
