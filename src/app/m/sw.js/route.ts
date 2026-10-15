/**
 * 手机版的 Service Worker（2026-10-15）：断网也能打开手机版、翻看上次同步的客户、记一笔（有网了再传）。
 *   - 打开 /m：先走网络，断网用上次缓存的那份
 *   - /_next/static/*：文件名带哈希、内容不变，缓存优先
 *   - 图标、清单：先给缓存、后台更新
 *   - 接口（/api/*）一律不缓存：数据在 IndexedDB 里，不在这里
 * 放在 /m/sw.js、Service-Worker-Allowed 设成 /m：只管手机版，不碰桌面端和网页上的其它页面。
 */
const 版本 = "m-v1";
const 脚本 = `
const 缓存 = ${JSON.stringify(版本)};
self.addEventListener("install", (e) => { e.waitUntil(caches.open(缓存).then((c) => c.addAll(["/m"])).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("m-") && k !== 缓存).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (r.mode === "navigate" && (u.pathname === "/m" || u.pathname.startsWith("/m/"))) {
    e.respondWith(fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(缓存).then((x) => x.put("/m", c)); } return res; }).catch(() => caches.match("/m").then((x) => x || Response.error())));
    return;
  }
  if (u.pathname.startsWith("/_next/static/")) {
    e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(缓存).then((x) => x.put(r, c)); } return res; })));
    return;
  }
  if (u.pathname === "/icon.svg" || u.pathname.startsWith("/apple-icon") || u.pathname === "/m/manifest.webmanifest") {
    e.respondWith(caches.match(r).then((hit) => { const net = fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(缓存).then((x) => x.put(r, c)); } return res; }).catch(() => hit); return hit || net; }));
  }
});
`;

export function GET() {
  return new Response(脚本, {
    headers: { "content-type": "application/javascript; charset=utf-8", "service-worker-allowed": "/m", "cache-control": "no-cache" },
  });
}
