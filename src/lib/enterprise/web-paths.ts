/**
 * 企业版网页里不该有的页面（2026-10-24，需求第五节：「网页版里不能出现托管版、价格页、
 * 「请下载桌面端」之类的遗留入口和文案」）。
 *
 * 企业版是客户自己服务器上的单租户网页版，这几页讲的都是我们的桌面端 / 云端账号：
 *   /signup             —— 注册我们的云端账号、去下载桌面端；企业版成员由管理员在界面上加
 *   /terms /privacy     —— 我们这项服务的用户协议和隐私说明，客户自己的实例不适用
 *   /m /m/*             —— 手机伴侣，是团队版的功能，登的是桌面端的账号
 *   /feedback           —— 反馈发给我们（云端）或去 GitHub 提 issue，客户的实例不该认识这两处
 *
 * 放在 proxy 里统一跳：/terms、/privacy 是构建期预渲染的静态页，页面里读运行时环境变量读不到。
 * 返回要跳去的路径，不用跳就返回 null。没登录的人跳到 /dashboard 后，proxy 下一趟会再送去 /login。
 */
export function 企业版跳转(pathname: string): string | null {
  if (pathname === "/signup" || pathname === "/terms" || pathname === "/privacy") return "/login";
  if (pathname === "/m" || pathname.startsWith("/m/")) return "/dashboard";
  if (pathname === "/feedback" || pathname.startsWith("/feedback/")) return "/dashboard";
  return null;
}
