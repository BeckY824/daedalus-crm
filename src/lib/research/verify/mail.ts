/**
 * 「粘贴询盘邮件」（背调补充方案第二期，2026-10-18）：从邮件原文（带邮件头）里认出
 *   - 发件 IP：`Received:` 链里时间最早的那一跳外部 IP（或者 X-Originating-IP）
 *   - SPF / DKIM / DMARC：收件这边的邮件服务写在 Authentication-Results 里的结论
 *   - From / Reply-To：回复地址是不是被换成了另一个邮箱（骗子常这么干）
 *   - 正文签名里的电话、税号
 *
 * **原文只在桌面端本地解析，不上传**（10-18 总控）：这个文件是纯函数，在浏览器里跑；
 * 交给背调的只有下面的 邮件信号（几个地址、一个 IP、几个结论），原文不进请求、不进库。
 *
 * 认不出就是没有，不猜。Gmail / Outlook 网页版、用谷歌 / 微软邮箱的企业发的信，邮件头里只有它们服务器的 IP，
 * 看不到对方自己的——这时候 经手 写上是谁家的服务，IP 那一项标「看不到、不扣分」（rules 里拼那一句）。
 */
import { 主域名, 是免费邮箱 } from "./domain";
import { 认线索 } from "./clues";

/** 发件 IP 的国家用 DB-IP 的离线库（ip-country.ts），授权要求署名 */
export const IP库署名 = { title: "IP 国家：DB-IP（CC BY 4.0）", url: "https://db-ip.com" };

export type 认证结论 = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";

export type 邮件信号 = {
  /** From 里的邮箱（小写） */
  发件人?: string;
  /** Reply-To 里的邮箱，和 From 不一样时才写 */
  回复到?: string;
  /** 认出的对方 IP（公网地址） */
  发件IP?: string;
  /** IP 是从哪认的 */
  IP来源?: "最早一跳" | "X-Originating-IP";
  /** 最早一跳是大邮件服务的服务器（谷歌、微软……）：看不到对方自己的 IP */
  经手?: string;
  spf?: 认证结论;
  dkim?: 认证结论;
  dmarc?: 认证结论;
  /** X-Mailer / User-Agent：Foxmail、Outlook 客户端之类 */
  客户端?: string;
  /** 正文（引用的历史邮件之前）里的电话、税号 */
  电话: string[];
  税号?: string;
  /** Received 一共几跳（排查用） */
  跳数: number;
};

/** 像不像一封邮件原文：要有 Received:、From:，再加一个 Subject / Date / Message-ID / To */
export function 像邮件原文(text: string): boolean {
  const 头 = 头部(text);
  return /^received:/im.test(头) && /^from:/im.test(头) && /^(subject|date|message-id|to):/im.test(头);
}

/** 头和正文之间是第一个空行。粘的时候前面可能多了几行空白，先去掉 */
function 头部(text: string): string {
  const t = text.replace(/^\s+/, "");
  const i = t.search(/\r?\n[ \t]*\r?\n/);
  return i >= 0 ? t.slice(0, i) : t;
}

/** 折行的头接回一行（续行以空白开头），返回 [小写名, 值]，按原文顺序（最上面是最后加的） */
export function 头列表(text: string): [string, string][] {
  const 出: [string, string][] = [];
  for (const l of 头部(text).split(/\r?\n/)) {
    if (/^[ \t]/.test(l) && 出.length) 出[出.length - 1][1] += " " + l.trim();
    else {
      const m = /^([!-9;-~]+):\s*(.*)$/.exec(l);
      if (m) 出.push([m[1].toLowerCase(), m[2]]);
    }
  }
  return 出;
}

const 邮箱式 = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const 取邮箱 = (v: string | undefined) => (v ? (邮箱式.exec(v.replace(/=\?[^?]+\?[bq]\?[^?]*\?=/gi, " "))?.[0].toLowerCase() ?? undefined) : undefined);

/** 内网、回环、运营商级 NAT、链路本地、测试网段：这些不是对方的公网地址 */
export function 是公网IP(ip: string): boolean {
  if (ip.includes(":")) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("2001:db8")) return false;
    const 映射 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    return 映射 ? 是公网IP(映射[1]) : /^[23]/.test(x);
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0)
  );
}

/** 大邮件服务：最早一跳是它们的服务器，就看不到对方自己的 IP */
const 大服务: [RegExp, string][] = [
  [/(^|\.)(google|googlemail|gmail)\.com$/i, "谷歌（Gmail / Google Workspace）"],
  [/(^|\.)(outlook|hotmail|live|office365)\.com$|(^|\.)protection\.outlook\.com$|(^|\.)outbound\.protection\.outlook\.com$/i, "微软（Outlook / Microsoft 365）"],
  [/(^|\.)(yahoo|yahoodns)\.(com|net)$/i, "雅虎邮箱"],
  [/(^|\.)(icloud|me|apple)\.com$/i, "苹果 iCloud 邮箱"],
  [/(^|\.)(qq|foxmail)\.com$|(^|\.)exmail\.qq\.com$/i, "QQ 邮箱 / 腾讯企业邮"],
  [/(^|\.)(163|126|yeah)\.(com|net)$|(^|\.)netease\.com$/i, "网易邮箱"],
  [/(^|\.)(aliyun|alibaba|aliyun-inc)\.com$|(^|\.)mxhichina\.com$/i, "阿里邮箱"],
  [/(^|\.)zoho\.(com|eu|in)$|(^|\.)zohomail\.com$/i, "Zoho 邮箱"],
  [/(^|\.)(yandex)\.(net|ru|com)$/i, "Yandex 邮箱"],
  [/(^|\.)mail\.ru$/i, "Mail.ru"],
  [/(^|\.)(gmx|web)\.(net|de|com)$/i, "GMX / WEB.DE"],
  [/(^|\.)(amazonses|sendgrid|mailgun|mailchimp|mcsv|sparkpostmail|mandrillapp)\.(com|net|org)$/i, "群发邮件服务"],
];
export const 谁家服务 = (host: string | undefined) => (host ? 大服务.find(([re]) => re.test(host.replace(/\.$/, "")))?.[1] : undefined);

type 跳 = { 主机?: string; 反解?: string; ip?: string };

/** 一条 Received 的 from 那一段：`from HELO (反解 [IP])` / `from HELO ([IP])` / `from HELO (IP)` */
export function 认一跳(v: string): 跳 | null {
  const m = /^\s*from\s+(\S+)(?:\s+\(([^)]*)\))?/i.exec(v);
  if (!m) return null;
  const 括号 = m[2] ?? "";
  const 方 = /\[(?:IPv6:)?([0-9a-fA-F:.]+)\]/.exec(括号) ?? /\[(?:IPv6:)?([0-9a-fA-F:.]+)\]/.exec(m[1]);
  const 裸 = /(?:^|[\s(])(\d{1,3}(?:\.\d{1,3}){3})(?=[\s)\]]|$)/.exec(括号);
  const ip = (方?.[1] ?? 裸?.[1])?.replace(/^::ffff:/i, "");
  const 反解 = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\.?\s/i.exec(括号 + " ")?.[1];
  return { 主机: m[1].replace(/^\[|\]$/g, ""), 反解: 反解 && !/^\d+(\.\d+){3}$/.test(反解) ? 反解 : undefined, ip };
}

const 认结论 = (v: string, k: "spf" | "dkim" | "dmarc"): 认证结论 | undefined =>
  (new RegExp(`\\b${k}=(pass|fail|softfail|neutral|none|temperror|permerror|policy)\\b`, "i").exec(v)?.[1].toLowerCase() as 认证结论 | undefined) ?? undefined;

/** 正文：只看引用的历史邮件之前那一段（不然会把用户自己签名里的电话也认进来）；base64 块跳过 */
export function 正文首段(text: string): string {
  const t = text.replace(/^\s+/, "");
  const i = t.search(/\r?\n[ \t]*\r?\n/);
  let 体 = i >= 0 ? t.slice(i) : "";
  体 = 体.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  体 = 体.split(/\r?\n/).filter((l) => !/^[A-Za-z0-9+/=]{60,}$/.test(l.trim()) && !/^content-[\w-]+:/i.test(l) && !/^--[\w=.-]{8,}/.test(l)).join("\n");
  const 截 = 体.search(/^(>|-{2,}\s*(original message|原始邮件|forwarded message)|On .{6,120} wrote:|在 .{4,80}写道[:：]|(发件人|From)[:：]\s)/im);
  return (截 >= 0 ? 体.slice(0, 截) : 体).slice(0, 20_000);
}

export function 解析邮件(text: string): 邮件信号 {
  const 头 = 头列表(text);
  const 取 = (n: string) => 头.find(([k]) => k === n)?.[1];
  const 发件人 = 取邮箱(取("from"));
  const 回 = 取邮箱(取("reply-to"));
  // Received 最上面一条是最后一跳（收件服务器加的），最下面一条最早
  const 跳们 = 头.filter(([k]) => k === "received").map(([, v]) => 认一跳(v)).filter((x): x is 跳 => Boolean(x)).reverse();
  const 外 = 跳们.find((x) => x.ip && 是公网IP(x.ip));
  const 原始IP = /\[?([0-9a-fA-F:.]+)\]?/.exec(取("x-originating-ip") ?? "")?.[1];
  const 出: 邮件信号 = { 电话: [], 跳数: 跳们.length };
  if (发件人) 出.发件人 = 发件人;
  if (回 && 回 !== 发件人) 出.回复到 = 回;
  if (原始IP && 是公网IP(原始IP)) {
    出.发件IP = 原始IP;
    出.IP来源 = "X-Originating-IP";
  } else if (外) {
    const 家 = 谁家服务(外.反解) ?? 谁家服务(外.主机);
    if (家) 出.经手 = 家;
    else {
      出.发件IP = 外.ip;
      出.IP来源 = "最早一跳";
    }
  } else {
    // 一个公网 IP 都没有（Gmail 网页版最早那一跳只有谷歌内部地址）：看 by 那一段是谁家的
    const by = 头.filter(([k]) => k === "received").map(([, v]) => /\bby\s+(\S+)/i.exec(v)?.[1]).reverse().find(Boolean);
    const 家 = 谁家服务(by);
    if (家) 出.经手 = 家;
  }
  // 收件这边加的 Authentication-Results 在最上面；有好几条时取第一条（越往下越可能是对方自己写的）
  const 认 = 取("authentication-results") ?? 取("arc-authentication-results");
  if (认) {
    for (const k of ["spf", "dkim", "dmarc"] as const) {
      const v = 认结论(认, k);
      if (v) 出[k] = v;
    }
  }
  if (!出.spf) {
    const s = /^\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/i.exec(取("received-spf") ?? "")?.[1];
    if (s) 出.spf = s.toLowerCase() as 认证结论;
  }
  const 端 = (取("x-mailer") ?? 取("user-agent"))?.trim();
  if (端) 出.客户端 = 端.slice(0, 60);
  const 线 = 认线索(正文首段(text));
  出.电话 = 线.电话;
  if (线.税号) 出.税号 = 线.税号;
  return 出;
}

/** 回复地址换了：和 From 不是同一个主域名（同公司换个邮箱不算） */
export function 换了回复地址(x: Pick<邮件信号, "发件人" | "回复到">): boolean {
  if (!x.发件人 || !x.回复到) return false;
  const a = 主域名(x.发件人.split("@")[1]);
  const b = 主域名(x.回复到.split("@")[1]);
  if (!a || !b || a !== b) return true;
  // 同一个免费邮箱后缀（都是 gmail.com）但不是同一个人
  return 是免费邮箱(x.发件人) && x.发件人 !== x.回复到;
}

/** 浏览器发来的 邮件信号 原样不信：只留认得的字段、长度和格式都卡住（stream.ts 收的时候用） */
export function 收邮件信号(v: unknown): 邮件信号 | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const 串 = (x: unknown, n: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : undefined);
  const 邮 = (x: unknown) => {
    const s = 串(x, 254)?.toLowerCase();
    return s && new RegExp(`^${邮箱式.source}$`).test(s) ? s : undefined;
  };
  const 结论们 = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"];
  const 结 = (x: unknown) => (typeof x === "string" && 结论们.includes(x) ? (x as 认证结论) : undefined);
  const ip = 串(o.发件IP, 45);
  const 出: 邮件信号 = {
    电话: Array.isArray(o.电话) ? o.电话.map((x) => 串(x, 30)).filter((x): x is string => Boolean(x) && /^\+[\d\s().-]{6,28}$/.test(x!)).slice(0, 3) : [],
    跳数: typeof o.跳数 === "number" && Number.isFinite(o.跳数) ? Math.max(0, Math.min(99, Math.round(o.跳数))) : 0,
  };
  const 发 = 邮(o.发件人);
  const 回 = 邮(o.回复到);
  if (发) 出.发件人 = 发;
  if (回 && 回 !== 发) 出.回复到 = 回;
  if (ip && /^[0-9a-fA-F:.]+$/.test(ip) && 是公网IP(ip)) {
    出.发件IP = ip;
    出.IP来源 = o.IP来源 === "X-Originating-IP" ? "X-Originating-IP" : "最早一跳";
  }
  const 经手 = 串(o.经手, 40);
  if (经手 && 大服务.some(([, n]) => n === 经手)) 出.经手 = 经手;
  for (const k of ["spf", "dkim", "dmarc"] as const) {
    const r = 结(o[k]);
    if (r) 出[k] = r;
  }
  const 端 = 串(o.客户端, 60);
  if (端) 出.客户端 = 端;
  const 税 = 串(o.税号, 20);
  if (税 && /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(税)) 出.税号 = 税;
  return 出.发件人 || 出.发件IP || 出.经手 ? 出 : undefined;
}
