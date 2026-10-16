/**
 * 对方当地时间（2026-10-16 外贸基础，总控：「客户详情和列表按国家显示『对方当地 14:05』，多时区国家取首都。不做首页时钟墙」）。
 *
 * 国家 → 一个时区。只认 lib/customer-extra.ts 国家候选 里的叫法（导入时 认国家() 已经把 USA / UAE 这类写法统一过）；
 * 人手填的、表里没有的国家不显示——宁可不说，也不说错。
 * 一个国家跨好几个时区的（美国、俄罗斯、巴西、澳大利亚、加拿大、墨西哥、印尼……）取首都那一个，
 * 时区名写 IANA 的代表城市（华盛顿用 America/New_York，堪培拉用 Australia/Sydney，巴西利亚用 America/Sao_Paulo）。
 * 夏令时交给 Intl 算，不自己维护偏移。
 */
import { 认国家 } from "./customer-extra";

export const 国家时区: Record<string, string> = {
  // 北美 / 欧洲
  美国: "America/New_York", 加拿大: "America/Toronto", 英国: "Europe/London", 德国: "Europe/Berlin", 法国: "Europe/Paris",
  意大利: "Europe/Rome", 西班牙: "Europe/Madrid", 荷兰: "Europe/Amsterdam", 比利时: "Europe/Brussels", 波兰: "Europe/Warsaw",
  瑞典: "Europe/Stockholm", 瑞士: "Europe/Zurich", 奥地利: "Europe/Vienna", 爱尔兰: "Europe/Dublin", 葡萄牙: "Europe/Lisbon",
  希腊: "Europe/Athens", 捷克: "Europe/Prague", 罗马尼亚: "Europe/Bucharest", 匈牙利: "Europe/Budapest", 丹麦: "Europe/Copenhagen",
  挪威: "Europe/Oslo", 芬兰: "Europe/Helsinki", 乌克兰: "Europe/Kyiv", 俄罗斯: "Europe/Moscow",
  // 中东 / 中亚
  阿联酋: "Asia/Dubai", 沙特阿拉伯: "Asia/Riyadh", 卡塔尔: "Asia/Qatar", 科威特: "Asia/Kuwait", 阿曼: "Asia/Muscat",
  巴林: "Asia/Bahrain", 以色列: "Asia/Jerusalem", 约旦: "Asia/Amman", 伊拉克: "Asia/Baghdad", 伊朗: "Asia/Tehran",
  土耳其: "Europe/Istanbul", 埃及: "Africa/Cairo", 乌兹别克斯坦: "Asia/Tashkent", 哈萨克斯坦: "Asia/Almaty", 吉尔吉斯斯坦: "Asia/Bishkek",
  塔吉克斯坦: "Asia/Dushanbe", 土库曼斯坦: "Asia/Ashgabat", 格鲁吉亚: "Asia/Tbilisi", 阿塞拜疆: "Asia/Baku", 亚美尼亚: "Asia/Yerevan",
  阿富汗: "Asia/Kabul", 巴基斯坦: "Asia/Karachi",
  // 亚太
  日本: "Asia/Tokyo", 韩国: "Asia/Seoul", 印度: "Asia/Kolkata", 越南: "Asia/Ho_Chi_Minh", 泰国: "Asia/Bangkok",
  马来西亚: "Asia/Kuala_Lumpur", 新加坡: "Asia/Singapore", 印度尼西亚: "Asia/Jakarta", 菲律宾: "Asia/Manila", 缅甸: "Asia/Yangon",
  柬埔寨: "Asia/Phnom_Penh", 孟加拉国: "Asia/Dhaka", 斯里兰卡: "Asia/Colombo", 尼泊尔: "Asia/Kathmandu", 蒙古: "Asia/Ulaanbaatar",
  澳大利亚: "Australia/Sydney", 新西兰: "Pacific/Auckland", 中国香港: "Asia/Hong_Kong", 中国台湾: "Asia/Taipei", 中国澳门: "Asia/Macau",
  中国: "Asia/Shanghai",
  // 拉美
  墨西哥: "America/Mexico_City", 巴西: "America/Sao_Paulo", 阿根廷: "America/Argentina/Buenos_Aires", 智利: "America/Santiago",
  秘鲁: "America/Lima", 哥伦比亚: "America/Bogota", 厄瓜多尔: "America/Guayaquil", 委内瑞拉: "America/Caracas", 巴拿马: "America/Panama",
  哥斯达黎加: "America/Costa_Rica", 多米尼加: "America/Santo_Domingo", 乌拉圭: "America/Montevideo", 巴拉圭: "America/Asuncion",
  玻利维亚: "America/La_Paz",
  // 非洲
  南非: "Africa/Johannesburg", 尼日利亚: "Africa/Lagos", 肯尼亚: "Africa/Nairobi", 埃塞俄比亚: "Africa/Addis_Ababa", 加纳: "Africa/Accra",
  坦桑尼亚: "Africa/Dar_es_Salaam", 摩洛哥: "Africa/Casablanca", 阿尔及利亚: "Africa/Algiers", 突尼斯: "Africa/Tunis", 利比亚: "Africa/Tripoli",
  安哥拉: "Africa/Luanda", 乌干达: "Africa/Kampala", 科特迪瓦: "Africa/Abidjan", 塞内加尔: "Africa/Dakar", 喀麦隆: "Africa/Douala",
  "刚果（金）": "Africa/Kinshasa", 苏丹: "Africa/Khartoum",
};

/** 老一点的 ICU 只认旧名（基辅 2022 年才改名）：新名不认时退到旧名 */
const 旧名: Record<string, string> = { "Europe/Kyiv": "Europe/Kiev" };

const 格式器 = new Map<string, Intl.DateTimeFormat | null>();
function 格式(时区: string): Intl.DateTimeFormat | null {
  if (!格式器.has(时区)) {
    let f: Intl.DateTimeFormat | null = null;
    for (const tz of [时区, 旧名[时区]].filter(Boolean)) {
      try {
        f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        break;
      } catch {
        /* 这台机器的 ICU 不认这个名字 */
      }
    }
    格式器.set(时区, f);
  }
  return 格式器.get(时区)!;
}

/** 某个时区此刻的「年月日」「时:分」 */
function 拆(f: Intl.DateTimeFormat, 现在: Date): { 日: string; 时分: string; 时: number } {
  const p = Object.fromEntries(f.formatToParts(现在).map((x) => [x.type, x.value]));
  return { 日: `${p.year}-${p.month}-${p.day}`, 时分: `${p.hour}:${p.minute}`, 时: Number(p.hour) };
}

export type 当地时间 = {
  /** 「14:05」 */
  时分: string;
  /** 对方那边已经是第二天 / 还在前一天：「次日」「前一天」；同一天为空 */
  日差: "" | "次日" | "前一天";
  /** 对方此刻是夜里（22 点到早 7 点）：发消息前多想一下 */
  夜里: boolean;
  /** 「对方当地 14:05」「对方当地 次日 02:05」 */
  说法: string;
  时区: string;
};

/**
 * 这个国家此刻几点。认不出国家、或者和本机是同一个钟点（客户也在中国、或时差为零）返回 null——
 * 和自己一样的时间写出来只是噪音。
 * 本机时区可以传进来（测试用）；不传用运行环境的
 */
export function 对方当地(国家: string | null | undefined, 现在: Date = new Date(), 本机时区?: string): 当地时间 | null {
  const 名 = 认国家(国家);
  const 时区 = 名 ? 国家时区[名] : undefined;
  if (!时区) return null;
  const 那边 = 格式(时区);
  if (!那边) return null;
  const 这边 = 本机时区 ? 格式(本机时区) : new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (!这边) return null;
  const a = 拆(那边, 现在);
  const b = 拆(这边, 现在);
  if (a.日 === b.日 && a.时分 === b.时分) return null;
  const 日差 = a.日 === b.日 ? "" : a.日 > b.日 ? "次日" : "前一天";
  return { 时分: a.时分, 日差, 夜里: a.时 >= 22 || a.时 < 7, 说法: `对方当地 ${日差 ? `${日差} ` : ""}${a.时分}`, 时区 };
}
