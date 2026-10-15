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

export default function MobilePage() {
  return (
    <>
      <MobileApp />
      <SwRegister />
    </>
  );
}
