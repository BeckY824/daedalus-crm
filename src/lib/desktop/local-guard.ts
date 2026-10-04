import { timingSafeEqual } from "node:crypto";

/**
 * 桌面端本地服务的两道门（2026-10-04，桌面端 e2e 搭建时发现的 D-1）。
 *
 * 原来本地模式下 /login 对**任何**没登录的请求都 307 到 /api/desktop/session?t=<DESKTOP_TOKEN>：
 * 令牌就写在 Location 里，谁连得上这个端口谁就能拿到会话——
 *   - 127.0.0.1 不只是「这个用户」：同一台电脑上别的系统账户也连得上；
 *   - 恶意网页把自己的域名重绑定到 127.0.0.1（DNS rebinding），浏览器就会带着那个域名的 Host 来要，照样给。
 * 令牌那道闸（session 路由的定长比较）等于没有。
 *
 * 现在：
 *   是本机地址() —— Host 必须是 127.0.0.1 / localhost / [::1]，挡 DNS 重绑定（proxy.ts 和 session 路由都查）
 *   来自壳()     —— 壳（desktop/main.js）给自己窗口发往本地服务的请求都带 x-desktop-token；
 *                   /login 只有看到它对得上才自动登录，别人来只看到登录门
 */
export function 是本机地址(host: string | null | undefined): boolean {
  if (!host) return false;
  const 名 = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return 名 === "127.0.0.1" || 名 === "localhost" || 名 === "[::1]";
}

export function 来自壳(给的: string | null | undefined, 期望 = process.env.DESKTOP_TOKEN): boolean {
  if (!期望 || !给的) return false;
  const a = Buffer.from(给的);
  const b = Buffer.from(期望);
  return a.length === b.length && timingSafeEqual(a, b);
}
