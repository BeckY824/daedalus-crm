/**
 * 报价明细（2026-10-03 外贸第 3 块）：整理、合计、比对。不碰数据库，客户端和服务端都能引。
 *
 * 一行 = 产品 / 规格 / 数量 / 单位 / 单价，小计 = 数量 × 单价（不存）。产品和规格是自由文本：
 * 3 人的贸易公司不会先去建一个产品库，规格本来就写在描述里（见 外贸CRM模版.md 2.2）。
 */

export type 报价行 = { product: string; spec: string | null; qty: number; unit: string | null; unitPrice: number };

/** 一次报价最多几行。再多就不是「报价明细」而是一张清单，该用 Excel 导入 */
export const 报价行上限 = 50;

/** 常用单位：下拉里先给这几个，也能自己写 */
export const 常用单位 = ["pcs", "set", "ctn", "kg", "m", "㎡", "pair", "个", "套", "箱"];

const 文本 = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const 数 = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/[,，\s]/g, "")) : NaN);
/** 金额和数量都留到小数点后 4 位：单价常有 0.035 这种，数量有 12.5 kg */
const 留四位 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 从浏览器 / AI 来的行整理成能存的样子。整行空着（产品、数量、单价都没填）的直接丢掉——
 * 人点了「加一行」又没填，不该因此存不进去。填了一半的说清楚是哪一行。
 */
export function 整理报价行(input: unknown): { ok: true; 行: 报价行[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: true, 行: [] };
  const 行: 报价行[] = [];
  for (const [i, r] of input.entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    const product = 文本(x.product, 120);
    const spec = 文本(x.spec, 300) || null;
    const unit = 文本(x.unit, 20) || null;
    const 量 = 数(x.qty);
    const 价 = 数(x.unitPrice);
    const 空 = !product && !spec && !(量 > 0) && !(价 > 0);
    if (空) continue;
    const 第 = `第 ${i + 1} 行`;
    if (!product) return { ok: false, error: `${第}没写产品` };
    if (!Number.isFinite(量) || 量 < 0) return { ok: false, error: `${第}的数量要是一个不小于 0 的数` };
    if (!Number.isFinite(价) || 价 < 0) return { ok: false, error: `${第}的单价要是一个不小于 0 的数` };
    if (量 > 1e9 || 价 > 1e9) return { ok: false, error: `${第}的数太大了` };
    行.push({ product, spec, qty: 留四位(量), unit, unitPrice: 留四位(价) });
  }
  if (行.length > 报价行上限) return { ok: false, error: `一次报价最多 ${报价行上限} 行` };
  return { ok: true, 行 };
}

export function 小计(r: Pick<报价行, "qty" | "unitPrice">): number {
  return Math.round(r.qty * r.unitPrice * 100) / 100;
}

/** 合计留到分。逐行先算小计再加：和界面上一行行看到的数加起来对得上 */
export function 报价合计(行: Pick<报价行, "qty" | "unitPrice">[]): number {
  return Math.round(行.reduce((s, r) => s + 小计(r), 0) * 100) / 100;
}

/** 两版报价是不是一回事（同币种、行一样、顺序一样）。一样就不另记一版——只改了商机备注不该多出一次「报价」 */
export function 同一份报价(a: { currency: string; 行: 报价行[] }, b: { currency: string; 行: 报价行[] }): boolean {
  if (a.currency !== b.currency || a.行.length !== b.行.length) return false;
  return a.行.every((x, i) => {
    const y = b.行[i];
    return x.product === y.product && (x.spec ?? null) === (y.spec ?? null) && x.qty === y.qty && (x.unit ?? null) === (y.unit ?? null) && x.unitPrice === y.unitPrice;
  });
}

/** 认「同一个产品」：去空格、不分大小写。「LED Panel」和「led panel 」是一个东西 */
export function 产品键(product: string): string {
  return product.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 一行写成一句话给人 / 给 AI 看：「LED 面板灯（60×60）2000 pcs × 3.2」 */
export function 一行说法(r: 报价行): string {
  return `${r.product}${r.spec ? `（${r.spec}）` : ""} ${r.qty}${r.unit ? ` ${r.unit}` : ""} × ${r.unitPrice}`;
}
