import SettingsBody from "./SettingsBody";

/**
 * 设置整页。应用内点「设置」走的是拦截路由（@modal/(.)settings）弹浮层，
 * 只有刷新、深链、桌面端菜单里的 ⌘, 这种硬导航才会落到这一页。
 * 两边共用 SettingsBody，取数逻辑只有一份。
 */
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return <SettingsBody />;
}
