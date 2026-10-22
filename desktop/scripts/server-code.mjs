#!/usr/bin/env node
/**
 * 生成「专属服务器码」：发给专属客户，粘进登录页的「使用专属服务器」就连上那台服务器。
 *
 *   node desktop/scripts/server-code.mjs https://cn.example.com "Even 专属"
 *
 * 码 = "DCRM-" + base64url(JSON {u: 地址, n: 名字})，和 src/lib/desktop/dedicated-server.ts 的 编码服务器码 同一个格式。
 * 码里没有任何口令，只是把地址包一层、免得客户抄错；客户直接填地址也一样能连。
 * 生成前先问一声那台服务器的 /api/account/policy，问不到就不出码——别把一个连不上的码发出去。
 */
const [地址, 名字 = ""] = process.argv.slice(2);
if (!地址) {
  console.error("用法：node desktop/scripts/server-code.mjs <服务器地址> [名字]");
  process.exit(2);
}
const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(地址) ? 地址 : `https://${地址}`);
const url = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
try {
  const r = await fetch(`${url}/api/account/policy`, { signal: AbortSignal.timeout(15_000) });
  const d = await r.json().catch(() => null);
  if (!r.ok || typeof d?.register !== "boolean") throw new Error(`回了 ${r.status}，不像 Daedalus CRM 的服务器`);
} catch (e) {
  console.error(`${url} 认不过：${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.log("DCRM-" + Buffer.from(JSON.stringify({ u: url, n: 名字.trim().slice(0, 40) })).toString("base64url"));
