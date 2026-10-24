import { OPP_STAGES } from "@/lib/constants";
import { 按币种合计, 规整币种, type 币种合计 } from "@/lib/currency";

/**
 * 商机管道的「每列摆几张」和列头怎么算（页面和服务端都用，不碰库；取数在 lib/pipeline-page.ts）。
 */

export const 每批 = 50;

/** 一列在「全部」上的条数和按币种合计；每个币种另记条数，挪走最后一张时那个币种才能从列头去掉 */
export type 列汇总 = { 条数: number; 合计: (币种合计 & { 条数: number })[] };

/** URL 里的 n=50,100,50,50,50（按 OPP_STAGES 的顺序）→ 每列取几张；缺的、不合法的、小于一批的都按一批 */
export function 读每列(n: string | undefined | null): Record<string, number> {
  const 段 = (n ?? "").split(",");
  return Object.fromEntries(
    OPP_STAGES.map((s, i) => {
      const v = Number(段[i]);
      return [s, Number.isSafeInteger(v) && v > 每批 ? v : 每批];
    }),
  );
}

export function 写每列(每列: Record<string, number>): string {
  return OPP_STAGES.map((s) => 每列[s] ?? 每批).join(",");
}

/** 一批行汇总成列头（服务端在全部行上算；行序要和页面一致：金额从大到小） */
export function 汇总<T>(行: T[], 取金额: (r: T) => number, 取币种: (r: T) => string): 列汇总 {
  const 条数 = new Map<string, number>();
  for (const r of 行) {
    const c = 规整币种(取币种(r));
    条数.set(c, (条数.get(c) ?? 0) + 1);
  }
  return { 条数: 行.length, 合计: 按币种合计(行, 取金额, 取币种).map((x) => ({ ...x, 条数: 条数.get(x.币种) ?? 0 })) };
}

type 卡 = { stage: string; amount: number; currency: string };

/**
 * 列头的条数和合计。
 *   这一列全取回来了（个人版几乎都是）：照原来在卡片上算，挪着的那张也照原来按「显示在哪列」算。
 *   只取了前几张：用服务端在全部行上算好的，再把正在挪的（签约框开着、还没写库的那张）挪出 / 挪进
 */
export function 列头<R extends 卡>(
  stage: string,
  已载: R[],
  显示阶段: (r: R) => string,
  全: 列汇总 | undefined,
): { 条数: number; 合计: 币种合计[]; 还有: number } {
  const 本列 = 已载.filter((r) => 显示阶段(r) === stage);
  const 取回 = 已载.filter((r) => r.stage === stage).length;
  if (!全 || 全.条数 <= 取回) return { 条数: 本列.length, 合计: 按币种合计(本列, (r) => r.amount, (r) => r.currency), 还有: 0 };
  const m = new Map(全.合计.map((x) => [x.币种, { 合计: x.合计, 条数: x.条数 }]));
  let 条数 = 全.条数;
  for (const r of 已载) {
    const 原 = r.stage === stage;
    const 现 = 显示阶段(r) === stage;
    if (原 === 现) continue;
    const c = 规整币种(r.currency);
    const v = m.get(c) ?? { 合计: 0, 条数: 0 };
    const 加 = 现 ? 1 : -1;
    v.合计 += 加 * (Number(r.amount) || 0);
    v.条数 += 加;
    条数 += 加;
    m.set(c, v);
  }
  const 合计 = [...m.entries()].filter(([, v]) => v.条数 > 0).map(([币种, v]) => ({ 币种, 合计: v.合计 })).sort((a, b) => b.合计 - a.合计);
  return { 条数, 合计, 还有: 全.条数 - 取回 };
}
