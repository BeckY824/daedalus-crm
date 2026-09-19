"use client";

import { Popover } from "antd";
import type { BriefRecord } from "@/lib/ai-draft";
import { splitCitations } from "@/lib/ai-draft";

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
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let list: { kind: "ul" | "ol"; items: { text: string; n?: number }[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.kind;
    out.push(
      <Tag key={out.length} className="md-list">
        {list.items.map((it, i) => (
          // 有序列表被要点打断后再续上时，编号接着源文本走，不从 1 重来
          <li key={i} value={it.n}>
            <Inline text={it.text} byN={byN} />
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trimEnd();
    /*
      表格：连续的以 | 开头的行。第二行是 |---|:--:| 那种分隔线就当表头，
      没有分隔线也照样渲染（模型漏写分隔线是常事，那时全部当正文行）。
    */
    if (/^\s*\|/.test(line)) {
      flush();
      const 块: string[] = [];
      while (li < lines.length && /^\s*\|/.test(lines[li])) {
        块.push(lines[li].trim());
        li++;
      }
      li--;
      const 切 = (l: string) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const 是分隔 = (l: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
      const 有表头 = 块.length >= 2 && 是分隔(块[1]);
      const 表头 = 有表头 ? 切(块[0]) : null;
      const 体 = (有表头 ? 块.slice(2) : 块).filter((l) => !是分隔(l)).map(切);
      out.push(
        <div key={out.length} className="md-tw">
          <table className="md-table">
            {表头 && (
              <thead><tr>{表头.map((h, i) => <th key={i}><Inline text={h} byN={byN} /></th>)}</tr></thead>
            )}
            <tbody>
              {体.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c} byN={byN} /></td>)}</tr>)}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flush();
        list = { kind, items: [] };
      }
      list.items.push(ul ? { text: ul[1] } : { text: ol![2], n: Number(ol![1]) });
      continue;
    }
    flush();
    // 空行和分隔线（---）都不占位
    if (!line.trim() || /^\s*[-*_]{3,}\s*$/.test(line)) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(
        <div key={out.length} className="md-h">
          <Inline text={h[2]} byN={byN} />
        </div>,
      );
      continue;
    }
    out.push(
      <p key={out.length} className="md-p">
        <Inline text={line} byN={byN} />
      </p>,
    );
  }
  flush();
  return <div className="md">{out}</div>;
}

function Inline({ text, byN }: { text: string; byN: Map<number, BriefRecord> }) {
  // 先切加粗和行内代码，再在每段里切引用。代码段里的东西原样给，不再找引用
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        const code = p.match(/^`([^`]+)`$/);
        if (code) return <code key={i} className="md-code">{code[1]}</code>;
        const bold = p.match(/^\*\*([^*]+)\*\*$/);
        const inner = bold ? bold[1] : p;
        const nodes = splitCitations(inner).map((seg, j) => (typeof seg === "number" ? <Cite key={j} n={seg} r={byN.get(seg)} /> : <span key={j}>{seg}</span>));
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
