"use client";

import { Typography, Space, Tag } from "antd";
import type { CustomerBrief } from "@/lib/ai-draft";

/** 临战简报的正文：故事线 / 当前局面 / 建议谈 / 风险。弹窗与首页提问共用 */
export default function BriefBody({ brief }: { brief: CustomerBrief }) {
  return (
    <div style={{ paddingTop: 4 }}>
      <Section title="故事线">
        <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.story}</Typography.Paragraph>
      </Section>
      {brief.current && (
        <Section title="当前局面">
          <Typography.Paragraph style={{ marginBottom: 0 }}>{brief.current}</Typography.Paragraph>
        </Section>
      )}
      {brief.talkingPoints.length > 0 && (
        <Section title="这次建议谈">
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
            {brief.talkingPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </Section>
      )}
      {brief.risks.length > 0 && (
        <Section title="风险提示">
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            {brief.risks.map((r, i) => (
              <Tag key={i} color="warning" style={{ whiteSpace: "normal", padding: "4px 10px", margin: 0 }}>
                {r}
              </Tag>
            ))}
          </Space>
        </Section>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        由 AI 基于系统内跟进记录生成，仅供参考，请以实际沟通为准。
      </Typography.Text>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="stat-label" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
