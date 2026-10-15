/**
 * 规范串：键按字母排序的 JSON。v4 范围同步拿它算外层元数据的摘要、算事件编号（见 crypto.ts）。
 * 单独放一个不依赖 node: 模块的文件：手机端（浏览器，crypto-web.ts）和桌面端要算出一模一样的串，只能共用这一份。
 */
export function 规范串(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(规范串).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${规范串((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x ?? null);
}
