/**
 * 模拟通道：开发、单测、e2e 用。不联网、不花钱、不扣次数。
 *
 * 结果是按公司名套出来的一份固定材料（照原型 /lab/research 那家编的 Lumora）——网址全是 .example，
 * 不对应任何真实企业。材料故意写得「像真的一样有细节」：有官网、有登记、有招聘、有展会、有一条付款讨论，
 * 这样 6 步每一步都有东西可查，评分的每一维都能评出档，界面上每一块都能看到。
 */
import type { 背调通道 } from "./channel";
import type { 搜索结果, 读页结果 } from "./types";
import type { 核验请求, 核验回应 } from "./verify/types";
import { 域名项 } from "./verify/check";
import { 查邮箱, 查电话 } from "./verify/contact";
import { 制裁项 } from "./verify/sanctions";

/** 名字里带「假」/ fake 的走「骗子公司」那一套：新注册的域名、工商库查不到、网上没足迹——e2e 用它看红灯 */
export const 是假公司 = (公司: string) => /假|fake/i.test(公司);

/** 公司名 → 网址里用的那一截：「Lumora Trading GmbH」→「lumora-trading」 */
function 名字段(公司: string): string {
  const s = 公司
    .toLowerCase()
    .replace(/\b(gmbh|ltd|limited|inc|llc|co|corp|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|ag|plc|有限公司|公司)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "company";
}

/** 从查询里认出是在查哪家：查询一般以公司名开头，拿第一个引号里的或者前三个词 */
function 认公司(query: string): string {
  const q = query.match(/[「"“]([^」"”]+)[」"”]/)?.[1] ?? query.split(/\s+/).slice(0, 3).join(" ");
  return q.trim() || "Company";
}

export function 模拟材料(公司: string) {
  const d = 名字段(公司);
  const 官网 = `https://${d}.example`;
  return {
    官网,
    页: {
      [`${官网}/about`]: {
        title: `${公司} — About us`,
        text: `${公司} is an importer and distributor of outdoor and industrial LED lighting based in Hamburg, Germany. Founded in 2009, the company employs around 40 people and supplies electrical wholesalers and installation contractors in Germany, Austria and Switzerland. Contact: sales@${d}.example, +49 40 0000 0000. Range includes the HB-150 high-bay and the SL-60 street light. Head of Purchasing: Jan Beispiel.`,
      },
      [`https://registry.example/${d}`]: {
        title: `Handelsregister 公开摘要：${公司}（示例）`,
        text: `${公司}, Hamburg. Registered 2009. Business purpose: wholesale of lighting products. Managing director listed. No insolvency proceedings on record.`,
      },
      [`https://jobs.example/${d}-category-manager`]: {
        title: `${公司} 招聘：Category Manager Outdoor Lighting`,
        text: `${公司} is hiring a Category Manager for Outdoor Lighting to expand its street-light and high-bay range, sourcing from Asian manufacturers. Posted 3 weeks ago.`,
      },
      [`https://fair.example/light-building-2026/${d}`]: {
        title: `light+building 2026 展商名单：${公司}（示例）`,
        text: `${公司} — Hall 3.1, Stand B42. Product groups: outdoor lighting, industrial lighting.`,
      },
      [`https://forum.example/t/${d}-payment`]: {
        title: `供应商论坛：${公司} 付款讨论（示例）`,
        text: `One supplier reported a 30-day payment delay with ${公司} in 2024; resolved after follow-up. Other replies describe them as a reliable buyer with 60-day terms.`,
      },
    } as Record<string, { title: string; text: string }>,
  };
}

/** 搜过的公司的材料记在这儿，读页时按网址找回来（搜索结果里的网址只可能来自这里） */
const 见过的页 = new Map<string, { title: string; text: string }>();

/** 按查询挑几条：查官网 / 登记的、查招聘展会的、查纠纷的，各给各的，像真的搜索一样有偏重 */
/**
 * 只有人名 + 电话的「找公司」（person.ts）：搜的是号码（加引号）或「"人名" 国家」。
 * 号码里带 0000000（e2e 用 +49 40 0000 0000，和 Lumora 官网上那个一样）→ 一条名录页，上面有这个号码和 Lumora Trading GmbH；
 * 名字是 Anna Beispiel → 一条 LinkedIn 搜索结果；别的号码什么都搜不到（走「只有人」的简版），别的名字照公司那套给（里面没有这个名字）
 */
function 模拟找人(query: string): 搜索结果[] | null {
  const 引 = query.match(/^"([^"]+)"/)?.[1];
  if (!引) return null;
  const 数 = 引.replace(/\D/g, "");
  if (/^[+\d][\d\s().-]{6,}$/.test(引)) {
    if (!数.includes("0000000")) return [];
    return [
      { title: "Lumora Trading GmbH — Kontakt | Großhandel Verzeichnis（示例）", url: "https://directory.example/lumora-trading-gmbh", snippet: `Lumora Trading GmbH, Hamburg. Tel. ${引}. LED-Beleuchtung Import und Großhandel.` },
      { title: "Instagram（示例）", url: "https://www.instagram.com/p/example", snippet: `Call ${引}` },
    ];
  }
  if (/anna beispiel/i.test(引)) return [{ title: "Anna Beispiel - Einkauf - Lumora Trading GmbH | LinkedIn", url: "https://www.linkedin.com/in/anna-beispiel-example", snippet: "Purchasing at Lumora Trading GmbH. Hamburg." }];
  return null;
}

export function 模拟搜索(query: string): 搜索结果[] {
  const 人 = 模拟找人(query);
  if (人) return 人;
  const 公司 = 认公司(query);
  // LinkedIn / Facebook 定向搜索（verify/social.ts 社媒查询）：给几条像样的搜索结果。链接是编的（带 -example），不对应真实主页
  if (/site:(linkedin|facebook)\.com/i.test(query)) {
    if (是假公司(公司)) return [];
    const d = 名字段(公司);
    return /linkedin/i.test(query)
      ? [
          { title: `${公司} | LinkedIn`, url: `https://www.linkedin.com/company/${d}-example`, snippet: `${公司} | 41 followers on LinkedIn. Importer and distributor of LED lighting.` },
          { title: `Anna Beispiel - Einkauf - ${公司} | LinkedIn`, url: `https://www.linkedin.com/in/anna-beispiel-example`, snippet: `Purchasing at ${公司}. Hamburg.` },
        ]
      : [{ title: `${公司} | Facebook`, url: `https://www.facebook.com/${d}-example`, snippet: `${公司}. 120 likes. Lighting wholesaler.` }];
  }
  const m = 模拟材料(公司);
  for (const [url, p] of Object.entries(m.页)) 见过的页.set(url, p);
  const 全部 = Object.entries(m.页).map(([url, p]) => ({ title: p.title, url, snippet: p.text.slice(0, 160) }));
  const q = query.toLowerCase();
  const 先 = (re: RegExp) => [...全部.filter((x) => re.test(x.url + x.title)), ...全部.filter((x) => !re.test(x.url + x.title))];
  if (/(hiring|job|招聘|fair|展|news|新闻|expan)/.test(q)) return 先(/jobs|fair/).slice(0, 4);
  if (/(complaint|scam|fraud|payment|投诉|纠纷|付款|风险|review)/.test(q)) return 先(/forum|registry/).slice(0, 4);
  return 先(/about|registry/).slice(0, 5);
}

export function 模拟读页(url: string): 读页结果 {
  const p = 见过的页.get(url);
  // 模型自己编了一个没搜到过的网址：和真的一样读不到
  if (!p) throw new Error("这个网址读不了：模拟材料里没有这一页");
  return { url, title: p.title, text: p.text, 截断了: false };
}

export function 模拟通道(): 背调通道 {
  return {
    名: "模拟",
    扣次: 0,
    模型: undefined,
    async 价目() {
      return { 扣次: 0, 还剩: null };
    },
    async 开始() {
      return { ok: true, 扣了: 0, 还剩: 0 };
    },
    async 搜索(_runId, query) {
      await new Promise((r) => setTimeout(r, 150));
      return 模拟搜索(query);
    },
    async 读页(_runId, url) {
      await new Promise((r) => setTimeout(r, 120));
      return 模拟读页(url);
    },
    async 核验(请求) {
      await new Promise((r) => setTimeout(r, 200));
      return 模拟核验(请求);
    },
    async 收尾() {
      return { ok: true, 退了: 0, 还剩: 0 };
    },
  };
}

/**
 * 模拟的程序直查：不联网。工商库、域名、官网是编的（registry.example），邮箱、电话、制裁名单走真的判断规则
 * （contact.ts / sanctions.ts），只是把查 MX、查注册时间、名单换成假的——这样 e2e 看到的灯和线上同一套规矩
 */
export async function 模拟核验(请求: Omit<核验请求, "runId">): Promise<核验回应> {
  const 假 = 是假公司(请求.公司);
  const 域 = 请求.域名;
  const 日期 = 假 ? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10) : "2009-03-02";
  const 年 = { 有: true as const, 日期, 依据: "RDAP" as const, 下限: false, 链接: `https://rdap.example/domain/${域}` };
  const 名单 = [{ 名: "OFAC" as const, 更新于: new Date().toISOString(), 条: [{ 名: ["Example Sanctioned Trading LLC"], 国: ["IR"], 链: "https://sanctions.example/1", 号: "OFAC 1" }] }];
  return {
    项: [
      假
        ? { key: "registry", 灯: "yellow", 态: "没查到", 事实: `示例登记库里没查到「${请求.公司}」` }
        : { key: "registry", 灯: "green", 态: "已核", 事实: `示例登记库：${请求.公司}，HRB 00000，存续，2009-03-02 成立，Hamburg`, 链接: [{ title: "示例登记库", url: `https://registry.example/${名字段(请求.公司)}` }] },
      请求.税号 ? { key: "vat", 灯: "green", 态: "已核", 事实: `${请求.税号}：有效（示例）` } : { key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号，未查" },
      域名项(域, 域 ? 年 : null),
      域 ? (假 ? { key: "site", 灯: "yellow", 态: "已核", 事实: `可打开，HTTPS；首页上没看到这家公司的名字` } : { key: "site", 灯: "green", 态: "已核", 事实: "可打开，HTTPS；页面上有这家公司的名字", 链接: [{ title: 请求.公司, url: `https://${域}/` }] }) : { key: "site", 灯: "yellow", 态: "没查到", 事实: "没找到官网" },
      await 查邮箱(请求.邮箱 ?? [], 域, { 查MX: async () => true, 查年龄: async () => 年 }),
      查电话(请求.电话 ?? [], 请求.国家, 请求.自报国家),
      制裁项(名单, [请求.公司], 请求.国家),
    ],
    名单更新于: 名单[0].更新于,
  };
}

/**
 * 模拟的「发件 IP → 国家」（第二期）：e2e、演示用，不下载真的 IP 库。
 * 按 IP 第一段给个固定的国家（不到 100 阿联酋、不到 200 德国、其余中国），够测「对得上 / 对不上」两种
 */
export async function 模拟查IP(ip: string): Promise<string | null> {
  const 头 = Number(ip.split(".")[0]);
  if (!Number.isFinite(头)) return null;
  return 头 < 100 ? "AE" : 头 < 200 ? "DE" : "CN";
}

