/**
 * 「最近看过的那位客户」（2026-10-03，照毛玻璃原型：左栏点「客户」直接进名单 + 详情）。
 *
 * 记在 cookie 里而不是库里：每打开一位就写一次库不值得；也不放 localStorage——跳转页在服务端，读不到它。
 * cookie 不分端口，桌面端本地服务换端口也还在。
 */
export const 最近客户键 = "crm_last_customer";

/** 客户详情页打开时调一次（浏览器里） */
export function 记下最近客户(id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  document.cookie = `${最近客户键}=${id}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
