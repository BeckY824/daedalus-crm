/**
 * 读 xlsx —— 只读，只取一张工作表，只出字符串二维数组。
 *
 * ## 为什么不用 SheetJS
 *
 * npm 上那个 `xlsx` 停在 0.18.5（SheetJS 团队 2023 年搬到自己的 CDN 发布了），
 * 那一版挂着几条未修的公告；从 CDN 装则要在 package.json 里写一个非 registry 的
 * URL，`npm ci` 从此依赖那台 CDN 活着。而我们要的功能只有一句话：
 * **把第一张表读成字符串二维数组。**
 *
 * xlsx 本身就是一个 zip 里装着几个 XML。解压用 fflate（30KB、零依赖、在 npm 上、
 * 有人维护），剩下的是读两个 XML 里的几个标签。代价是这个文件要自己维护，
 * 收益是不多背一个停更的大包，也不把构建拴在别人的 CDN 上。
 *
 * ## 明确不支持的（都会以「读不出来」的形式说出来，不会悄悄给个错的结果）
 *
 * - **多工作表**：只读第一张。人手上那份名单几乎总是一张表，而「我导的是第二张」
 *   这件事一旦猜错，导进来的是一整份不相干的数据
 * - 公式：读的是 Excel 自己缓存的计算结果（`<v>`），够用
 * - 图片、批注、格式：不读，这里只要值
 * - **日期不在这里认**：Excel 存的是序列号，原样当字符串交出去，
 *   由 plan.ts 的 `认日期` 统一处理——两处各认一遍就会有两种结果。
 *   唯一的例外是 **1904 日期系统**（老版 Mac Excel / Numbers 存的簿子，workbook.xml 里
 *   `<workbookPr date1904="1"/>`）：序列号从 1904-01-01 数起，比 1900 系统少 1462 天。
 *   这里把**日期格式**的格子换回 1900 系统的序列号，下游只认一种（2026-10-04 J-054）。
 *   号码、金额也是数字，所以只动单元格样式是日期格式的那几格
 */
import { unzipSync, strFromU8 } from "fflate";
import { 列数上限, 行数上限 } from "./parse";

/** `A1` / `BC12` → 列下标（从 0 数）。行号不用，行的顺序由 <row> 自己保证 */
function 列号(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** 取出每一个 <t> 的文字。富文本的一个单元格会被拆成好几段 <t>，拼起来才是原文 */
function 取文字(xml: string): string {
  const out: string[] = [];
  // 自闭合的 <t …/> 放前面认：否则 `\s[^>]*` 会把 `/` 吃进去，当成开标签一路吞到下一段的 </t>（2026-10-02 排查）
  const re = /<t\b[^>]*?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(解转义(m[1] ?? ""));
  return out.join("");
}

function 解转义(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    // & 放最后，否则 &amp;lt; 会被解成 <
    .replace(/&amp;/g, "&");
}

export class 读不出来 extends Error {}

/** 1904 系统比 1900 系统的序列号少这么多天（1900-01-01 到 1904-01-01，含 Excel 那个不存在的 1900-02-29） */
const 差1904 = 1462;

/**
 * Excel 内置的日期 / 时间格式编号。14–22 是通用的，27–36、50–58 是中日韩区域的日期格式，45–47 是分秒
 * （ECMA-376 第 18.8.30 节；SheetJS 的 SSF 也是这张表）
 */
function 内置日期格式(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
}

/** 自定义格式串像不像日期：去掉引号里的字、方括号（颜色 / 区域 / 经过时间）、转义字符后，还有 y m d h s */
function 像日期格式(code: string): boolean {
  const 净 = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[ymdhs]/i.test(净);
}

/**
 * 每个样式下标（单元格的 s 属性）是不是日期格式。只有 1904 的簿子才用得着，别的簿子不读 styles.xml
 */
function 日期样式表(styles: string | null): boolean[] {
  if (!styles) return [];
  const 自定义 = new Map<number, string>();
  const fre = /<numFmt\b[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = fre.exec(styles))) 自定义.set(Number(m[1]), 解转义(m[2]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const out: boolean[] = [];
  const xre = /<xf\b([^>]*?)\/?>/g;
  while ((m = xre.exec(xfs))) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    const 码 = 自定义.get(id);
    out.push(码 !== undefined ? 像日期格式(码) : 内置日期格式(id));
  }
  return out;
}

/**
 * xlsx 的字节 → 字符串二维数组。
 *
 * 出来的形状和 `解析CSV` 一模一样，**从这里往后不再区分来源**——
 * 映射、复核、预览、执行、撤销全都只有一套。
 */
export function 读xlsx(bytes: Uint8Array): string[][] {
  return 读xlsx带行号(bytes).rows;
}

/**
 * 同上，外加每一行在表里的行号（从 1 数，就是 Excel 左边那一列的数）。
 * 空行丢掉了、标题行之后也会被 成表 丢掉，报错时得说得出 Excel 里的哪一行（2026-10-04 J-058）
 */
export function 读xlsx带行号(bytes: Uint8Array): { rows: string[][]; 行号: number[] } {
  let 包: Record<string, Uint8Array>;
  try {
    包 = unzipSync(bytes);
  } catch {
    throw new 读不出来("这个文件打不开。如果它是 .xls（2003 年那种老格式），请在 Excel 里另存为 .xlsx 或 .csv");
  }

  const 拿 = (p: string) => {
    const 命中 = Object.keys(包).find((k) => k.toLowerCase() === p.toLowerCase());
    return 命中 ? strFromU8(包[命中]) : null;
  };

  // 共享字符串表：xlsx 把重复的文本抽出来存一份，单元格里放下标
  const 共享 = (() => {
    const xml = 拿("xl/sharedStrings.xml");
    if (!xml) return [];
    const out: string[] = [];
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) out.push(取文字(m[1] ?? ""));
    return out;
  })();

  /*
    第一张表是哪个文件。

    **不能想当然地读 `xl/worksheets/sheet1.xml`**：那个编号是内部 id，
    删过工作表的簿子里第一张表很可能叫 sheet2.xml。
    workbook.xml 里 <sheet> 的出现顺序才是标签页从左到右的顺序，
    它的 r:id 经 workbook.xml.rels 指到真正的文件。
  */
  const wb = 拿("xl/workbook.xml");
  let 表文件 = "xl/worksheets/sheet1.xml";
  if (wb) {
    const s = /<sheet\b[^>]*>/.exec(wb)?.[0];
    const rid = s ? /r:id="([^"]+)"/.exec(s)?.[1] : null;
    const rels = 拿("xl/_rels/workbook.xml.rels");
    if (rid && rels) {
      const re = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`);
      const target = re.exec(rels)?.[0] && /Target="([^"]+)"/.exec(re.exec(rels)![0])?.[1];
      if (target) 表文件 = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }
  const sheet = 拿(表文件) ?? 拿("xl/worksheets/sheet1.xml");
  if (!sheet) throw new 读不出来("这个 xlsx 里找不到工作表");

  const 是1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/i.test(wb ?? "");
  const 日期样式 = 是1904 ? 日期样式表(拿("xl/styles.xml")) : [];

  const rows: string[][] = [];
  /** 每一行在表里的真实行号（从 0 起）。合并单元格按行号对位；没有 r 属性的按顺序数 */
  const 行号们: number[] = [];
  const 行re = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = 行re.exec(sheet))) {
    if (rows.length > 行数上限 + 1) break;
    const 行号 = Number(/\br="(\d+)"/.exec(rm[1] ?? "")?.[1] ?? 0) - 1;
    行号们.push(行号 >= 0 ? 行号 : (行号们.at(-1) ?? -1) + 1);
    const 行 = rm[2] ?? "";
    const cells: string[] = [];
    /*
      属性那段必须是非贪婪：Excel / WPS 把「带边框、底色但没填」的空格子写成自闭合的 <c r="C2" s="1"/>，
      贪婪的 [^>]* 会把 `/` 吃进去，接着一路匹配到下一格的 </c>——下一格被吞掉，还可能写成共享字符串的下标数字
      （公司变成「6」）。名单整片加边框很常见（2026-10-02 排查）
    */
    const 格re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = 格re.exec(行))) {
      const attrs = cm[1] ?? "";
      const body = cm[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      // 不计算公式；未缓存的结果不是用户留空，必须先修好文件，避免悄悄丢列或误报缺号码。
      const cache = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (/<f\b/.test(body) && (!cache || (!cache[1].trim() && t !== "str"))) {
        throw new 读不出来(`单元格 ${ref ?? `第 ${行号们.at(-1)! + 1} 行`} 的公式没有缓存结果。请在 Excel/WPS 重新计算并保存，或复制后粘贴为值再导入。`);
      }
      let v = "";
      if (t === "s") {
        // 共享字符串：<v> 里是下标
        const i = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        v = 共享[i] ?? "";
      } else if (t === "inlineStr") {
        v = 取文字(body);
      } else {
        // 数字、布尔、日期序列号、公式的缓存值都在 <v> 里，原样当字符串交出去
        v = 解转义(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        // 1904 的簿子：日期格式的数字换回 1900 系统的序列号（见文件头）
        if (是1904 && (!t || t === "n") && v.trim() !== "" && Number.isFinite(Number(v))) {
          const 样式 = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
          if (日期样式[样式]) v = String(Number(v) + 差1904);
        }
      }
      // 空格子在 XML 里是直接不出现的，按 r 属性补位，否则整行会往左错位
      const at = ref ? 列号(ref) : cells.length;
      while (cells.length < at) cells.push("");
      if (cells.length > 列数上限 + 5) break;
      cells[at] = v;
    }
    rows.push(cells);
  }

  /*
    合并单元格：只有左上那一格存着值，其余格子在 XML 里是空的。几行同一家公司竖着合并很常见，
    原来只有第一个人拿到公司，其余人是空的、没有任何提示（第二轮 r2-data）。把左上的值填满整个合并区
  */
  const 位置 = new Map(行号们.map((n, i) => [n, i]));
  const 合并re = /<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = 合并re.exec(sheet))) {
    const [c0, r0] = [列号(mm[1]), Number(/\d+/.exec(mm[1])![0]) - 1];
    const r1 = Number(/\d+/.exec(mm[2])![0]) - 1;
    const 源行 = 位置.get(r0);
    const 值 = 源行 === undefined ? "" : rows[源行][c0] ?? "";
    /*
      **只往下填，不往右填**（第三轮 B1）：横着合并的多半是大标题（A1:D1「2026 年 9 月客户名单」），
      往右填满后标题行有 4 格，被认成表头；竖着合并的才是「几个人同一家公司」。往下填只填左边那一列
    */
    if (!值 || r1 === r0) continue;
    for (let r = r0 + 1; r <= r1 && r - r0 < 行数上限; r++) {
      const i = 位置.get(r);
      if (i === undefined) continue;
      while (rows[i].length <= c0) rows[i].push("");
      if (!rows[i][c0]) rows[i][c0] = 值;
    }
  }
  // 全空的行丢掉，和 CSV 那条路一致
  const 留 = rows.flatMap((r, i) => (r.some((x) => x.trim() !== "") ? [i] : []));
  return { rows: 留.map((i) => rows[i]), 行号: 留.map((i) => 行号们[i] + 1) };
}
