"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Table, Input, Button, Space, Avatar, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { SearchOutlined, ContactsOutlined, ReloadOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink } from "@/components/ui";
import { avatarColor, initial } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
  school: string | null;
  ownerName: string;
};

export default function ContactsView({ rows, keyword }: { rows: Row[]; keyword: string }) {
  const router = useRouter();
  const [kw, setKw] = useState(keyword);
  const [pending, startTransition] = useTransition();

  const columns: ColumnsType<Row> = [
    {
      title: "姓名",
      dataIndex: "name",
      width: 226,
      render: (v, r) => (
        <Space size={8}>
          <Avatar size={36} style={{ background: avatarColor(v), fontSize: 16 }}>{initial(v)}</Avatar>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 500 }}>{v}</div>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{r.position ?? "—"}</div>
          </div>
          {r.isPrimary && <Tag color="blue" style={{ margin: 0, borderRadius: 6 }}>关键</Tag>}
        </Space>
      ),
    },
    {
      title: "所属客户",
      dataIndex: "customerName",
      width: 300,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    { title: "院校", dataIndex: "school", width: 190, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "手机号", dataIndex: "phone", width: 152, render: (v) => v ?? "—" },
    { title: "邮箱", dataIndex: "email", width: 238, render: (v) => v ?? "—" },
    { title: "微信", dataIndex: "wechat", width: 152, render: (v) => v ?? "—" },
    { title: "销售负责人", dataIndex: "ownerName", width: 130 },
  ];

  function search() {
    startTransition(() =>
      router.push(kw ? `/contacts?keyword=${encodeURIComponent(kw)}` : "/contacts"),
    );
  }

  return (
    <>
      <PageHead
        icon={<ContactsOutlined />}
        title="联系人"
        subtitle="客户对接人一目了然"
        tag="联系人管理"
        tagNote="沉淀客户决策链，沟通不断线"
      />
      <Card styles={{ body: { padding: 22 } }}>
        <Space style={{ marginBottom: 14 }} wrap>
          <Input
            style={{ width: 300 }}
            placeholder="姓名 / 电话 / 所属客户"
            prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
            value={kw}
            allowClear
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={search}
          />
          <Button type="primary" onClick={search} loading={pending}>搜索</Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setKw("");
              startTransition(() => router.push("/contacts"));
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
          scroll={{ x: 1330 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        />
      </Card>
    </>
  );
}
