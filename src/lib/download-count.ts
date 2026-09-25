/**
 * 官网首页那两个「下载次数」的口径：桌面端**累计**被下载了多少次，官网（国内节点）和 GitHub 分开报。
 * 2026-09-25 起；之前是「当前这一版、两边相加」一个数，用户要的是累计、而且分开看。
 *
 * 两个出处：GitHub 资产的 download_count，和国内节点自己数的那一份。
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

const 是次数 = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * 国内节点上**所有版本**加起来被完整下载了多少次。
 *
 * 2026-09-25 口径从「当前这一版」改成「累计」（用户定的：首页那个数要说一共被下了多少次，
 * 不是这一版）。一版都还没人下时 dl-count.py 不建键，那就是没有这一项，不影响总数。
 *
 * 返回 undefined 表示**这份数据不可信**（结构不对、有一项不是正常的数），
 * 调用方应当整个不给「官网下载数」这个字段。
 */
export function 镜像累计(原始: unknown): number | undefined {
  if (原始 === null || typeof 原始 !== "object") return undefined;
  const 按版本 = (原始 as 镜像计数).按版本;
  if (按版本 === null || typeof 按版本 !== "object") return undefined; // 文件在、但结构不对，不能当 0
  let 和 = 0;
  for (const n of Object.values(按版本 as Record<string, unknown>)) {
    if (!是次数(n)) return undefined;
    和 += Math.round(n);
  }
  return 和;
}

/**
 * GitHub 上**现存**的每一个 dmg 的 download_count 之和（所有 Release，含滚动的 desktop-updates）。
 *
 * **这是一个下限，不是精确总量**：打包 workflow 用 `--clobber` 重传过的包计数归零了，
 * 那部分历史找不回来。但它是真的——每一次都确实发生过，不靠攒、不靠估。
 * 只数 .dmg：.app.zip 和清单是应用内更新用的，不是「有人下载了桌面端」。
 */
export function GitHub累计(releases: unknown): number | undefined {
  if (!Array.isArray(releases)) return undefined;
  let 和 = 0;
  for (const r of releases) {
    const 资产 = (r as { assets?: unknown })?.assets;
    if (!Array.isArray(资产)) continue;
    for (const a of 资产 as { name?: unknown; download_count?: unknown }[]) {
      if (typeof a?.name !== "string" || !a.name.endsWith(".dmg")) continue;
      if (!是次数(a.download_count)) return undefined;
      和 += a.download_count;
    }
  }
  return 和;
}
