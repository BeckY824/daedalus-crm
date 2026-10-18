/**
 * 「网上足迹」：这家公司有没有 LinkedIn / Facebook 公司主页、能不能搜到在职员工（10-18 用户定）。
 *
 * **合规边界**：
 *   - 不登录 LinkedIn / Facebook，不打开这些页面——读网页通道遇到这些域名直接跳过（是社媒网址），只用搜索结果；
 *   - 只回答「有没有」，有就附链接。不数人头、不把人名职位抄成联系人列表，存进客户时也不自动建联系人；
 *   - 不接第三方 LinkedIn 数据商。
 * 这一行只是真实性的参考信号：全未搜到标黄、不标红（很多中小进口商确实不做社媒）。
 * LinkedIn 我们的搜索不收录（10-18 实测），只能从别的搜索结果里顺带认到。
 */
import type { 搜索结果 } from "../types";
import type { 核验项, 核验链接 } from "./types";
import { 提到了, 比名字, 查询名 } from "./names";

const 社媒域 = /(^|\.)(linkedin\.com|facebook\.com|fb\.com|fb\.me|instagram\.com|lnkd\.in)$/i;

export function 是社媒网址(url: string): boolean {
  try {
    return 社媒域.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 近期信号那一步程序自己发的定向搜索（不让模型挑）：用现有的搜索通道，site: 由搜索服务转成域名过滤（providers.ts 拆站点）。
 * **只搜 Facebook**：10-18 bench 实测我们用的网页搜索（gpt-5.5）不收录 LinkedIn——加不加过滤、换什么说法都搜不出
 * linkedin.com 的链接，那一次白花钱。LinkedIn 只从这次别的搜索结果里顺带认（认足迹），事实里写明搜不到不扣分
 */
export function 社媒查询(公司: string): string[] {
  const 名 = 查询名(公司);
  return [`"${名}" site:facebook.com`];
}

type 分类 = "公司主页" | "员工" | "Facebook";

/** facebook.com 下不是某个主页的路径 */
const FB保留 = /^\/(search|login|sharer|share|dialog|plugins|watch|events|marketplace|groups|hashtag|help|policies|privacy|permalink\.php|story\.php|photo\.php|profile\.php|people|pages|p|reel|stories)(\/|$)/;

function 分类(url: string): 分类 | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase();
  if (/(^|\.)linkedin\.com$/.test(h)) {
    if (/^\/(company|showcase)\/[^/]+/.test(p)) return "公司主页";
    if (/^\/in\/[^/]+/.test(p)) return "员工";
    return null;
  }
  if (/(^|\.)facebook\.com$/.test(h)) {
    // 搜索页、登录页、分享链接不算主页；主页下的单条帖子 / 视频 / 照片算它那个主页（认足迹 里换成主页链接）
    if (FB保留.test(p) || p === "/") return null;
    return "Facebook";
  }
  return null;
}

/** 链接里的那一截名字（linkedin.com/company/slv-gmbh → 「slv gmbh」），拿来和公司名比 */
function 路径名(url: string): string {
  try {
    const 段 = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(段[段[0] === "company" || 段[0] === "showcase" || 段[0] === "in" ? 1 : 0] ?? "").replace(/[-_.]+/g, " ");
  } catch {
    return "";
  }
}

/**
 * 从这次所有的搜索结果里认足迹。**只看搜索结果页上的标题、摘要和链接**：
 *   公司主页 / Facebook：链接那一截名字或标题里有这家的名字
 *   员工：个人页的标题或摘要里写着这家的名字（「… - Sales Manager - SLV GmbH | LinkedIn」）
 * 搜索出错（一次都没搜成）是「查不了」，不是「未搜到」
 */
export function 认足迹(结果: 搜索结果[], 公司: string, 搜成了: boolean): 核验项 {
  const 收: Record<分类, 核验链接[]> = { 公司主页: [], 员工: [], Facebook: [] };
  const 见过 = new Set<string>();
  for (const r of 结果) {
    const k = 分类(r.url);
    if (!k) continue;
    // Facebook 主页下的帖子、子页（facebook.com/RexelFR/posts/…、/about/、/reels/，10-18 bench 搜到的多是这种）：
    // 算它那个主页，链接换成主页本身
    const 帖 = k === "Facebook" ? /^\/([^/]+)\/[^/]+/i.exec(new URL(r.url).pathname) : null;
    const url = 帖 ? `https://www.facebook.com/${帖[1]}` : r.url;
    const 键 = url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (见过.has(键)) continue;
    // 主页名从标题里挑：「Rexel USA - Facebook」「SLV GmbH - Hurra, es wird…」「At Alfanar Training... - alfanar Engineering service - Facebook」，
    // 去掉「Facebook」和截断的帖子摘要（以 ... 结尾），剩下的那段是主页名。标题里有主页名就只按它比（链接那一截
    // alfanar.resort 其实是黎巴嫩的度假村 Al Fanar Resort）；标题里没有才看链接。要同名或近名（多一两个词）：
    // 「提到」不算（施工视频带个 #SLV# 标签也会提到）
    const 主页名 =
      k === "Facebook"
        ? (r.title ?? "")
            .split(/\s[-–|]\s/)
            .map((x) => x.replace(/\s+facebook$/i, "").trim())
            .filter((x) => x && !/^facebook$/i.test(x) && !/(\.\.\.|…)$/.test(x) && x !== new URL(r.url).hostname)
        : [];
    const 认的名 = 主页名.length ? 主页名.find((x) => 比名字(x, 公司)) : 比名字(路径名(url), 公司) ? 路径名(url) : undefined;
    const 对 = k === "员工" ? 提到了(`${r.title} ${r.snippet}`, 公司) : k === "Facebook" ? Boolean(认的名) : 提到了(路径名(url), 公司) || 提到了(r.title, 公司);
    if (!对) continue;
    见过.add(键);
    收[k].push({ title: k === "Facebook" ? `${认的名}（Facebook 主页）` : r.title || r.url, url });
  }
  const 主页 = 收.公司主页.slice(0, 2);
  const 员工 = 收.员工.slice(0, 3);
  const fb = 收.Facebook.slice(0, 2);
  const 事实 = [
    // 列出主页名：同名的别家（「SLV Sports & Wellness」）一眼能看出来
    `Facebook 主页：${fb.length ? `有（${[...new Set(fb.map((l) => l.title.replace(/（Facebook 主页）$/, "")))].join("、")}）` : "未搜到"}`,
    主页.length || 员工.length
      ? `LinkedIn：${[主页.length && "公司主页有", 员工.length && "搜到在职员工"].filter(Boolean).join("、")}`
      : "LinkedIn：我们用的网页搜索不收录，没法查（不扣分）",
  ].join("；");
  const 有 = 主页.length + 员工.length + fb.length > 0;
  if (!有 && !搜成了) return { key: "footprint", 灯: "gray", 态: "查不了", 事实: "Facebook 定向搜索没搜成；LinkedIn 我们用的网页搜索不收录" };
  return { key: "footprint", 灯: 有 ? "green" : "yellow", 态: 有 ? "已核" : "没查到", 事实, 链接: [...主页, ...员工, ...fb] };
}
