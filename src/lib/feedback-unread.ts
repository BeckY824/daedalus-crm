/**
 * 「我的反馈」的几样纯规则：串长什么样、哪条算没看过、提醒里那一句怎么截。
 * 云端（lib/feedback-thread.ts）、桌面端本地服务（lib/desktop/feedback.ts）、页面三处都用，所以不引任何库。
 * tests/feedback-thread.test.ts 钉着。
 */

/** 串里的一条。谁：我 = 用户自己（原话不在这里，在 我的一条反馈.body），团队 = 我们回的 */
export type 串里一条 = { id: string; at: string; 谁: "我" | "团队"; body: string };

export type 我的一条反馈 = { id: string; at: string; body: string; 消息: 串里一条[] };

/** 本机记着的已读：反馈 id → 看过的最后一条回复的 id */
export type 已读表 = Record<string, string>;

/** 页面拿到的一条：多了「有没有没看过的回复」 */
export type 带未读的反馈 = 我的一条反馈 & { 未读: boolean };

/** 这条反馈里我们最后回的那一条 */
export function 最后一条回复(f: 我的一条反馈): 串里一条 | null {
  for (let i = f.消息.length - 1; i >= 0; i--) if (f.消息[i].谁 === "团队") return f.消息[i];
  return null;
}

/**
 * 有没有没看过的：我们最后回的那一条，不是本机记着看过的那一条。
 * 用户自己接着说了一句之后，前面的回复显然看过了——最后一条是他的，就不算未读。
 */
export function 算未读(f: 我的一条反馈, 已读: 已读表): boolean {
  const 回 = 最后一条回复(f);
  if (!回) return false;
  if (f.消息[f.消息.length - 1].谁 === "我") return false;
  return 已读[f.id] !== 回.id;
}

/** 列表按最近一次往来排，最新的在上：刚回了一句的那条老反馈要顶上来 */
export function 最近(f: 我的一条反馈): string {
  return f.消息.length ? f.消息[f.消息.length - 1].at : f.at;
}

export function 排好(列: 带未读的反馈[]): 带未读的反馈[] {
  return [...列].sort((a, b) => 最近(b).localeCompare(最近(a)) || b.id.localeCompare(a.id));
}

/** 压成一行再截：系统通知、列表第一行、轻提示都用它 */
export function 一句(s: string, n = 40): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  const 字 = [...t]; // 按码点截：emoji 不被拦腰切成半个
  return 字.length > n ? `${字.slice(0, n - 1).join("")}…` : t;
}

/** 原话第一行（列表、对话头用）：空行跳过 */
export function 第一行(s: string): string {
  return (String(s ?? "").split("\n").find((l) => l.trim()) ?? "").trim();
}

/** 把云端回来的东西规整一遍：缺字段的丢掉。老服务端、坏数据不该让页面出错 */
export function 规整反馈(x: unknown): 我的一条反馈[] {
  if (!Array.isArray(x)) return [];
  const 出: 我的一条反馈[] = [];
  for (const f of x) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.at !== "string" || typeof o.body !== "string") continue;
    const 消息 = (Array.isArray(o.消息) ? o.消息 : [])
      .filter((m): m is 串里一条 => !!m && typeof m === "object" && typeof m.id === "string" && typeof m.at === "string" && typeof m.body === "string" && (m.谁 === "我" || m.谁 === "团队"))
      .map((m) => ({ id: m.id, at: m.at, 谁: m.谁, body: m.body }));
    出.push({ id: o.id, at: o.at, body: o.body, 消息 });
  }
  return 出;
}
