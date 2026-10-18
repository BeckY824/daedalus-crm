/**
 * 域名的几样本地判断：可注册的那一截（eTLD+1）、免费邮箱、像不像仿冒官网的域名。纯函数，不联网。
 */

/** 常见的两级后缀（不全，够外贸客户用：英、澳、巴西、土耳其、中东……）。不在表里的按一级算 */
const 两级后缀 = new Set(
  (
    "co.uk org.uk ltd.uk plc.uk me.uk ac.uk gov.uk net.uk " +
    "com.au net.au org.au co.nz org.nz net.nz " +
    "com.br net.br com.mx com.ar com.co com.pe com.cl com.ec com.uy com.ve " +
    "com.tr com.sa com.eg com.qa com.kw com.bh com.om com.jo com.lb com.pk co.ae ae.org " +
    "co.za co.ke co.ng com.ng co.tz co.ug com.gh " +
    "co.jp ne.jp or.jp co.kr or.kr com.cn net.cn org.cn com.hk com.tw com.sg com.my co.id co.th com.ph com.vn co.in net.in org.in firm.in " +
    "co.il com.ua com.pl com.ru com.es com.pt com.gr co.at or.at co.hu"
  ).split(" "),
);

export function 主机(input: string): string | undefined {
  let s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes("@")) s = s.split("@").pop()!;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(s) || s.includes("..")) return undefined;
  return s;
}

/** 「www.shop.slv.co.uk」→「slv.co.uk」 */
export function 主域名(input: string): string | undefined {
  const h = 主机(input);
  if (!h) return undefined;
  const 段 = h.split(".");
  if (段.length <= 2) return h;
  const 末二 = 段.slice(-2).join(".");
  return 两级后缀.has(末二) ? 段.slice(-3).join(".") : 末二;
}

/** 主域名去掉后缀的那一截：「slv.co.uk」→「slv」 */
export function 名段(主: string): string {
  const 段 = 主.split(".");
  return 两级后缀.has(段.slice(-2).join(".")) && 段.length >= 3 ? 段[段.length - 3] : 段[0];
}

/** 免费邮箱（小公司用很常见，只标黄）。按主域名比 */
const 免费邮箱 = new Set(
  (
    "gmail.com googlemail.com outlook.com hotmail.com hotmail.co.uk hotmail.fr hotmail.it hotmail.es hotmail.de live.com live.co.uk live.fr msn.com " +
    "yahoo.com yahoo.co.uk yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.com.br ymail.com rocketmail.com aol.com icloud.com me.com mac.com " +
    "gmx.de gmx.net gmx.com gmx.at gmx.ch web.de t-online.de freenet.de mail.de posteo.de " +
    "mail.ru yandex.ru yandex.com bk.ru list.ru inbox.ru rambler.ru " +
    "qq.com 163.com 126.com yeah.net sina.com sina.cn sohu.com foxmail.com aliyun.com 139.com 189.cn " +
    "protonmail.com proton.me pm.me tutanota.com zoho.com zohomail.com mail.com email.com inbox.com gmx.us " +
    "libero.it virgilio.it tiscali.it alice.it orange.fr wanadoo.fr free.fr laposte.net sfr.fr " +
    "btinternet.com sky.com virginmedia.com talktalk.net seznam.cz centrum.cz wp.pl o2.pl interia.pl onet.pl " +
    "rediffmail.com naver.com daum.net hanmail.net yahoo.co.jp"
  ).split(" "),
);

export function 是免费邮箱(邮箱或域名: string): boolean {
  const 主 = 主域名(邮箱或域名);
  return Boolean(主 && (免费邮箱.has(主) || 免费邮箱.has(主机(邮箱或域名) ?? "")));
}

/** 编辑距离（相邻两个字母对调算一步：slv → svl） */
function 编辑距离(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** 0 → o、1 → l 这类骗子爱用的形近字，先换回来再比 */
const 形近 = (s: string) => s.replace(/0/g, "o").replace(/[1|]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");

/**
 * 邮箱域名和官网域名的关系：
 *   同一家    主域名一样
 *   换后缀    名段一样、后缀不一样（slv.co 对 slv.com）——大公司各国一个域名很常见，也是骗子的手法
 *   加了词    官网名段加了个词（slv-lighting.com、slvgroup.net 对 slv.com）
 *   形近      名段差一两个字母、或者 0/o、1/l 互换（s1v.com、slvv.com 对 slv.com）
 *   无关      别的
 */
export type 域名关系 = "同一家" | "换后缀" | "加了词" | "形近" | "无关";

export function 比域名(邮箱域: string, 官网域: string): 域名关系 {
  const a = 主域名(邮箱域);
  const b = 主域名(官网域);
  if (!a || !b) return "无关";
  if (a === b) return "同一家";
  const x = 名段(a);
  const y = 名段(b);
  if (x === y) return "换后缀";
  if (y.length >= 3 && (x.startsWith(`${y}-`) || x.endsWith(`-${y}`) || (x.startsWith(y) && x.length - y.length >= 3) || (x.endsWith(y) && x.length - y.length >= 3)))
    return "加了词";
  if (y.length >= 4 && (形近(x) === 形近(y) || 编辑距离(x, y) <= (y.length >= 8 ? 2 : 1))) return "形近";
  if (y.length === 3 && 形近(x) === 形近(y)) return "形近";
  return "无关";
}
