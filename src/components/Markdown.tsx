"use client";

import { Popover } from "antd";
import type { BriefRecord } from "@/lib/ai-draft";
import { splitCitations } from "@/lib/ai-draft";

/**
 * 够用就好的 Markdown：标题、无序/有序列表、**加粗**、段落，外加 [n] 引用圆标。
 * 不引第三方库——回答是我们自己的提示词约束出来的，不会出现表格、代码块这类东西。
 */
export default function Markdown({ text, records = [] }: { text: string; records?: BriefRecord[] }) {
  const byN = new Map(records.map((r) => [r.n, r]));
  const lines = text.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.kind;
    out.push(
      <Tag key={out.length} className="md-list">
        {list.items.map((it, i) => (
          <li key={i}>
            <Inline text={it} byN={byN} />
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        flush();
        list = { kind, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
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
  // 先切加粗，再在每段里切引用
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
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
          <div style={{ color: "#6b7280", marginBottom: 4 }}>
            {r.date} · {r.label}
          </div>
          <div style={{ whiteSpace: "pre-wrap", color: "#1f2937" }}>{r.excerpt}</div>
        </div>
      }
    >
      <span className="cite">{n}</span>
    </Popover>
  );
}
