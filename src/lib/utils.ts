import dayjs from "dayjs";
import { palette, avatarBg } from "./palette";
import relativeTime from "dayjs/plugin/relativeTime";
import isToday from "dayjs/plugin/isToday";
import isTomorrow from "dayjs/plugin/isTomorrow";
import "dayjs/locale/zh-cn";
import { isCalendarDate } from "./schedule-date";

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

/**
 * 冷热：这位客户多久没跟了，折成四格。单人销售手里最稀缺的是注意力，
 * 「今天该碰谁」要一眼看出来，而不是在一列日期里挨个换算。
 *   两天内 4 格 · 一周内 3 · 两周内 2 · 一个月内 1 · 更久或从没跟过 0
 * 按**本地日历天**数，和 smartTime 同一个口径：昨晚跟的，今天早上还是「1 天」。
 */
export function 冷热(最近跟进: Date | string | null | undefined, now = dayjs()): { 格: 0 | 1 | 2 | 3 | 4; 天: number | null } {
  if (!最近跟进 || !dayjs(最近跟进).isValid() || dayjs(最近跟进).valueOf() > now.valueOf() + 60_000) return { 格: 0, 天: null };
  const 天 = Math.max(0, now.startOf("day").diff(dayjs(最近跟进).startOf("day"), "day"));
  const 格 = 天 <= 2 ? 4 : 天 <= 6 ? 3 : 天 <= 13 ? 2 : 天 <= 29 ? 1 : 0;
  return { 格, 天 };
}

export function fmtDate(d: Date | string | null | undefined): string {
  return d ? dayjs(d).format("YYYY-MM-DD") : "—";
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  return d ? dayjs(d).format(typeof d === "string" && isCalendarDate(d) ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm") : "—";
}

/** 写给 AI 的「现在」：2026-09-28 14:05（周一）。带上周几，它推「周三」「下周五」才有依据 */
export function 现在带周几(t = dayjs()): string {
  return `${t.format("YYYY-MM-DD HH:mm")}（周${"日一二三四五六"[t.day()]}）`;
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
  if (p.length >= 11) return `${p.slice(0, 3)}****${p.slice(-4)}`;
  /*
    短号也要打（2026-10-04，回归核对 H-033）：原来不足 11 位原样返回——8 位座机、香港 8 位号、短的海外号
    在共享试用区里谁都看得见，截图录屏就外泄。7–10 位留头两位尾两位，再短的只给星号。
    表单把打码样子交回来时靠 maskPhone(原) === 交回 认回原号（lib/phone.ts），格式变了那边照样对得上
  */
  if (p.length >= 7) return `${p.slice(0, 2)}****${p.slice(-2)}`;
  return "****";
}

/**
 * 留痕里出现的电话号码都打码（共享试用区的操作日志用，2026-10-01 排查 A5；第五轮 B3 重写）。
 * 留痕的一句话和明细（JSON 字符串）里记的是原号；共享区里谁都翻得到，号码得在出库时就打掉。
 *
 * 两层：
 *   - 明细能解成 JSON：「电话 / 手机」那一格（{字段: "电话", 原值, 新值}，或者键名就是 phone）整串打码，
 *     不看长什么样——库里存的是规整后的号，本地 8 位座机、香港号、400 都是合法电话，光看形状认不全。
 *     数字类型的值（金额）不碰，JSON 打完照样解得开
 *   - 其余文字（摘要、跟进内容、备注）：全角数字先转半角；带分隔符、连起来 7 位以上的数字就打码（日期除外）；
 *     不带分隔符的只认手机号、0 开头的座机、400/800、+ 开头的号——纯数字的金额和编号不误伤
 */
const 全角数字 = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const 号码样 = /^(?:\+?86)?1[3-9]\d{9}$|^0\d{9,11}$|^[48]00\d{7}$/;
const 日期样 = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/;
// WhatsApp 也是号码（2026-10-05 外贸档案）：日志里「字段：WhatsApp」那一格照电话打码
const 电话格名 = /电话|手机|号码|phone|mobile|tel|whatsapp/i;

function 打这一串(串: string): string {
  const 数字 = 串.replace(/\D/g, "").replace(/^86(?=1[3-9]\d{9}$)/, "");
  if (数字.length < 6) return 串;
  return `${数字.slice(0, 3)}****${数字.slice(-4)}`;
}

function 文本里打码(s: string): string {
  return 全角数字(s).replace(/\+?\(?\d[\d\s\-.()（）]*\d/g, (m) => {
    const 数字 = m.replace(/\D/g, "");
    const 有分隔 = /[\s\-.()（）]/.test(m.replace(/^\+/, ""));
    if (日期样.test(m)) return m;
    if (有分隔 ? 数字.length >= 7 : m.startsWith("+") ? 数字.length >= 8 : 号码样.test(数字)) return 打这一串(m);
    return m;
  });
}

function 走一遍(v: unknown, 是电话: boolean): unknown {
  if (typeof v === "string") return 是电话 ? (/\d/.test(v) ? 打这一串(全角数字(v)) : v) : 文本里打码(v);
  if (Array.isArray(v)) return v.map((x) => 走一遍(x, 是电话));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // describeCustomerChanges 的样子：{字段: "电话", 原值, 新值}
    const 这格是电话 = typeof o["字段"] === "string" && 电话格名.test(o["字段"] as string);
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) => [k, 走一遍(x, 是电话 || 电话格名.test(k) || (这格是电话 && (k === "原值" || k === "新值")))]),
    );
  }
  return v;
}

export function 文字里号码打码(s: string): string {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(走一遍(JSON.parse(s), false));
    } catch {
      // 不是 JSON，按文字打
    }
  }
  return 文本里打码(s);
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
