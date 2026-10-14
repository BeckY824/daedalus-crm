/**
 * 把 DeepSeek 当正文吐回来的工具调用（DSML 标记）认回成标准的 tool_calls。
 *
 * 2026-09-28 用户在桌面端碰到的：说「明天去李文龙那边交付」，它回「你在卡片上确认一下」，
 * 可屏幕上没有卡片；再问，屏幕上出来一串 `<｜｜DSML｜｜ calls>…invoke name="find_person"…`。
 * 桌面端日志里决策那几步全是「没调工具」——模型其实调了，只是中转站没把它原生的
 * DSML 标记转成 OpenAI 格式的 `tool_calls`，原样塞在 `content` 里交回来。
 * 我们只认 `tool_calls` 字段，于是当它没调，工具没跑、卡片没出，回答时它还以为卡片出了。
 *
 * 标准写法和中转站吐回来的写法都认（竖线可能是全角「｜」也可能叠成两个，`function_calls` 可能只剩 `calls`）：
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="find_person">
 *   <｜DSML｜parameter name="name" string="true">李文龙</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * `string="true"` 的参数原样当字符串；`string="false"` 或没写的按 JSON 解（数字、布尔、对象），解不了还当字符串。
 * 只认给了名单的工具：不在名单里的丢掉（交回去它也调不成，还会让「没调工具」看起来像调了）。
 * 没有收尾标签的半截调用不认——参数可能缺了一半，宁可当没调。
 */
import type { 工具调用 } from "./llm";

/** DSML 标签的开头：`<`、可选的 `/`、任意个全角/半角竖线和空白、DSML、再一串竖线和空白 */
const 头 = String.raw`<\s*[｜|]*\s*DSML\s*[｜|]*\s*`;
const 尾头 = String.raw`<\/\s*[｜|]*\s*DSML\s*[｜|]*\s*`;
const 调用块 = new RegExp(`${头}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)${尾头}invoke\\s*>`, "g");
const 参数块 = new RegExp(`${头}parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)${尾头}parameter\\s*>`, "g");
/** 任何一个 DSML 标签（包括 function_calls / calls 的外壳，和没收尾的残片） */
const 任意标签 = /<\s*\/?\s*[｜|]*\s*DSML[^>]*>/g;

export const 有DSML = (text: string) => /DSML/.test(text);

function 参数值(原文: string, 属性: string): unknown {
  if (/string\s*=\s*"true"/.test(属性)) return 原文;
  const t = 原文.trim();
  try {
    return JSON.parse(t);
  } catch {
    return 原文;
  }
}

/**
 * 从一段正文里认出 DSML 工具调用。返回认出来的调用（按出现顺序）和去掉标记之后剩下的正文。
 * 一个都认不出来时 调用 为空，余下 是原文去掉 DSML 标签后的样子（给上层判断还有没有人话）。
 */
export function 解析DSML(text: string, 允许?: Iterable<string>): { 调用: 工具调用[]; 余下: string } {
  const 名单 = 允许 ? new Set(允许) : null;
  const 调用: 工具调用[] = [];
  for (const m of text.matchAll(调用块)) {
    const 名 = m[1].trim();
    if (名单 && !名单.has(名)) continue;
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(参数块)) args[p[1].trim()] = 参数值(p[3], p[2]);
    调用.push({ id: `dsml_${Date.now().toString(36)}_${调用.length}`, type: "function", function: { name: 名, arguments: JSON.stringify(args) } });
  }
  // 先移除完整调用，再丢弃半截调用及其参数正文；只删标签会把参数冒充人话。
  const 去完整 = text.replace(调用块, "");
  const 半截 = new RegExp(`${头}(?:invoke|parameter)\\b|<\\s*[｜|]*\\s*DSML[^>]*$`);
  const 起点 = 去完整.search(半截);
  const 余下 = (起点 < 0 ? 去完整 : 去完整.slice(0, 起点)).replace(任意标签, "").trim();
  return { 调用, 余下 };
}
