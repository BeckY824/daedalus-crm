/**
 * 排版自动检查（2026-10-19 团队版主动排查）：客户连报的几个显示 bug 都是同一类——
 * flex 里不换行的子元素把卡片撑破、长名字把按钮挤出栏外、被上面一层盖住点不动、按钮被切一半。
 * 这里把它们写成在页面里量的规则，任何 e2e（网页 / 桌面壳 / 手机 /m / 运营台）走到一页就能调一次：
 *
 *   const 问题 = await 查排版(page);
 *   expect(问题, 说问题(问题)).toEqual([]);
 *
 * 量的几样（都只看当前视口里看得见的元素）：
 *   - 页面横滚：整页比窗口宽，手机上一拖就左右晃。html 和 body 两个都量：body 也是 height:100%，内容撑宽时有时只有 body 变宽
 *   - 撑出：overflow 是 visible 的盒子，里面有子元素伸出去（scrollWidth > clientWidth）。只报最里层那个，
 *     并说出是哪个子元素伸出去的——那就是该加 min-width:0 / 省略号 / 换行的地方
 *   - 被裁：overflow hidden / clip 的盒子把子元素切掉一截，又没有省略号（字被拦腰截断）
 *   - 字溢出：nowrap / pre 的字比自己的盒子长，又没有省略号、也没被裁——字冲出盒子压到旁边（10-22 普查：客户记录页字段名压在值上、
 *     列表里长名字压过后面几列）。撑出只看子元素，字直接写在盒子里时它看不到
 *   - 出界：按钮、链接、输入框有一部分在窗口外或被祖先的裁剪框切掉（「右上按钮被切一半」）
 *   - 被盖住：可点的东西中心点上 elementFromPoint 拿到的是别人（「压在 AI 栏下点不动」）
 *   - 压字：绝对定位的按钮（弹窗的 ×）压在旁边的字上（长标题钻到 × 底下）
 *   - 折行：按钮、标签、表头这种短字（≤ 8 个字）被挤成两行以上（「‹ 客户」被挤成竖排、表格列被挤成竖排）
 *
 * 规则是启发式的：动画中途、故意做成横向滚动的条（.m-chips 这种）会误报，用 忽略 传选择器排掉。
 */
import type { Page } from "@playwright/test";

export type 排版问题 = { 类: "页面横滚" | "撑出" | "被裁" | "字溢出" | "出界" | "被盖住" | "压字" | "折行"; 在哪: string; 字: string; 量: string };
export type 查排版选项 = {
  /** 只查这个选择器里面（比如打开的弹窗、抽屉）；不给就查整页 */
  范围?: string;
  /** 这些选择器命中的元素（和它们里面的）不查 */
  忽略?: string[];
  /** 容差（像素），默认 1.5：小数像素取整的抖动不算 */
  容差?: number;
};

/** antd / 浏览器内部本来就靠 overflow 藏东西的，不算问题 */
const 默认忽略 = [
  ".ant-select-selection-search", ".ant-select-selection-overflow", ".ant-input-number-handler-wrap", ".ant-table-measure-row",
  ".ant-tabs-nav-operations", ".ant-tabs-ink-bar", ".ant-picker-panel-container", ".ant-tooltip", ".ant-popover-arrow",
  ".ant-slider", ".ant-segmented-thumb", ".ant-wave", ".ant-scroll-number", "[aria-hidden='true']", "svg", "canvas", "video", "iframe",
  // 表格内部要查（列被切、按钮被切、表头竖排都在里面，10-19 运营台三处就是这么漏的）：有 scroll.x 的表自己是横滚容器，下面会跳过。
  // 只跳带 scroll.y 时单独那条表头：它 overflow:hidden、跟着表体横滚，表体那份已经量了
  ".ant-table-header", ".ant-tabs-nav-wrap", ".ant-tabs-nav-list",
  ".ant-select-selection-overflow-item-rest", ".ant-image-preview-root", "option",
];

export async function 查排版(page: Page, 选项: 查排版选项 = {}): Promise<排版问题[]> {
  return page.evaluate(({ 范围, 忽略, 容差 }) => {
    const 问题: { 类: string; 在哪: string; 字: string; 量: string }[] = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const 根 = 范围 ? document.querySelector(范围) : document.body;
    if (!根) return [{ 类: "出界", 在哪: 范围 ?? "body", 字: "", 量: "范围选择器没找到" }];
    const 忽略的 = (el: Element) => 忽略.some((s) => { try { return !!el.closest(s); } catch { return false; } });
    const 名 = (el: Element | null): string => {
      const 段: string[] = [];
      for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
        const tid = e.getAttribute("data-testid");
        const cls = [...e.classList].filter((c) => !/^(css-|ant-motion|is-)/.test(c)).slice(0, 2).join(".");
        段.unshift(`${e.tagName.toLowerCase()}${tid ? `[data-testid=${tid}]` : ""}${cls ? `.${cls}` : ""}`);
        if (tid) break;
      }
      return 段.join(" > ");
    };
    const 字 = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const 看得见 = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return false;
      }
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const 横滚容器 = (el: Element) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const ox = getComputedStyle(e).overflowX;
        if ((ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth + 1) return e;
      }
      return null;
    };

    // 浮在滚动区上的栏：fixed / sticky，或手机伴侣那种 absolute 贴底的底栏（.m-tabbar、.m-bottom-bar）
    const 固定层 = (e: Element | null) => {
      for (; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === "fixed" || p === "sticky" || p === "absolute") return e; }
      return null;
    };
    const 还能滚出来 = (el: Element, 盖: Element) => {
      const 层 = 固定层(盖);
      if (!层 || 层.contains(el)) return false;
      const 盖r = 层.getBoundingClientRect();
      for (let e = el.parentElement; e; e = e.parentElement) {
        const oy = getComputedStyle(e).overflowY;
        const 是滚 = e === document.scrollingElement || oy === "auto" || oy === "scroll";
        if (!是滚 || e.scrollHeight <= e.clientHeight + 1) continue;
        // absolute 的层要是在这个滚动区里面，会跟着内容一起滚，滚也躲不开
        if (getComputedStyle(层).position === "absolute" && e.contains(层)) return false;
        // 底栏还是顶栏：看它落在滚动区的下半截还是上半截。不能拿它和元素的顶边比——一行只露出个头、大半截在底栏后面时，行的顶边比底栏的顶边还低
        const sr = e === document.scrollingElement ? { top: 0, bottom: innerHeight } : e.getBoundingClientRect();
        const 在下面 = 盖r.top + 盖r.bottom > sr.top + sr.bottom;
        return 在下面 ? e.scrollTop + e.clientHeight < e.scrollHeight - 1 : e.scrollTop > 1;
      }
      return false;
    };

    // 页面横滚
    const 页宽 = Math.max(document.scrollingElement?.scrollWidth ?? 0, document.documentElement.scrollWidth, document.body.scrollWidth);
    if (!范围 && 页宽 > vw + 容差) 问题.push({ 类: "页面横滚", 在哪: "document", 字: "", 量: `页宽 ${页宽} > 窗口 ${vw}` });

    const 全部 = [...根.querySelectorAll("*")].filter((el) => !忽略的(el) && 看得见(el));

    // 撑出 / 被裁：看伸出最远的那个子元素
    const 伸出的子 = (el: Element) => {
      const r = el.getBoundingClientRect();
      let 最远: Element | null = null, 多 = 0;
      for (const c of el.querySelectorAll("*")) {
        if (忽略的(c)) continue;
        const cs = getComputedStyle(c);
        if (cs.position === "fixed" || cs.position === "absolute" || cs.display === "none") continue;
        const cr = c.getBoundingClientRect();
        if (cr.width < 1 || cr.height < 1) continue;
        // 负外边距故意往外探的（列表行 margin: 0 -6px 让悬停底色出血、antd 栅格 .ant-row 的 gutter）不算：
        // 从它到 el 之间每一层探出去的都减掉
        let 探右 = 0, 探左 = 0;
        for (let e: Element | null = c; e && e !== el; e = e.parentElement) {
          const ms = e === c ? cs : getComputedStyle(e);
          探右 += Math.max(0, -parseFloat(ms.marginRight) || 0); 探左 += Math.max(0, -parseFloat(ms.marginLeft) || 0);
        }
        const 超 = Math.max(cr.right - r.right - 探右, r.left - cr.left - 探左);
        if (超 > 多) { 多 = 超; 最远 = c; }
      }
      return { 最远, 多 };
    };
    const 撑出的: Element[] = [];
    for (const el of 全部) {
      const cs = getComputedStyle(el);
      if (cs.display === "inline" || cs.display === "contents") continue;
      if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 容差) continue;
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
      const { 最远, 多 } = 伸出的子(el);
      if (!最远 || 多 <= 容差) continue;
      if (cs.overflowX === "visible") 撑出的.push(el);
      else if (cs.textOverflow !== "ellipsis" && getComputedStyle(最远).textOverflow !== "ellipsis" && !(最远 as HTMLElement).closest("[style*='ellipsis']")) {
        问题.push({ 类: "被裁", 在哪: 名(el), 字: 字(最远), 量: `${名(最远)} 被切掉 ${Math.round(多)}px` });
      }
    }
    // 只报最里层：外面那几层是被它连带撑开的
    for (const el of 撑出的) {
      if (撑出的.some((o) => o !== el && el.contains(o))) continue;
      const { 最远, 多 } = 伸出的子(el);
      问题.push({ 类: "撑出", 在哪: 名(el), 字: 字(最远!), 量: `${名(最远)} 伸出 ${Math.round(多)}px` });
    }

    // 字溢出：盒子自己就有字（不是子元素伸出去，那是撑出），不折行、比盒子长、又不省略不裁。已经报了撑出的盒子不重复报
    for (const el of 全部) {
      if (撑出的.includes(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.whiteSpace !== "nowrap" && cs.whiteSpace !== "pre") continue;
      if (cs.overflowX !== "visible" || cs.textOverflow === "ellipsis" || cs.display === "inline" || cs.display === "contents") continue;
      if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 容差) continue;
      const 自己的字 = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
      if ([...自己的字].length <= 3) continue;
      问题.push({ 类: "字溢出", 在哪: 名(el), 字: 字(el), 量: `字宽 ${el.scrollWidth}，盒子 ${el.clientWidth}` });
    }

    // 出界 / 被盖住：可点的东西
    const 可点 = 全部.filter((el) => el.matches("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option], .ant-btn"));
    for (const el of 可点) {
      if (el.closest("button, a[href], [role=button]") !== el && el.parentElement?.closest("button, a[href], [role=button], [role=radio], [role=tab]")) continue;
      const r = el.getBoundingClientRect();
      if (横滚容器(el)) continue;
      // 被各层裁剪框切掉多少
      let 左 = Math.max(r.left, 0), 右 = Math.min(r.right, vw), 上 = Math.max(r.top, 0), 下 = Math.min(r.bottom, vh);
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const er = e.getBoundingClientRect();
        if (cs.overflowX !== "visible") { 左 = Math.max(左, er.left); 右 = Math.min(右, er.right); }
        if (cs.overflowY !== "visible") { 上 = Math.max(上, er.top); 下 = Math.min(下, er.bottom); }
      }
      const 宽 = Math.max(0, 右 - 左), 高 = Math.max(0, 下 - 上);
      // 竖着被切的多半是还没滚到（滚动容器里），只管横着切
      if (宽 < r.width - 容差 && 宽 > 0 && 高 > 0) {
        问题.push({ 类: "出界", 在哪: 名(el), 字: 字(el) || el.getAttribute("aria-label") || "", 量: `宽 ${Math.round(r.width)}，露出 ${Math.round(宽)}` });
        continue;
      }
      if (宽 < 2 || 高 < 2) continue;
      // 被盖住：在露出来的那块中心点上看是谁
      const x = 左 + 宽 / 2, y = 上 + 高 / 2;
      const 命中 = document.elementFromPoint(x, y);
      if (!命中 || 命中 === el || el.contains(命中) || 命中.contains(el)) continue;
      // 开着模态框时，框后面的整页本来就点不到（遮罩挡着，是故意的）：只查框里的
      if (命中.closest(".ant-modal-wrap, .ant-modal-mask, .ant-drawer-mask") && !el.closest(".ant-modal-wrap, .ant-drawer-content-wrapper")) continue;
      // 盖在上面的是忽略掉的浮层（antd 一会儿就走的提示、开发模式 Next 左下角的 issues 小圆钮）：不是产品的层
      if (忽略的(命中)) continue;
      if (getComputedStyle(el).pointerEvents === "none") continue;
      // 压在固定的顶栏 / 底栏下面、但列表还能往那边滚：滚一下就露出来，不算。滚到底还压着才算
      if (还能滚出来(el, 命中)) continue;
      // label 套着 input（隐藏的单选框）：点 label 一样
      if (el.matches("input") && (命中.closest("label")?.contains(el) || (el.id && 命中.closest(`label[for='${el.id}']`)))) continue;
      问题.push({ 类: "被盖住", 在哪: 名(el), 字: 字(el) || el.getAttribute("aria-label") || "", 量: `中心 (${Math.round(x)},${Math.round(y)}) 上是 ${名(命中)}` });
    }

    // 压字：绝对定位的按钮（弹窗右上的 ×、卡片角上的小按钮）压在旁边的字上——字长了不会给它让位置（10-19 手机批准框长设备名的标题钻到 × 底下）
    for (const el of 可点) {
      if (getComputedStyle(el).position !== "absolute") continue;
      // antd 下拉框里那个透明的搜索输入框本来就叠在自己选中的值上
      if (el.matches("input, textarea, select")) continue;
      const 框 = (el as HTMLElement).offsetParent;
      if (!框) continue;
      const r = el.getBoundingClientRect();
      const 走 = document.createTreeWalker(框, NodeFilter.SHOW_TEXT);
      for (let n = 走.nextNode(); n; n = 走.nextNode()) {
        const 主 = n.parentElement;
        if (!主 || el.contains(主) || !(n.textContent ?? "").trim() || 忽略的(主) || !看得见(主)) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        const 压 = [...rg.getClientRects()].find((t) => Math.min(t.right, r.right) - Math.max(t.left, r.left) > 2 && Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top) > 2);
        if (!压) continue;
        问题.push({ 类: "压字", 在哪: 名(el), 字: 字(el) || el.getAttribute("aria-label") || "", 量: `压在「${(n.textContent ?? "").trim().slice(0, 20)}」(${名(主)}) 上` });
        break;
      }
    }

    // 折行：短字被挤成好几行。按每个字的位置数行数，不靠高度猜
    const 短字的 = 全部.filter((el) => el.matches("button, a[href], [role=button], [role=tab], .ant-btn, .ant-tag, .m-tag, th, .ant-table-cell, .ant-segmented-item-label"));
    for (const el of 短字的) {
      if (短字的.some((o) => o !== el && el.contains(o))) continue;
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!t || [...t].length > 8) continue;
      // 里面有块级的子元素（「逾期跟进 / 6 先处理」、设置左栏「外观 / 底色和主题」）是设计成上下几行的：那就按每段字自己数，
      // 一段字被拆到两行才算；全是行内的（按钮、表头、标签）整个一起数
      const 分块 = [...el.querySelectorAll("*")].some((d) => !getComputedStyle(d).display.startsWith("inline") && getComputedStyle(d).display !== "contents");
      const 数行 = (顶们: number[]) => { 顶们.sort((a, b) => a - b); return 顶们.length ? 1 + 顶们.slice(1).filter((y, i) => y - 顶们[i] > 6).length : 0; };
      const 每段: number[][] = [];
      const 走 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = 走.nextNode(); n; n = 走.nextNode()) {
        const 段 = n.textContent ?? "", 顶们: number[] = [];
        for (let i = 0; i < 段.length; i++) {
          if (/\s/.test(段[i])) continue;
          const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1);
          const rr = rg.getBoundingClientRect();
          if (rr.width > 0) 顶们.push(rr.top);
        }
        每段.push(顶们);
      }
      const 行数 = 分块 ? Math.max(0, ...每段.map(数行)) : 数行(每段.flat());
      if (行数 > 1) 问题.push({ 类: "折行", 在哪: 名(el), 字: t, 量: `${[...t].length} 个字排成了 ${行数} 行` });
    }
    return 问题;
  }, { 范围: 选项.范围 ?? null, 忽略: [...默认忽略, ...(选项.忽略 ?? [])], 容差: 选项.容差 ?? 1.5 }) as Promise<排版问题[]>;
}

/** 给 expect 的失败说明 */
export const 说问题 = (问题: 排版问题[]) => 问题.map((x) => `[${x.类}] ${x.在哪}「${x.字}」${x.量}`).join("\n");
