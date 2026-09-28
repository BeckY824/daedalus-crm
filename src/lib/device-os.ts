/**
 * 设备系统给人看的那几样：系统名、按系统数一遍、「Mac 1 · Windows 1」这句话。
 *
 * **不碰数据库**，单独一个文件：运营台的客户端组件要用它们。和记设备的代码
 * （lib/tenant/device-info.ts）放在一起的话，客户端一引就把 Prisma 整个打进了浏览器——
 * 2026-09-28 本地预览时报「PrismaClient is unable to run in this browser environment」。
 */

/** 给人看的系统名 */
export function 系统名(platform: string | null | undefined): "Mac" | "Windows" | "Linux" | "未知" {
  return platform === "darwin" ? "Mac" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "未知";
}

export type 设备分布 = { Mac: number; Windows: number; Linux: number; 未知: number };

/**
 * 一组设备按系统数一遍。运营台顶上那张卡和账号表那一列都用它——两处说的必须是同一个数。
 * 「未知」是 0.46.6 及之前装出去、还没升级的那些：不从电脑名去猜（「DESKTOP-XXXX」多半是 Windows，
 * 但「多半」不是数据）。
 */
export function 数设备(设备: { platform?: string | null }[]): 设备分布 {
  const 分 = { Mac: 0, Windows: 0, Linux: 0, 未知: 0 };
  for (const d of 设备) 分[系统名(d.platform)]++;
  return 分;
}

/** 「Mac 1 · Windows 1」这样的一句；只有未知的就老实说台数 */
export function 分布说法(分: 设备分布): string {
  const 段 = (["Mac", "Windows", "Linux", "未知"] as const).filter((k) => 分[k] > 0).map((k) => `${k} ${分[k]}`);
  return 段.join(" · ");
}
