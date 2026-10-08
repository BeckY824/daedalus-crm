/** 更新源及制品仅通过HTTPS获取；本机HTTP联调必须显式开启且仅限回环。 */
function 安全地址(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.href;
    if (process.env.CRM_UPDATE_ALLOW_LOCAL_HTTP === "1" && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.href;
  } catch { /* 不接受相对路径、其他协议或畸形地址 */ }
  return null;
}
function 规范哈希(value) {
  if (typeof value !== "string") return null;
  const hash = value.replace(/^sha256:/i, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}
function 拒绝(message) { const error = new Error(message); error.不重试 = true; return error; }
async function 安全获取(value, options = {}, fetcher = globalThis.fetch) {
  let url = 安全地址(value);
  if (!url) throw 拒绝("更新地址不安全，必须使用HTTPS");
  for (let i = 0; i <= 5; i++) {
    const response = await fetcher(url, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    let next = null;
    try { next = location ? 安全地址(new URL(location, url).href) : null; } catch {}
    await response.body?.cancel().catch(() => {});
    if (!next) throw 拒绝("更新重定向地址不安全，必须使用HTTPS");
    url = next;
  }
  throw 拒绝("更新地址重定向次数过多");
}
module.exports = { 安全地址, 规范哈希, 安全获取 };
