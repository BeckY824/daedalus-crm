import nativeDayjs from "dayjs";
import utc from "dayjs/plugin/utc";

nativeDayjs.extend(utc);
const offsetMinutes = 480;
const offsetMs = offsetMinutes * 60_000;
const businessMarker = Symbol("beijing-business-clock");
type Internal = { $x: Record<PropertyKey, unknown> };
const isBusiness = (value: nativeDayjs.Dayjs) => Boolean((value as unknown as Internal).$x?.[businessMarker]);

/**
 * 北京业务钟使用固定UTC+8。以UTC日历字段运算，避免Dayjs时区对象的startOf/add/set
 * 经过异地宿主Date时受当地DST影响。仅标记业务实例；本机实例保持原生行为。
 * 对外的valueOf/toDate/ISO仍代表真实瞬间，日期选择器与其他Dayjs插件继续使用正常实例。
 */
nativeDayjs.extend((_options, Dayjs) => {
  const valueOf = Dayjs.prototype.valueOf;
  Dayjs.prototype.valueOf = function () { return valueOf.call(this) - (isBusiness(this) ? offsetMs : 0); };
  const toDate = Dayjs.prototype.toDate;
  Dayjs.prototype.toDate = function (mode?: string) {
    // Dayjs核心startOf用toDate("s")做日历字段设置；该内部副本必须保留UTC墙钟字段。
    return isBusiness(this) && mode === "s" ? new Date(valueOf.call(this)) : toDate.call(this);
  };
  const format = Dayjs.prototype.format;
  Dayjs.prototype.format = function (template) { return format.call(this, isBusiness(this) ? template ?? "YYYY-MM-DDTHH:mm:ssZ" : template); };
  const utcOffset = Dayjs.prototype.utcOffset;
  Dayjs.prototype.utcOffset = function (this: nativeDayjs.Dayjs, input?: number | string, keepLocalTime?: boolean) {
    if (!isBusiness(this)) return utcOffset.call(this, input as number, keepLocalTime);
    if (input === undefined) return offsetMinutes;
    // 显式离开业务钟时回到标准Dayjs对象，标记不泄漏到其他时区。
    const value = keepLocalTime ? nativeDayjs.utc(this.format("YYYY-MM-DDTHH:mm:ss.SSS")) : nativeDayjs(this.toDate());
    return value.utcOffset(input, keepLocalTime);
  } as typeof Dayjs.prototype.utcOffset;
  const comparisons = Dayjs.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const key of ["isSame", "isBefore", "isAfter", "diff"]) {
    const original = comparisons[key];
    comparisons[key] = function (this: nativeDayjs.Dayjs, date: unknown, ...args: unknown[]) {
      return original.call(this, isBusiness(this) ? businessDayjs(date as nativeDayjs.ConfigType) : date, ...args);
    };
  }
  const isUTC = Dayjs.prototype.isUTC;
  Dayjs.prototype.isUTC = function () { return !isBusiness(this) && isUTC.call(this); };
});
let browserTimeZone: "Asia/Shanghai" | null = null;

/**
 * 服务端不接受浏览器全局状态；托管、企业版业务日为北京时间，本地桌面和开源自部署为本机。
 * 企业版（CRM_ENTERPRISE=1，2026-10-25 F3）：公司在国内、夜扫和到期按北京日界线，
 * 人在伦敦打开网页也按北京显示和划「今天」；不跟着容器 TZ 走，TZ 设错了也不漂。
 */
export function businessTimeZone(): "Asia/Shanghai" | null {
  return typeof window === "undefined" && typeof process !== "undefined" && process.versions?.node
    ? process.env.MULTI_TENANT === "1" || process.env.CRM_ENTERPRISE === "1" ? "Asia/Shanghai" : null : browserTimeZone;
}
export function configureBrowserBusinessTimeZone(zone: "Asia/Shanghai" | null): void {
  // Worker没有window/process，同样使用调用页面显式传入的业务钟。
  if (typeof window !== "undefined" || typeof process === "undefined" || !process.versions?.node) browserTimeZone = zone;
}

export const businessDayjs = Object.assign((...args: Parameters<typeof nativeDayjs>) => {
  const parsed = nativeDayjs(...args);
  if (!businessTimeZone() || !parsed.isValid()) return parsed;
  const value = args[0];
  const clock = typeof value === "string" ? /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?))?$/.exec(value) : null;
  const wall = clock
    ? new Date(`${clock[1]}-${clock[2].padStart(2, "0")}-${clock[3].padStart(2, "0")}T${clock[4] ?? "00:00:00"}Z`)
    : new Date(parsed.valueOf() + offsetMs);
  const result = nativeDayjs.utc(wall).locale(parsed.locale());
  (result as unknown as Internal).$x[businessMarker] = true;
  return result;
}, nativeDayjs) as typeof nativeDayjs;

/**
 * 等于 businessDayjs(value).valueOf()，最常见的两种串不建 Dayjs：带 Z 的 ISO 瞬间、YYYY-MM-DD 日历日
 * （计划页一次分几千条，2026-10-25 企业版压测：逐条 businessDayjs 占了服务端忙时 CPU 近两成）。
 * 别的格式照旧走 businessDayjs。tests/business-value-of.test.ts 拿 businessDayjs 对拍。
 */
export function businessValueOf(value: string): number {
  // Dayjs 遇到 Z 结尾的串直接 new Date(串)；业务钟只把墙钟挪 8 小时、valueOf 再减回来，瞬间不变
  if (/Z$/i.test(value)) return Date.parse(value);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!day) return businessDayjs(value).valueOf();
  // 业务钟：和 businessDayjs 拼同一个 UTC 串再减 8 小时 = 北京零点；本机钟：和 Dayjs 解析同一个写法 = 本机零点
  return businessTimeZone() ? Date.parse(`${value}T00:00:00Z`) - offsetMs : new Date(+day[1], +day[2] - 1, +day[3], 0, 0, 0, 0).getTime();
}
