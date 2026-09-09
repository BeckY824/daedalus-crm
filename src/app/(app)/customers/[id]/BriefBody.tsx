"use client";

import { Typography, Space, Tag, Popover } from "antd";
import { motion } from "motion/react";
import type { CustomerBrief, BriefRecord } from "@/lib/ai-draft";
import { splitCitations } from "@/lib/ai-draft";

const fade = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.28 } } };

/**
 * 临战简报的正文：故事线 / 当前局面 / 建议谈 / 风险。弹窗、首页提问、记录页共用。
 * 句末的 [n] 是模型标的依据编号：渲染成小圆标，悬停看那条记录的摘录；
 * 在记录页上点一下会滚到时间线里的那条（元素 id 为 fu-<记录 id>）。
 */
export default function BriefBody({ brief, records = [] }: { brief: CustomerBrief; records?: BriefRecord[] }) {
  const byN = new Map(records.map((r) => [r.n, r]));
  return (
    <motion.div className="brief" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }}>
      <Section title="故事线">
        <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.story}</Typography.Paragraph>
      </Section>
      {brief.current && (
        <Section title="当前局面">
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            <Rich text={brief.current} byN={byN} />
          </Typography.Paragraph>
        </Section>
      )}
      {brief.talkingPoints.length > 0 && (
        <Section title="这次建议谈">
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
            {brief.talkingPoints.map((p, i) => (
              <li key={i}>
                <Rich text={p} byN={byN} />
              </li>
            ))}
          </ol>
        </Section>
      )}
      {brief.risks.length > 0 && (
        <Section title="风险提示">
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            {brief.risks.map((r, i) => (
              <Tag key={i} color="warning" style={{ whiteSpace: "normal", padding: "4px 10px", margin: 0 }}>
                <Rich text={r} byN={byN} />
              </Tag>
            ))}
          </Space>
        </Section>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        由 AI 基于系统内跟进记录生成，只起草，不落库{records.length ? "；圆标是它引用的记录" : ""}。
      </Typography.Text>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.div variants={fade} className="brief-sec">
      <div className="stat-label" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </motion.div>
  );
}

/** 正文 + 引用圆标 */
function Rich({ text, byN }: { text: string; byN: Map<number, BriefRecord> }) {
  return (
    <>
      {splitCitations(text).map((part, i) => (typeof part === "number" ? <Cite key={i} r={byN.get(part)} n={part} /> : <span key={i}>{part}</span>))}
    </>
  );
}

function Cite({ r, n }: { r?: BriefRecord; n: number }) {
  if (!r) return null;
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
      <span
        className="cite"
        onClick={() => {
          const el = document.getElementById(`fu-${r.id}`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("rec-tl-item-flash");
            setTimeout(() => el.classList.remove("rec-tl-item-flash"), 1600);
          }
        }}
      >
        {n}
      </span>
    </Popover>
  );
}
