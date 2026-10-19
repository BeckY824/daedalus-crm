/**
 * 公开进口记录（10-18 对比免费产品第七点）：英国 HMRC 的进口商名录（uktradeinfo.com 的开放接口，
 * 开放政府许可 OGL v3，免费、不用 key，每分钟 60 次）。ChatGPT 在 Sunrgy 那一题就是靠这类页面查到进口记录的。
 *
 * 按公司名找 Trader，再取它每个月申报进口过的商品编码（8 位 CN 码）。**名录里只有「哪个月进口过哪类商品」，
 * 没有数量和金额**：报告里照实写「不能据此判断采购量」。只查英国公司（国家 GB），名字要和登记名「同」或「近」。
 * 程序直查，不经模型：模型写不出、也改不了这一条。
 */
import { 取JSON, 查不了 } from "./net";
import { 比名字, 名词 } from "./names";

export type 进口月 = { 月: string; 编码: string; 品类: string };
export type 进口记录 = {
  /** 名录里登记的名字（HMRC 全大写） */
  名: string;
  地址?: string;
  /** 新的在前 */
  月份: 进口月[];
  /** 给人点的：这家在接口里的原始记录（JSON，能直接核） */
  链接: string;
};

const 基 = "https://api.uktradeinfo.com";

/** HS 前 4 位 → 中文品类（照明相关的几类写中文，别的原样用 HMRC 的英文描述） */
const 常见类: Record<string, string> = {
  "9405": "灯具",
  "8539": "灯泡 / 灯管 / LED 光源",
  "8541": "LED / 半导体器件",
  "8536": "开关、插座、连接器",
  "8544": "电线电缆",
  "8504": "变压器 / 电源 / 驱动",
  "8513": "手电筒 / 便携灯",
};

type 商人 = { TraderId: number; CompanyName: string; Address1?: string; Address2?: string; Address3?: string; Address4?: string; Address5?: string; PostCode?: string };
type 进口行 = { MonthId: number; Commodity?: { Cn8Code?: string; Hs4Code?: string; Hs4Description?: string } | null };

/** OData 字符串里的单引号写两遍 */
const 转义 = (s: string) => s.replace(/'/g, "''");

export function 月字(MonthId: number): string {
  const s = String(MonthId);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

export function 品类名(hs4: string | undefined, 英文?: string): string {
  if (hs4 && 常见类[hs4]) return 常见类[hs4];
  return (英文 ?? "").split(/[,;"]/)[0].trim().slice(0, 40) || "其他商品";
}

/** 照明类的 HS 码：9405 灯具、8539 光源、8541 LED。摘要里单独数一下 */
export const 是照明类 = (编码: string) => /^(9405|8539|8541)/.test(编码);

export async function 查英国进口(公司们: string[], signal?: AbortSignal): Promise<进口记录 | null> {
  const 名们 = [...new Set(公司们.map((x) => 名词(x).join(" ").toUpperCase()).filter((x) => x.length >= 3))].slice(0, 2);
  for (const q of 名们) {
    const r = await 取JSON<{ value?: 商人[] }>(`${基}/Trader?$filter=${encodeURIComponent(`contains(CompanyName,'${转义(q)}')`)}&$top=30`, { 秒: 10, signal });
    const 候选 = (r.data?.value ?? []).flatMap((t) => {
      const 像 = 公司们.map((c) => 比名字(c, t.CompanyName)).find(Boolean);
      return 像 ? [{ t, 像 }] : [];
    });
    const 选 = 候选.find((x) => x.像 === "同") ?? 候选[0];
    if (!选) continue;
    const id = 选.t.TraderId;
    const 链接 = `${基}/Trader(${id})?$expand=Imports($expand=Commodity($select=Cn8Code,Hs4Code,Hs4Description))`;
    const d = await 取JSON<商人 & { Imports?: 进口行[] }>(链接, { 秒: 15, signal });
    if (!d.data) throw new 查不了("HMRC 进口商名录没回这家的记录");
    const 月份 = (d.data.Imports ?? [])
      .filter((x) => x.Commodity?.Cn8Code)
      .map((x) => ({ 月: 月字(x.MonthId), 编码: x.Commodity!.Cn8Code!, 品类: 品类名(x.Commodity!.Hs4Code, x.Commodity!.Hs4Description) }))
      .sort((a, b) => (a.月 < b.月 ? 1 : a.月 > b.月 ? -1 : a.编码.localeCompare(b.编码)));
    const 址 = [选.t.Address1, 选.t.Address2, 选.t.Address3, 选.t.Address4, 选.t.Address5, 选.t.PostCode].map((x) => x?.trim()).filter((x) => x && x !== "-").join(", ");
    return { 名: 选.t.CompanyName, ...(址 ? { 地址: 址 } : {}), 月份, 链接 };
  }
  return null;
}

/**
 * 进口记录 → 报告里那一句。照明类单独数；只有编码没有量，明说不能据此判断采购量。
 * 「2023-05 至 2026-04 有 9 个月申报过进口，其中照明类（灯具、LED / 半导体器件）4 个月，最近一次 2024-11；
 *  最近的进口是纸制品、汽车配件。HMRC 只公布商品编码，不公布数量和金额，不能据此判断采购量」
 */
export function 进口摘要(r: 进口记录): string | null {
  if (!r.月份.length) return null;
  const 月们 = [...new Set(r.月份.map((x) => x.月))].sort();
  const 照明 = r.月份.filter((x) => 是照明类(x.编码));
  const 照明月 = [...new Set(照明.map((x) => x.月))].sort();
  const 照明类 = [...new Set(照明.map((x) => x.品类))];
  const 最近月 = 月们[月们.length - 1];
  const 最近类 = [...new Set(r.月份.filter((x) => x.月 === 最近月).map((x) => x.品类))];
  const 段 = [
    `HMRC 进口商名录（${r.名}）：${月们[0] === 最近月 ? 最近月 : `${月们[0]} 至 ${最近月}`} 有 ${月们.length} 个月申报过进口`,
    照明月.length ? `其中照明类（${照明类.join("、")}）${照明月.length} 个月，最近一次 ${照明月[照明月.length - 1]}` : "其中没有照明类（9405 / 8539 / 8541）",
  ];
  if (照明月.length && 照明月[照明月.length - 1] !== 最近月) 段.push(`最近一次（${最近月}）进口的是${最近类.join("、")}`);
  return `${段.join("，")}。HMRC 只公布商品编码，不公布数量和金额，不能据此判断采购量`;
}
