import type { Metadata, Viewport } from "next";
import { palette } from "@/lib/palette";
import MobileApp from "./MobileApp";
import SwRegister from "./SwRegister";

/**
 * 手机版（2026-10-15，方案：~/Opensource_CRM/02-开发与发版/手机端-方案-20261015.md）。
 * 只给团队版成员用：账号密码登录后要本人的电脑授权才有数据；页面本身不带任何数据（proxy.ts 放行 /m）。
 */
export const metadata: Metadata = {
  title: "Daedalus",
  manifest: "/m/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Daedalus", statusBarStyle: "default" },
  formatDetection: { telephone: false, email: false, address: false },
  // 老一点的 iPhone（iOS 16.4 以前）只认这一行才全屏打开；新的读 manifest 的 display: standalone
  other: { "apple-mobile-web-app-capable": "yes" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // 只有浅色（和桌面端一样）：状态栏就是页面底色
  themeColor: palette.workbench,
};

/**
 * 浏览器太旧（2026-10-15 真机：小米 8 自带浏览器，内核 Chrome 57）：手机版的脚本根本跑不起来，会一直转圈。
 * 这段只用老语法写，在页面脚本之前跑：缺 加密 / 压缩 / 本地库 / 新语法 任何一样，就换成一句说明。
 * X25519、Ed25519 没内置不算旧——crypto-web.ts 有纯 JS 实现（华为浏览器、QQ 浏览器就是这样）
 */
const 太旧检查 = `(function () {
  var 行 = true;
  try { 行 = !!(window.crypto && crypto.subtle && window.indexedDB && window.CompressionStream && window.Promise); new Function("var a; return a?.b ?? 1"); } catch (e) { 行 = false; }
  if (行) return;
  // 叠在最上面，不动页面原有的节点：脚本万一还跑得动，React 接管时也不会把这层盖掉
  document.documentElement.className += " m-page";
  var 层 = document.createElement("div");
  层.className = "m-root m-too-old";
  层.innerHTML = '<div class="m-flow"><div class="m-flow-top"><img class="m-logo" alt="" src="/icon.svg"><h1>这个浏览器版本太旧了</h1>'
    + '<p>打不开 Daedalus 手机版。换一个浏览器就行：</p></div>'
    + '<div class="m-callout">在<b>微信</b>里打开这个链接（发给自己或「文件传输助手」再点开）；或者在应用商店把浏览器更新到最新版。</div></div>';
  document.body.appendChild(层);
})();`;

export default function MobilePage() {
  return (
    <>
      <MobileApp />
      <SwRegister />
      <script dangerouslySetInnerHTML={{ __html: 太旧检查 }} />
    </>
  );
}
