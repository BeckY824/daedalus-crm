"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Space, Select, Tag } from "antd";
import { SearchOutlined, ReloadOutlined, CalendarOutlined, PlusOutlined } from "@ant-design/icons";
import { PageHead, CustomerLink, UserCell, FollowTypeCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { useBusiness } from "@/lib/business-client";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUS_COLOR } from "@/lib/constants";
import { duration, 成员选项, 可选成员, smartTime } from "@/lib/utils";

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
  const b = useBusiness();
  const [f, setF] = useState(filters);

  function apply(next: Partial<typeof f> = {}) {
    const merged = { ...f, ...next };
    setF(merged);
    const q = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && q.set(k, String(v)));
    startTransition(() => router.push(`/follow-ups?${q}`));
  }

  const 列表: 列<Row>[] = [
    {
      // 类型三样齐全：颜色、图标、文字。只有颜色的话，色弱的人和扫得快的人都认不出来
      title: "类型", key: "type", dataIndex: "type", width: 110, 常驻: true,
      render: (v) => <FollowTypeCell type={v} />,
    },
    {
      // 这一页的正文就是「聊了什么」，所以它是最宽的一列。
      // 标题和内容压在同一行：两行一格的话每行 50px 高，一屏少看四五条，
      // 而真要读全文是去记录页，不是在这张表上
      title: "内容", key: "content", dataIndex: "title", width: 300,
      // ellipsis 要交给 antd：自己在单元格里写 overflow 是没用的，
      // 撑开表格的是 td 本身，它得先拿到 max-width
      ellipsis: true,
      render: (v, r) => (
        <span title={`${v ? v + " · " : ""}${r.content}`}>
          {v && <b style={{ fontWeight: 500 }}>{v}</b>}
          {v && r.content && <span className="muted"> · </span>}
          <span className="muted">{r.content}</span>
        </span>
      ),
    },
    {
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 150,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    { title: "对接人", key: "contactName", dataIndex: "contactName", width: 96, render: (v) => v ?? <span className="muted">—</span> },
    { title: "跟进人", key: "ownerName", dataIndex: "ownerName", width: 120, render: (v) => <UserCell name={v} size={24} /> },
    { title: "时间", key: "occurredAt", dataIndex: "occurredAt", width: 130, render: (v) => <span className="muted nowrap">{smartTime(v)}</span> },

    { title: "时长", key: "duration", dataIndex: "duration", width: 90, 默认: false, render: (v) => (v ? duration(v) : <span className="muted">—</span>) },
    {
      title: "状态", key: "status", dataIndex: "status", width: 100, 默认: false,
      render: (v) => (
        <Tag color={FOLLOW_RECORD_STATUS_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v}
        </Tag>
      ),
    },
  ];

  return (
    <>
      {/* 记录和计划是同一件事的两头（发生过的 / 排好还没做的），
          所以「计划」是页头上的次动作，不再为它常驻一列中栏。
          记跟进本身要在某一位的记录页上做，这里的主动作就是去挑那个人 */}
      <PageHead
        title="跟进记录"
        subtitle="全部跟进记录"
        extra={
          <Space>
            <Button icon={<CalendarOutlined />} onClick={() => router.push("/follow-ups/plans")}>
              计划
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push("/customers")}>
              记录跟进
            </Button>
          </Space>
        }
      />

      <DataList<Row>
        页="follow-ups"
        空库={rows.length === 0 && !Object.values(filters).some((v) => v)}
        列={列表}
        行={rows}
        加载中={pending}
        行链接={(r) => `/customers/${r.customerId}`}
        空态={{
          title: "还没有跟进记录",
          hint: `一条跟进记录就是一次真实发生过的沟通。它从${b.customer}的记录页上记——在那儿随手记一笔，或粘一段聊天记录让 AI 整理；这一页把全团队的汇总起来查。`,
          primary: { label: `去${b.customer}那边记一笔`, onClick: () => router.push("/customers") },
        }}
        筛选={
          <Space wrap size={[10, 10]}>
            <Input
              style={{ width: 300 }}
              placeholder={`标题 / 内容 / ${b.customer}`}
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={f.keyword}
              allowClear
              onChange={(e) => {
                const v = e.target.value;
                setF({ ...f, keyword: v });
                // 点了清空的小叉：立刻生效，不用人再回车一次
                if (!v) apply({ keyword: "" });
              }}
              onPressEnter={() => apply()}
            />
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
            {Object.values(f).some(Boolean) && (
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setF({ keyword: "", type: "", ownerId: "" });
                  startTransition(() => router.push("/follow-ups"));
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
