/**
 * 流式回答的出字：放字节奏 + 段落切分。全是纯函数，渲染在 components/StreamMarkdown.tsx。
 *
 * 两件事：
 *
 * 1. **放字节奏。** 模型吐字是一阵一阵的：停半秒、一下来二十个字、再停。原样贴上去读着是跳的。
 *    这里把「到了多少」和「放出来多少」分开：每次文本变长记一个到达点，
 *    每 28ms 最多放一块（一块 = 一次到达），积压多了一拍放好几块追上去；
 *    流一结束剩下的一次放完。所以**只会比模型晚几拍，绝不会比模型慢**——
 *    整段答完的那一刻，字也全出来了。
 *
 * 2. **段落切分。** 原来每来一个 token 就把整段回答重新解析一遍，3000 字的回答
 *    要解析六百遍、每遍都是全文。按「块」切开之后，前面的块文本不再变，
 *    memo 住就不用再渲；只有最后一两块在长。
 *    切的规矩必须和 Markdown.tsx 的解析一致：列表和表格是连续多行一组，
 *    其余每行各自独立——所以正则放在这里，两边共用一份。
 */

/** 表格行：以 | 开头 */
export const 表格行 = /^\s*\|/;
/** 无序列表项 */
export const 无序行 = /^\s*[-*•]\s+(.*)$/;
/** 有序列表项（1. / 1、 / 1)） */
export const 有序行 = /^\s*(\d+)[.、)]\s+(.*)$/;

/** 有积压时两次放字至少隔这么久 */
export const 放字间隔 = 28;
/**
 * 新放出来的一截在这段时间里算「刚到」，渲染时包一层淡入 span；过了就并回普通文本，
 * 免得一段长回答挂着几百个 span。比淡入本身（--t，160–180ms）长一截，留足余量。
 */
export const 淡入窗口 = 400;

export type 一截 = { 起: number; 时: number };

export type 出字状态 = {
  /** 已经到达的全文 */
  目标: string;
  /** 放出来了多少 */
  显示长: number;
  /** 还没放的到达点：每次文本变长记一个，值是那一刻的总长。升序 */
  待放: readonly number[];
  /** 最近放出去的几截（起点 + 时刻），给淡入用。升序、首尾相接，最后一截止于 显示长 */
  最近: readonly 一截[];
  /** 上一次放字的时刻；-Infinity = 还没放过 */
  上次放: number;
};

const 无: readonly never[] = Object.freeze([]);

/**
 * 起一个出字器。
 * 流着的时候从零开始：第一次到的那截也要淡进来。
 * 不在流（翻出来的历史、答完了才挂上的组件）就直接全显示，不演一遍。
 */
export function 起出字(目标: string, 流着: boolean): 出字状态 {
  if (!流着 || !目标) return { 目标, 显示长: 目标.length, 待放: 无, 最近: 无, 上次放: -Infinity };
  return { 目标, 显示长: 0, 待放: [目标.length], 最近: 无, 上次放: -Infinity };
}

/** 两个字符串的公共前缀长 */
function 公共前缀(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * 文本变了。
 *
 * 正常情况是在后面接了一截：记一个到达点。
 * 不是接在后面的（服务端发了 reset，把刚才那段抹掉重答）：退回公共前缀，
 * 已经放出来但被抹掉的那部分立刻收回，别让作废的字多停一拍。
 */
export function 收到(s: 出字状态, 新: string): 出字状态 {
  if (新 === s.目标) return s;
  if (新.startsWith(s.目标)) return { ...s, 目标: 新, 待放: [...s.待放, 新.length] };
  const 前 = 公共前缀(s.目标, 新);
  const 显示长 = Math.min(s.显示长, 前);
  const 待放 = 新.length > 显示长 ? [新.length] : 无;
  const 最近 = s.最近.filter((c) => c.起 < 显示长);
  return { 目标: 新, 显示长, 待放, 最近, 上次放: s.上次放 };
}

/**
 * 这一拍放几块。积压不多就一块一块放（读起来最连续）；
 * 积压多了按三分之一追——稳态下最多落后三拍左右（~84ms），不会越拖越远。
 */
export function 放几块(排队: number): number {
  if (排队 <= 0) return 0;
  if (排队 <= 3) return 1;
  return Math.ceil(排队 / 3);
}

/** 把过了淡入窗口的那几截摘掉。没东西可摘就原样返回（让 React 认得出「没变」） */
function 摘旧(最近: readonly 一截[], 现在: number): readonly 一截[] {
  let i = 0;
  while (i < 最近.length && 现在 - 最近[i].时 >= 淡入窗口) i++;
  return i === 0 ? 最近 : 最近.slice(i);
}

/**
 * 走一拍（每一帧调一次）。没到 28ms 或者没有积压就不放。什么都没变返回同一个对象。
 *
 * 过期的淡入截要摘，但**还有积压时不单独摘**：下一次放字（最多 28ms 后）顺手摘掉，
 * 省得放字之间的空帧再多一次重渲。没有积压了才单独摘。
 */
export function 走一拍(s: 出字状态, 现在: number): 出字状态 {
  if (s.待放.length === 0 || 现在 - s.上次放 < 放字间隔) {
    if (s.待放.length > 0) return s;
    const 最近 = 摘旧(s.最近, 现在);
    return 最近 === s.最近 ? s : { ...s, 最近 };
  }
  const 最近 = 摘旧(s.最近, 现在);
  const k = 放几块(s.待放.length);
  const 止 = s.待放[k - 1];
  return { ...s, 显示长: 止, 待放: s.待放.slice(k), 最近: [...最近, { 起: s.显示长, 时: 现在 }], 上次放: 现在 };
}

/** 流结束：剩下的一次放完（作为一截，照样淡入） */
export function 放完(s: 出字状态, 现在: number): 出字状态 {
  if (s.显示长 >= s.目标.length) return s.待放.length ? { ...s, 待放: 无 } : s;
  return { ...s, 显示长: s.目标.length, 待放: 无, 最近: [...摘旧(s.最近, 现在), { 起: s.显示长, 时: 现在 }], 上次放: 现在 };
}

/** 还要不要接着走帧：有积压，或者还有淡入截没摘（摘掉那一下要重渲一次，把 span 并回文本） */
export function 还在动(s: 出字状态): boolean {
  return s.待放.length > 0 || s.最近.length > 0;
}

/* ---------------- 段落切分 ---------------- */

type 行类 = "表" | "ul" | "ol" | null;

/** 和 Markdown.tsx 的判断顺序一致：先表格，再无序，再有序；其余（段落、标题、空行、分隔线）各自独立 */
function 认行(line: string): 行类 {
  const l = line.trimEnd();
  if (表格行.test(l)) return "表";
  if (无序行.test(l)) return "ul";
  if (有序行.test(l)) return "ol";
  return null;
}

export type 块 = { 起: number; 文: string };

/**
 * 把（已经放出来的）文本切成块。每块单独交给 Markdown 渲染，拼起来和整段渲染逐字相同。
 *
 * - 连续的同类列表行 / 表格行是一块；其余每行一块（空行跳过，它本来就不渲染）
 * - 最后那行还没写完（后面没有换行）：它和前一组同类就并进去，不同类就自己一块。
 *   它现在像不像列表不作数，下一个字可能就变了——但变了也只是这一小截重挂，前面不动
 *
 * 块的「起」是它在全文里的偏移，拿来当 React key：前面的文本不会变，起点就不会变，
 * 同一块在一次次重渲之间始终是同一个组件，文本没变就被 memo 挡住。
 */
export function 切块(text: string): 块[] {
  const out: 块[] = [];
  const lines = text.split("\n");
  let o = 0;
  let 组: { 起: number; 行: string[]; 类: 行类 } | null = null;
  const 收 = () => {
    if (组) out.push({ 起: 组.起, 文: 组.行.join("\n") });
    组 = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const 类 = 认行(line);
    if (组 && 类 !== null && 组.类 === 类) {
      组.行.push(line);
    } else {
      收();
      if (line.trim() || 类 !== null) 组 = { 起: o, 行: [line], 类 };
    }
    // 独立的行一行一块，不和下一行合
    if (类 === null) 收();
    o += line.length + 1;
  }
  收();
  return out;
}

export type 块属性 = { 起: number; 文: string; 淡: readonly number[] };

/**
 * 每一块的属性：文本、起点，以及这一块里「刚到」的那几截从哪开始。
 *
 * 淡 = 全文里最近几截的起点（升序，首尾相接直到文本末尾）。落到一块上时：
 * 最早那截若早于块起点，就记成块起点本身（整块都算新的）；块里的切点照记；
 * 整块都比最早那截还旧，就是空数组——memo 靠这个认出「这块不用重渲」。
 */
export function 块们(text: string, 淡: readonly number[]): 块属性[] {
  return 切块(text).map((b) => {
    const 止 = b.起 + b.文.length;
    if (淡.length === 0 || 淡[0] >= 止) return { ...b, 淡: 无 };
    const 里 = 淡.filter((f) => f > b.起 && f < 止);
    return { ...b, 淡: 淡[0] <= b.起 ? [b.起, ...里] : 里 };
  });
}

export function 同淡(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** memo 的比较：文本、起点、淡入切点按值比，引用表按引用比 */
export function 块属性相等<T extends 块属性 & { byN: unknown }>(a: T, b: T): boolean {
  return a.文 === b.文 && a.起 === b.起 && a.byN === b.byN && 同淡(a.淡, b.淡);
}

export type 片 = { 起: number; 止: number; 新: boolean };

/**
 * 一段纯文本 [起, 起+长) 按淡入切点切成片。比最早那截还旧的部分是一整片旧的
 * （渲染成普通文本），之后每截一片、带淡入。片的「起」当 key：一片从出现到并回文本
 * 始终是同一个 span，所以淡入只演一次，不会每来一个字从头再演。
 */
export function 切淡片(起: number, 长: number, 淡: readonly number[]): 片[] {
  const 止 = 起 + 长;
  if (长 === 0) return [];
  if (淡.length === 0 || 淡[0] >= 止) return [{ 起, 止, 新: false }];
  const 点 = [起, ...淡.filter((f) => f > 起 && f < 止), 止];
  const out: 片[] = [];
  for (let i = 0; i < 点.length - 1; i++) out.push({ 起: 点[i], 止: 点[i + 1], 新: 点[i] >= 淡[0] });
  return out;
}
