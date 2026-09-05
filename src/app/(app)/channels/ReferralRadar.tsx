"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Row, Col, Table, Button, Space, Typography, App, Empty } from "antd";
import { RadarChartOutlined, ThunderboltOutlined, CopyOutlined } from "@ant-design/icons";
import type { TopReferrer, InviteCandidate } from "@/lib/referral";
import { money } from "@/lib/utils";
import { draftInvite } from "./ai";

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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function draft(c: InviteCandidate) {
    setLoadingId(c.customerId);
    const res = await draftInvite({ customerId: c.customerId });
    setLoadingId(null);
    if (res.ok) setDrafts((d) => ({ ...d, [c.customerId]: res.message }));
    else message.error(res.error);
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    message.success("已复制，去微信发给学员吧");
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
            只看学员之间的直接推荐
          </Typography.Text>
        </Space>
      }
    >
      <Row gutter={[24, 16]}>
        <Col xs={24} xl={12}>
          <div className="stat-label" style={{ marginBottom: 8 }}>推荐榜 · 谁在帮我们带人</div>
          {topReferrers.length === 0 ? (
            emptyNode("还没有学员推荐过别人")
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
            emptyNode("已签约的学员都请过了")
          ) : (
            inviteCandidates.map((c) => (
              <div key={c.customerId} style={{ padding: "10px 0", borderBottom: "1px dashed #eef2f7" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <Link href={`/customers/${c.customerId}`} className="link-strong" style={{ fontSize: 15, fontWeight: 500 }}>
                    {c.name}
                  </Link>
                  <span style={{ flex: 1, minWidth: 160, color: "#64748b", fontSize: 14 }}>{c.reason}</span>
                  {aiEnabled && !drafts[c.customerId] && (
                    <Button
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={loadingId === c.customerId}
                      onClick={() => draft(c)}
                    >
                      起草邀请
                    </Button>
                  )}
                </div>
                {drafts[c.customerId] && (
                  <div
                    style={{
                      marginTop: 8,
                      background: "#f6f9fe",
                      border: "1px solid #dbe8fa",
                      borderRadius: 8,
                      padding: "10px 14px",
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                    }}
                  >
                    <div style={{ flex: 1, fontSize: 14, lineHeight: 1.8 }}>{drafts[c.customerId]}</div>
                    <Button size="small" type="primary" ghost icon={<CopyOutlined />} onClick={() => copy(drafts[c.customerId])}>
                      复制
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </Col>
      </Row>
    </Card>
  );
}
