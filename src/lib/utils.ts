import dayjs from "dayjs";
import { palette, avatarBg } from "./palette";
import relativeTime from "dayjs/plugin/relativeTime";
import isToday from "dayjs/plugin/isToday";
import isTomorrow from "dayjs/plugin/isTomorrow";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.extend(isToday);
dayjs.extend(isTomorrow);
dayjs.locale("zh-cn");

export { dayjs };

/** ¥ 4,860,000 */
export function money(n: number | null | undefined): string {
  if (n == null) return "¥ 0";
  return "¥ " + Math.round(n).toLocaleString("zh-CN");
}

/** 大额缩写：126 万 */
export function moneyShort(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return `${Math.round(n)}`;
}

/** 设计稿里的「今天 10:30 / 昨天 16:20 / 05-20 14:15」 */
/**
 * 「最近一次」这类时间的人话写法。列表页的时间列全走它。
 *
 * 口径要能一眼比较：「3 天前」和「9 月 10 日」放在一列里，谁更久一目了然；
 * 而「09-10 13:19」和「09-09 20:16」得先在脑子里换算一遍。
 * 所以近处用相对（今天 / 昨天 / N 天前），远处用日期，跨年才补年份。
 * 未来的时间（跟进计划）只特写「明天」，再往后按日期——没人会说「3 天后」再倒推是哪天。
 */
export function smartTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = dayjs(d);
  const now = dayjs();
  if (t.isToday()) return `今天 ${t.format("HH:mm")}`;
  if (t.isTomorrow()) return `明天 ${t.format("HH:mm")}`;
  if (t.isSame(now.subtract(1, "day"), "day")) return "昨天";
  const 过去几天 = now.startOf("day").diff(t.startOf("day"), "day");
  if (过去几天 >= 2 && 过去几天 <= 6) return `${过去几天} 天前`;
  return t.isSame(now, "year") ? t.format("M 月 D 日") : t.format("YYYY 年 M 月 D 日");
}

export function fmtDate(d: Date | string | null | undefined): string {
  return d ? dayjs(d).format("YYYY-MM-DD") : "—";
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  return d ? dayjs(d).format("YYYY-MM-DD HH:mm") : "—";
}

/** 秒 -> 00:18:32 */
export function duration(sec: number | null | undefined): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

/** 手机号脱敏：138****2211 */
export function maskPhone(p?: string | null): string {
  if (!p) return "—";
  return p.length >= 11 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
}

/** 环比增长文本用：正数返回 true */
export function growth(cur: number, prev: number): number {
  if (!prev) return cur > 0 ? 100 : 0;
  return Number((((cur - prev) / prev) * 100).toFixed(1));
}

/** 人名头像：中文取末字（姓名去掉姓），英文取首字母 */
export function initial(name: string): string {
  if (!name) return "?";
  return /[一-龥]/.test(name) ? name.slice(-1) : name[0].toUpperCase();
}

const CITY_PREFIX =
  /^(北京|上海|天津|重庆|深圳|广州|杭州|南京|成都|武汉|西安|青岛|合肥|苏州|长沙|厦门|郑州|无锡|佛山|大连|昆明|石家庄|沈阳|福州|东莞|宁波|济南)市?/;
const CORP_SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团|公司|中心|工作室)$/;

/** 公司徽标：去掉地名前缀和"有限公司"等后缀，取字号首字 */
export function companyInitial(name: string): string {
  if (!name) return "?";
  const core = name.replace(CITY_PREFIX, "").replace(CORP_SUFFIX, "").trim();
  const s = core || name;
  return /[一-龥]/.test(s) ? s[0] : s[0].toUpperCase();
}

/** 由姓名稳定生成一个头像底色 */
const AVATAR_COLORS = avatarBg;
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export type 可选成员 = { id: string; name: string; email: string };

/**
 * 把成员列表转成下拉选项。
 *
 * 成员姓名是允许重复的——同名同事在真实团队里很正常，硬拦反而添堵。
 * 但重名之后下拉里会出现两个一模一样的选项，选错了无从察觉，
 * 所以**只给撞名的那几个**带出登录名区分。
 * 不撞名的保持原样：全都带上等于给每个人加噪音。
 */
export function 成员选项(users: 可选成员[]): { value: string; label: string }[] {
  const 同名计数 = new Map<string, number>();
  for (const u of users) 同名计数.set(u.name, (同名计数.get(u.name) ?? 0) + 1);
  return users.map((u) => ({
    value: u.id,
    label: (同名计数.get(u.name) ?? 0) > 1 ? `${u.name}（${u.email}）` : u.name,
  }));
}

/**
 * 这个库里是不是只有一个人（而且这条记录本来就归他）。
 *
 * 只有一个人时，「负责人」这一项不该出现在表单上——桌面端是一人公司、或者
 * 一个销售自己记账，那个下拉里只有他自己，却还是必填的。留空由服务端填
 * （lib/owners.ts 的 唯一负责人）。
 *
 * 编辑一条挂在**别人**名下的旧记录时仍然要问：有人从销售转成管理员、或者
 * 同事被停用之后，库里会留下候选名单之外的负责人，那时候藏起来等于悄悄改归属。
 */
export function 独自一人(users: 可选成员[], 现负责人?: string | null): boolean {
  if (users.length > 1) return false;
  return !现负责人 || users[0]?.id === 现负责人;
}

/** 头像底色都是浅色，字一律深灰；配 avatarColor 用 */
export const AVATAR_TEXT = palette.inkSoft;
