"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Table, Input, Button, Space, Select, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { SearchOutlined, InteractionOutlined, ReloadOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_RECORD_STATUS_COLOR } from "@/lib/constants";
import { duration, fmtDateTime, 成员选项, 可选成员 } from "@/lib/utils";

type Row = {
  id: string;
  type: string;
  title: string;
  content: string;
  status: string;
  duration: number | null;
  occurredAt: string;
  customerId: string;
  customerName: string;
  contactName: string | null;
  ownerName: string;
};

export default function FollowUpsView({
  rows,
  users,
  filters,
}: {
  rows: Row[];
  users: 可选成员[];
  filters: { keyword: string; type: string; ownerId: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState(filters);

  function apply(next: Partial<typeof f> = {}) {
    const merged = { ...f, ...next };
    setF(merged);
    const q = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && q.set(k, String(v)));
    startTransition(() => router.push(`/follow-ups?${q}`));
  }

  const columns: ColumnsType<Row> = [
    {
      title: "类型",
      dataIndex: "type",
      width: 126,
      render: (v) => {
        const m = FOLLOW_TYPE_MAP[v] ?? FOLLOW_TYPE_MAP.OTHER;
        return (
          <Tag style={{ margin: 0, borderRadius: 6, color: m.color, background: m.color + "18", borderColor: m.color + "35" }}>
            {m.label}
          </Tag>
        );
      },
    },
    {
      title: "跟进内容",
      dataIndex: "title",
      width: 392,
      render: (v, r) => (
        <div style={{ lineHeight: 1.45 }}>
          <div style={{ fontWeight: 500 }}>{v}</div>
          <Typography.Text type="secondary" style={{ fontSize: 14 }} ellipsis>
            {r.content}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "所属客户",
      dataIndex: "customerName",
      width: 280,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    { title: "对接人", dataIndex: "contactName", width: 114, render: (v) => v ?? "—" },
    { title: "时长", dataIndex: "duration", width: 114, render: (v) => (v ? duration(v) : "—") },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (v) => (
        <Tag color={FOLLOW_RECORD_STATUS_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v}
        </Tag>
      ),
    },
    { title: "跟进人", dataIndex: "ownerName", width: 128, render: (v) => <UserCell name={v} size={30} /> },
    {
      title: "跟进时间",
      dataIndex: "occurredAt",
      width: 178,
      render: (v) => <span className="muted nowrap">{fmtDateTime(v)}</span>,
    },
  ];

  return (
    <>
      <PageHead
        icon={<InteractionOutlined />}
        title="跟进记录"
        subtitle="全记录留痕，过程透明可追溯"
        tag="跟进管理"
        tagNote="全面记录客户动态，驱动成交进程"
      />
      <Card styles={{ body: { padding: 22 } }}>
        <Space style={{ marginBottom: 14 }} wrap>
          <Select
            style={{ width: 156 }}
            placeholder="全部类型"
            allowClear
            value={f.type || undefined}
            onChange={(v) => apply({ type: v ?? "" })}
            options={FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
          <Select
            style={{ width: 150 }}
            placeholder="全部成员"
            allowClear
            value={f.ownerId || undefined}
            onChange={(v) => apply({ ownerId: v ?? "" })}
            options={成员选项(users)}
          />
          <Input
            style={{ width: 300 }}
            placeholder="标题 / 内容 / 客户名称"
            prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
            value={f.keyword}
            allowClear
            onChange={(e) => setF({ ...f, keyword: e.target.value })}
            onPressEnter={() => apply()}
          />
          <Button type="primary" onClick={() => apply()} loading={pending}>搜索</Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setF({ keyword: "", type: "", ownerId: "" });
              startTransition(() => router.push("/follow-ups"));
            }}
          >
            重置
          </Button>
        </Space>

        <Table<Row>
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={columns}
          loading={pending}
          scroll={{ x: 1490 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        />
      </Card>
    </>
  );
}
