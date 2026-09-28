"use client";

import { memo } from "react";
import { Popover } from "antd";
import type { BriefRecord } from "@/lib/ai-draft";
import { splitCitations } from "@/lib/ai-draft";
import { 表格行, 无序行, 有序行, 切淡片, 块属性相等, type 块属性 } from "@/lib/stream-reveal";

/**
 * 够用就好的 Markdown：标题、无序/有序列表、表格、**加粗**、`行内代码`、段落，外加 [n] 引用圆标。
 * 不引第三方库。
 *
 * 表格是 2026-09-19 补的。原来的注释说「回答是我们自己的提示词约束出来的，不会出现表格」——
 * 换到 DeepSeek 之后它非常爱画表，一个渠道也画一张；提示词只能压住一部分，
 * 压不住的那部分不能让人看见一排竖线和 `|---|---|`。所以渲染器认表格，
 * 提示词那边只管「什么时候不该画」。
 */
export default function Markdown({ text, records = [] }: { text: string; records?: BriefRecord[] }) {
  const byN = new Map(records.map((r) => [r.n, r]));
  return <div className="md">{渲染块(text.replace(/\r/g, ""), byN)}</div>;
}

type 引用表 = Map<number, BriefRecord>;
const 不淡: readonly number[] = [];

/**
 * 流式回答里的一块（见 lib/stream-reveal.ts 的 切块）。文本、起点、淡入切点都没变就不重渲——
 * 前面写完的段落从此只渲一次，只有最后那块在长。
 */
export const MdBlock = memo(function MdBlock({ 文, 起, byN, 淡 }: 块属性 & { byN: 引用表 }) {
  return <>{渲染块(文, byN, 起, 淡)}</>;
}, 块属性相等);

/**
 * 解析 + 渲染。`起` 是这段文本在整段回答里的偏移，`淡` 是最近几截的起点（同一套偏移）：
 * 落在里面的字包一层 .md-in 淡进来。整段渲染时两个都是默认值，输出和原来逐字相同。
 * 文本里不能有 \r（调用方先去掉），否则偏移对不上。
 */
function 渲染块(text: string, byN: 引用表, 起 = 0, 淡: readonly number[] = 不淡): React.ReactNode[] {
  const lines = text.split("\n");
  const 行起: number[] = [];
  for (let i = 0, o = 起; i < lines.length; i++) {
    行起.push(o);
    o += lines[i].length + 1;
  }
  const out: React.ReactNode[] = [];
  let list: { kind: "ul" | "ol"; items: { text: string; n?: number; at: number }[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.kind;
    out.push(
      <Tag key={out.length} className="md-list">
        {list.items.map((it, i) => (
          // 有序列表被要点打断后再续上时，编号接着源文本走，不从 1 重来
          <li key={i} value={it.n}>
            <Inline text={it.text} byN={byN} 起={it.at} 淡={淡} />
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trimEnd();
    /** 一行里某个后缀（捕获组到行尾）在全文里的起点 */
    const 后缀起 = (suffix: string) => 行起[li] + line.length - suffix.length;
    /*
      表格：连续的以 | 开头的行。第二行是 |---|:--:| 那种分隔线就当表头，
      没有分隔线也照样渲染（模型漏写分隔线是常事，那时全部当正文行）。
    */
    if (表格行.test(line)) {
      flush();
      const 块: { l: string; at: number }[] = [];
      while (li < lines.length && 表格行.test(lines[li])) {
        块.push({ l: lines[li], at: 行起[li] });
        li++;
      }
      li--;
      const 是分隔 = (l: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l.trim());
      const 有表头 = 块.length >= 2 && 是分隔(块[1].l);
      const 表头 = 有表头 ? 切格(块[0].l, 块[0].at) : null;
      const 体 = (有表头 ? 块.slice(2) : 块).filter((r) => !是分隔(r.l)).map((r) => 切格(r.l, r.at));
      out.push(
        <div key={out.length} className="md-tw">
          <table className="md-table">
            {表头 && (
              <thead><tr>{表头.map((h, i) => <th key={i}><Inline text={h.文} byN={byN} 起={h.起} 淡={淡} /></th>)}</tr></thead>
            )}
            <tbody>
              {体.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c.文} byN={byN} 起={c.起} 淡={淡} /></td>)}</tr>)}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const ul = line.match(无序行);
    const ol = line.match(有序行);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flush();
        list = { kind, items: [] };
      }
      list.items.push(ul ? { text: ul[1], at: 后缀起(ul[1]) } : { text: ol![2], n: Number(ol![1]), at: 后缀起(ol![2]) });
      continue;
    }
    flush();
    // 空行和分隔线（---）都不占位
    if (!line.trim() || /^\s*[-*_]{3,}\s*$/.test(line)) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(
        <div key={out.length} className="md-h">
          <Inline text={h[2]} byN={byN} 起={后缀起(h[2])} 淡={淡} />
        </div>,
      );
      continue;
    }
    out.push(
      <p key={out.length} className="md-p">
        <Inline text={line} byN={byN} 起={行起[li]} 淡={淡} />
      </p>,
    );
  }
  flush();
  return out;
}

/**
 * 表格的一行切成格，每格带它在全文里的起点。
 * 切法和原来一样：去首尾空白、去掉首尾各一个 |、按 | 切、每格去空白。
 */
function 切格(raw: string, 行起: number): { 文: string; 起: number }[] {
  let t = raw.trim();
  let o = 行起 + raw.length - raw.trimStart().length;
  if (t.startsWith("|")) {
    t = t.slice(1);
    o++;
  }
  if (t.endsWith("|")) t = t.slice(0, -1);
  const out: { 文: string; 起: number }[] = [];
  let p = 0;
  for (const part of t.split("|")) {
    out.push({ 文: part.trim(), 起: o + p + part.length - part.trimStart().length });
    p += part.length + 1;
  }
  return out;
}

/** 一段纯文本：没有刚到的字就原样返回字符串；有就把刚到的那几截各包一个 .md-in */
function 淡入(文: string, 起: number, 淡: readonly number[]): React.ReactNode {
  if (淡.length === 0 || 起 + 文.length <= 淡[0]) return 文;
  return 切淡片(起, 文.length, 淡).map((p) =>
    p.新 ? (
      <span key={p.起} className="md-in">
        {文.slice(p.起 - 起, p.止 - 起)}
      </span>
    ) : (
      文.slice(p.起 - 起, p.止 - 起)
    ),
  );
}

function Inline({ text, byN, 起, 淡 }: { text: string; byN: 引用表; 起: number; 淡: readonly number[] }) {
  // 先切加粗和行内代码，再在每段里切引用。代码段里的东西原样给，不再找引用
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  const 各起: number[] = [];
  for (let i = 0, o = 起; i < parts.length; i++) {
    各起.push(o);
    o += parts[i].length;
  }
  return (
    <>
      {parts.map((p, i) => {
        const code = p.match(/^`([^`]+)`$/);
        if (code) return <code key={i} className="md-code">{淡入(code[1], 各起[i] + 1, 淡)}</code>;
        const bold = p.match(/^\*\*([^*]+)\*\*$/);
        const inner = bold ? bold[1] : p;
        const 内起 = 各起[i] + (bold ? 2 : 0);
        // 引用 [n] 在原文里占几个字不固定（[1] / [12]），顺着找它的右括号
        let c = 0;
        const nodes = splitCitations(inner).map((seg, j) => {
          if (typeof seg === "number") {
            c = inner.indexOf("]", c) + 1;
            return <Cite key={j} n={seg} r={byN.get(seg)} />;
          }
          const at = 内起 + c;
          c += seg.length;
          return <span key={j}>{淡入(seg, at, 淡)}</span>;
        });
        return bold ? <strong key={i}>{nodes}</strong> : <span key={i}>{nodes}</span>;
      })}
    </>
  );
}

function Cite({ n, r }: { n: number; r?: BriefRecord }) {
  if (!r) return <span className="cite cite-dead">{n}</span>;
  return (
    <Popover
      placement="top"
      content={
        <div style={{ maxWidth: 320, fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
            {r.date} · {r.label}
          </div>
          <div style={{ whiteSpace: "pre-wrap", color: "var(--ink-soft)" }}>{r.excerpt}</div>
        </div>
      }
    >
      <span className="cite">{n}</span>
    </Popover>
  );
}
