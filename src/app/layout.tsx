import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { themeConfig } from "@/lib/theme";
import MotionTheme from "@/components/MotionTheme";
import { 外观预设脚本, 默认外观 } from "@/lib/appearance";
import "./globals.css";
/* 主题（设置 → 外观 → 主题）。每套只在 <html data-skin="x"> 时生效，现状下这几份一条都不命中。
   字体只登记 @font-face、不预加载：浏览器只在某段字真用上这个字体时才去下载，所以不选这套主题就一个字节都不下。
   只取拉丁子集——中文走系统字（宋体 / 苹方），不打包中文字体 */
import "./skins/shared.css";
import "./skins/pixel.css";
import "./skins/tech.css";
import "./skins/luxe.css";
import "./skins/ledger.css";
import "@fontsource/pixelify-sans/latin-500.css";
import "@fontsource/pixelify-sans/latin-700.css";
import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/instrument-serif/latin-400.css";

export const metadata: Metadata = {
  title: "Daedalus CRM",
  description: "客户全周期管理，让销售更高效",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /* data-paper / data-skin 是外观（lib/appearance.ts）。服务端先按默认渲染，
       <head> 里那段在第一次绘制前换成这台电脑存的——所以 html 上这两个属性和服务端对不上是预期的 */
    <html lang="zh-CN" data-paper={默认外观.paper} data-skin={默认外观.skin} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: 外观预设脚本 }} />
      </head>
      <body>
        <AntdRegistry>
          <ConfigProvider locale={zhCN} theme={themeConfig}>
            {/* 动效的两条全局约定（减弱动态时 motion 不动、默认过渡用全站那条曲线）挂在 MotionTheme 里，
                值跟着当前主题读——见 components/MotionTheme.tsx */}
            <MotionTheme>
              <AntdApp>{children}</AntdApp>
            </MotionTheme>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
