/**
 * 手机伴侣 /m 的 e2e 造数据：不走登录 + 电脑授权那条链路（那要真云端），
 * 先开一次 /m 让页面建好本地库和行钥匙，再照 lib/mobile/store.ts 的格式把「已经连上团队」的状态灌进 IndexedDB，刷新就进主界面。
 * 网页模式下没有中转（/api/sync/scoped 回 404），同步一直失败——灌进去的数据不会被当成登录失效清掉。
 */
import { expect, type Page } from "@playwright/test";

export type 种子行 = { t: string; k: string; r: Record<string, unknown> };
export type 灌手机选项 = {
  /** 本人（User 行的 id），默认 acct_li */
  我?: string;
  我名?: string;
  团队名?: string;
  账号?: { name: string; contact: string };
  /** 业务设置（Setting:business 的 value），不给就是外贸 + USD */
  业务?: Record<string, unknown>;
  行们?: 种子行[];
  /** 同步状态里的「被拒」那几条（没同步上的列表） */
  被拒?: { 改动: Record<string, unknown>; 原因: string }[];
};

export const 外贸来源 = ["阿里国际站", "独立站询盘", "谷歌搜索", "展会获取", "WhatsApp", "邮件开发", "领英", "老客户返单", "转介绍", "其他"];

export async function 灌手机(page: Page, 选项: 灌手机选项 = {}) {
  const 我 = 选项.我 ?? "acct_li";
  await page.goto("/m");
  await expect(page.getByRole("button", { name: /登录/ }).first()).toBeVisible();
  await page.evaluate(async (a) => {
    const 开 = () => new Promise<IDBDatabase>((ok, bad) => { const r = indexedDB.open("daedalus-mobile", 1); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const 等 = <T,>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const db = await 开();
    const 钥 = await 等(db.transaction("kv").objectStore("kv").get("rowKey")) as CryptoKey;
    const 钟 = `${String(1760000000000).padStart(15, "0")}-seed`;
    const 行们 = [
      { t: "User", k: a.我, r: { id: a.我, name: a.我名, email: "li@e2e.local", active: true } },
      { t: "Setting", k: "business", r: { key: "business", value: JSON.stringify(a.业务) } },
      ...a.行们,
    ];
    const 密的 = [];
    for (const x of 行们) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const 钟们 = Object.fromEntries(Object.keys(x.r).map((k) => [k, 钟]));
      密的.push([`${x.t}:${x.k}`, { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, 钥, new TextEncoder().encode(JSON.stringify({ ...x, 钟: 钟们 }))) }] as const);
    }
    const t = db.transaction(["rows", "kv"], "readwrite");
    for (const [k, v] of 密的) t.objectStore("rows").put(v, k);
    t.objectStore("kv").put("dk_e2e_fake_token", "token");
    t.objectStore("kv").put({ teamId: "t_e2e", device: "m_e2e", key: "A".repeat(43), epoch: 0, keys: {}, userId: a.我, 私钥: { raw: new Uint8Array(32) } }, "team");
    t.objectStore("kv").put(a.账号, "account");
    t.objectStore("kv").put(a.团队名, "teamName");
    if (a.被拒.length) t.objectStore("kv").put({ cursors: {}, 待推: [], 被拒: a.被拒, 钟: 0, skipped: 0 }, "state");
    await new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); });
    db.close();
  }, {
    我, 我名: 选项.我名 ?? "李娜", 团队名: 选项.团队名 ?? "E2E 团队", 账号: 选项.账号 ?? { name: "李娜", contact: "li@e2e.local" },
    业务: 选项.业务 ?? { template: "trade", currency: "USD", customer: "客户", sources: 外贸来源 },
    行们: 选项.行们 ?? [], 被拒: 选项.被拒 ?? [],
  });
  await page.reload();
}
