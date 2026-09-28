/**
 * 外观：这台电脑上的样子（设置 → 外观）。**只换值，不换结构、不动数据，也不影响同事**。
 *
 * 一个外观 = 挂在 <html> 上的两个属性，globals.css 按属性换 token：
 *   data-paper  底色。tone = 原底（左栏和页面是浅灰的工作台色，现在的样子）；white = 白底（地面铺白）
 *   data-skin   主题。一套主题 = 一组 token 值 + 不超过 10 条形状规则 + 自己的动效曲线和时长，
 *               样式在 src/app/skins/<key>.css（现状就是 globals.css 的 :root，不另开文件）。
 *               加一套主题：主题表 加一项、skins/ 下加一个文件、layout.tsx 引入——调用处一行都不用改。
 *               tests/skins.test.ts 会核对这三处对得上（「必须一致的清单」，见 docs/架构.md）
 *
 * 存在浏览器本地（localStorage），不进库：外观是「我这台电脑怎么看」，不是团队配置。
 * 首次绘制前由 外观预设脚本 读出来挂上（layout.tsx 的 <head>），否则刷新时会先闪一下默认样子。
 */

export const 外观键 = "daedalus.appearance";

export const 底色表 = [
  { key: "tone", 名: "原底", 说明: "左栏和页面是浅灰的，卡片是白的" },
  { key: "white", 名: "白底", 说明: "整页铺白，卡片靠一道细线分开" },
] as const;
export type 底色 = (typeof 底色表)[number]["key"];

export const 主题表 = [
  { key: "now", 名: "现状", 说明: "一直以来的样子" },
  { key: "pixel", 名: "像素", 说明: "黑白硬边、方角、一格一格地动" },
  { key: "tech", 名: "科技", 说明: "等宽字、细线；原底是深色" },
  { key: "luxe", 名: "高级", 说明: "宋体标题、大留白、慢一点" },
  { key: "ledger", 名: "账簿", 说明: "稿纸格线；朱红只留给你确认的那一下" },
] as const;
export type 主题 = (typeof 主题表)[number]["key"];

export type 外观 = { paper: 底色; skin: 主题 };
export const 默认外观: 外观 = { paper: "tone", skin: "now" };

/** 本地存的东西不可信（旧版本、手改、坏 JSON）：认不出的一律回到默认 */
export function 读外观(raw: string | null | undefined): 外观 {
  let v: Partial<外观> = {};
  try {
    v = raw ? (JSON.parse(raw) as Partial<外观>) : {};
  } catch {
    v = {};
  }
  return {
    paper: 底色表.some((x) => x.key === v.paper) ? (v.paper as 底色) : 默认外观.paper,
    skin: 主题表.some((x) => x.key === v.skin) ? (v.skin as 主题) : 默认外观.skin,
  };
}

/** 把外观挂到 <html> 上 */
export function 挂外观(a: 外观, el: HTMLElement = document.documentElement) {
  el.dataset.paper = a.paper;
  el.dataset.skin = a.skin;
}

/**
 * 首次绘制前跑的那段。写成字符串塞进 <head>，它跑的时候 React 还没起来，所以不能 import 任何东西；
 * 认值的规矩和 读外观 同一套（tests/appearance.test.ts 两边对一遍）
 */
export const 外观预设脚本 = `(function(){try{var d=${JSON.stringify(默认外观)},v={};try{v=JSON.parse(localStorage.getItem(${JSON.stringify(外观键)})||"{}")||{};}catch(_){}var P=${JSON.stringify(底色表.map((x) => x.key))},S=${JSON.stringify(主题表.map((x) => x.key))};var e=document.documentElement;e.dataset.paper=P.indexOf(v.paper)>-1?v.paper:d.paper;e.dataset.skin=S.indexOf(v.skin)>-1?v.skin:d.skin;}catch(_){}})();`;
