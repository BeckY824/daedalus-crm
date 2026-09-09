"use client";

import Link from "next/link";
import { Card, Row, Col, Table, Button, Space, Typography, App, Empty } from "antd";
import { RadarChartOutlined, ThunderboltOutlined, CopyOutlined } from "@ant-design/icons";
import type { TopReferrer, InviteCandidate } from "@/lib/referral";
import { money } from "@/lib/utils";
import { draftInvite } from "./ai";
import { useBusiness } from "@/lib/business-client";
import { runJob, useJob } from "@/lib/ai-jobs";

/**
 * 转介绍雷达：左边是谁在帮我们带人，右边是下一个该请谁开口。
 * 「起草邀请」生成微信话术草稿，由销售自己复制发出。
 */
export default function ReferralRadar({
  topReferrers,
  inviteCandidates,
  aiEnabled,
}: {
  topReferrers: TopReferrer[];
  inviteCandidates: InviteCandidate[];
  aiEnabled: boolean;
}) {
  const { message } = App.useApp();
  const b = useBusiness();
  // 话术挂在进程内任务表上（ai-jobs）：切走再回来，转圈和结果都还在；key 与记录页共用
  function draft(c: InviteCandidate) {
    runJob(`draft:invite:${c.customerId}`, async () => {
      const res = await draftInvite({ customerId: c.customerId });
      if (!res.ok) message.error(res.error);
      return res.ok ? { ok: true, value: res.message } : res;
    });
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    message.success(`已复制，去微信发给${b.customer}吧`);
  }

  const emptyNode = (text: string) => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;

  return (
    <Card
      style={{ marginTop: 16 }}
      title={
        <Space size={8}>
          <RadarChartOutlined style={{ color: "#1668dc" }} />
          <span className="section-title">转介绍雷达</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            只看{b.customer}之间的直接推荐
          </Typography.Text>
        </Space>
      }
    >
      <Row gutter={[24, 16]}>
        <Col xs={24} xl={12}>
          <div className="stat-label" style={{ marginBottom: 8 }}>推荐榜 · 谁在帮我们带人</div>
          {topReferrers.length === 0 ? (
            emptyNode(`还没有${b.customer}推荐过别人`)
          ) : (
            <Table
              size="small"
              rowKey="customerId"
              dataSource={topReferrers}
              pagination={false}
              columns={[
                {
                  title: "推荐人",
                  dataIndex: "name",
                  render: (v, r) => <Link href={`/customers/${r.customerId}`} className="link-strong">{v}</Link>,
                },
                { title: "推荐人数", dataIndex: "referralCount", width: 100 },
                { title: "其中签约", dataIndex: "signedCount", width: 100 },
                { title: "带来签约额", dataIndex: "downstreamAmount", width: 130, render: (v) => money(v) },
              ]}
            />
          )}
        </Col>
        <Col xs={24} xl={12}>
          <div className="stat-label" style={{ marginBottom: 8 }}>建议邀请 · 下一个该请谁开口</div>
          {inviteCandidates.length === 0 ? (
            emptyNode(`已签约的${b.customer}都请过了`)
          ) : (
            inviteCandidates.map((c) => <InviteRow key={c.customerId} c={c} aiEnabled={aiEnabled} onDraft={() => draft(c)} onCopy={copy} />)
          )}
        </Col>
      </Row>
    </Card>
  );
}

/** 单行拆成组件，各自订阅自己的邀请话术任务 */
function InviteRow({ c, aiEnabled, onDraft, onCopy }: { c: InviteCandidate; aiEnabled: boolean; onDraft: () => void; onCopy: (t: string) => void }) {
  const job = useJob<string>(`draft:invite:${c.customerId}`);
  const text = job?.status === "done" ? job.value : undefined;
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px dashed #eef2f7" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Link href={`/customers/${c.customerId}`} className="link-strong" style={{ fontSize: 15, fontWeight: 500 }}>
          {c.name}
        </Link>
        <span style={{ flex: 1, minWidth: 160, color: "#64748b", fontSize: 14 }}>{c.reason}</span>
        {aiEnabled && !text && (
          <Button size="small" icon={<ThunderboltOutlined />} loading={job?.status === "loading"} onClick={onDraft}>
            起草邀请
          </Button>
        )}
      </div>
      {text && (
        <div style={{ marginTop: 8, background: "#f6f9fe", border: "1px solid #dbe8fa", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: 1, fontSize: 14, lineHeight: 1.8 }}>{text}</div>
          <Button size="small" type="primary" ghost icon={<CopyOutlined />} onClick={() => onCopy(text)}>
            复制
          </Button>
        </div>
      )}
    </div>
  );
}
