"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Space, Avatar, Tag } from "antd";
import { SearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
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

  const 列表: 列<Row>[] = [
    {
      title: "联系人", key: "name", dataIndex: "name", width: 200, 常驻: true,
      render: (v, r) => (
        <Space size={8}>
          <Avatar size={24} style={{ background: avatarColor(v), color: AVATAR_TEXT, fontSize: 12 }}>{initial(v)}</Avatar>
          <span style={{ fontWeight: 500 }}>{v}</span>
          {r.isPrimary && (
            <Tag color="blue" style={{ margin: 0, borderRadius: 6 }}>
              关键
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 240,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    // 「关系」就是他和这位的关系（母亲、班主任、同学），不是公司里的职务
    { title: "关系", key: "position", dataIndex: "position", width: 120, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "电话 · 微信", 列名: "电话 · 微信", key: "phone", width: 220,
      render: (_, r) =>
        r.phone || r.wechat ? (
          <span className="nowrap">
            {r.phone ?? "—"}
            {r.wechat && <span className="muted"> · {r.wechat}</span>}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { title: "销售负责人", key: "ownerName", dataIndex: "ownerName", width: 140, render: (v) => <UserCell name={v} size={24} /> },

    { title: b.fields.school, key: "school", dataIndex: "school", width: 180, 默认: false, render: (v) => <span className="muted">{v ?? "—"}</span> },
    { title: "邮箱", key: "email", dataIndex: "email", width: 220, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
  ];

  function search() {
    startTransition(() =>
      router.push(kw ? `/contacts?keyword=${encodeURIComponent(kw)}` : "/contacts"),
    );
  }

  return (
    <>
      {/* 联系人没有「添加」主动作：他挂在某一位学员下面，从那位的记录页添加才填得对
          （设计稿 14/PAGE 的页面规则也是这条：优先从记录页添加）。
          空状态里那个「去建第一位学员」就是这条路的入口。 */}
      <PageHead title="联系人" subtitle="档案里的联系人" />

      <DataList<Row>
        页="contacts"
        空库={rows.length === 0 && !keyword}
        列={列表}
        行={rows}
        加载中={pending}
        行链接={(r) => `/customers/${r.customerId}`}
        空态={{
          title: "还没有联系人",
          hint: `联系人是${b.customer}那边真正在对话的人：家长、同学、带教老师。他挂在某一位${b.customer}下面，所以要先有${b.customer}，再在他的记录页上添加。`,
          primary: { label: `去建第一位${b.customer}`, onClick: () => router.push("/customers?new=1") },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 300 }}
              placeholder={`姓名 / 电话 / 微信 / ${b.customer}`}
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={kw}
              allowClear
              onChange={(e) => {
                const v = e.target.value;
                setKw(v);
                if (!v) startTransition(() => router.push("/contacts"));
              }}
              onPressEnter={search}
            />
            {keyword && (
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setKw("");
                  startTransition(() => router.push("/contacts"));
                }}
              >
                重置
              </Button>
            )}
          </Space>
        }
      />
    </>
  );
}
