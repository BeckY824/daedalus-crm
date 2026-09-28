/*
 * 从 app/api/desktop/session/route.ts 挪出来：路由文件只许导出 GET/POST 这些处理函数，
 * 多导出一个函数，next dev 生成的路由类型检查就报「不兼容 index signature」（tsc 挂）。
 */
/**
 * 壳带来的「回到上一页」。只认站内的应用路径：登录、找回、API、后台这些不是落点，
 * 协议相对地址（//evil）更不是。收不下的一律回 /dashboard。
 */
export function 选落点(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  const 路径 = next.split("?")[0];
  if (路径 === "/" || /^\/(login|signup|forgot|api|admin|_next)(\/|$)/.test(路径)) return "/dashboard";
  return next;
}
