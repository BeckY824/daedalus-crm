import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { ConfigProvider, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MotionConfig } from "motion/react";
import { themeConfig } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daedalus CRM",
  description: "客户全周期管理，让销售更高效",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConfigProvider locale={zhCN} theme={themeConfig}>
            {/*
              动效的两条全局约定，挂在最外面一层：

              reducedMotion="user" —— 系统开了「减弱动态效果」，**所有 motion 组件自动不动**。
                globals.css 末尾那条 @media 只管 CSS 的 transition/animation，
                管不到 JS 驱动的值：在这一行之前，时间线、AI 面板、建议卡在那个开关下照动不误。
                一个一个组件去调 useReducedMotion 也行，但漏一个就是漏一个。

              transition —— 没写 transition 的 motion 组件一律用全站那条曲线
                （--ease 的数值版，见 components/Rise.tsx）。默认那条弹簧和 CSS 里的
                不是一套东西，同屏出现时能看出来是两个人做的。
            */}
            <MotionConfig reducedMotion="user" transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
              <AntdApp>{children}</AntdApp>
            </MotionConfig>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
