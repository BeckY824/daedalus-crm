"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Table, Input, Button, Space, Avatar, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { SearchOutlined, ContactsOutlined, ReloadOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink } from "@/components/ui";
import { 表格空态 } from "@/components/EmptyState";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";

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
  const b = useBusiness();
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
          <Avatar size={36} style={{ background: avatarColor(v), color: AVATAR_TEXT, fontSize: 16 }}>{initial(v)}</Avatar>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 500 }}>{v}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{r.position ?? "—"}</div>
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
    { title: b.fields.school, dataIndex: "school", width: 190, render: (v) => <span className="muted">{v ?? "—"}</span> },
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
        subtitle="档案里的联系人"
        tag="联系人管理"
        tagNote="沉淀客户决策链，沟通不断线"
      />
      <div className="list">
        <Space wrap>
          <Input
            style={{ width: 300 }}
            placeholder="姓名 / 电话 / 所属客户"
            prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
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
          locale={表格空态({
            title: "还没有联系人",
            hint: "联系人是学员之外的相关人：家长、决策人、经办人。在学员档案里添加，这里汇总起来按姓名和电话查。",
          })}
          size="middle"
          dataSource={rows}
          columns={columns}
          loading={pending}
          scroll={{ x: 1330 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
        />
      </div>
    </>
  );
}
