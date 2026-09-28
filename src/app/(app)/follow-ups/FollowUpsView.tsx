"use client";

import { useRouter } from "next/navigation";
import { Badge, Button, Space, Select, Tag } from "antd";
import { useFollowDue } from "@/components/FollowDue";
import { CalendarOutlined, PlusOutlined } from "@ant-design/icons";
import ResetFilters from "@/components/ResetFilters";
import { 列表不问归属 } from "@/lib/solo";
import ListSearch from "@/components/ListSearch";
import { PageHead, CustomerLink, UserCell, FollowTypeCell } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import { useBusiness } from "@/lib/business-client";
import { FOLLOW_TYPES, FOLLOW_RECORD_STATUS_COLOR } from "@/lib/constants";
import { duration, 成员选项, 可选成员, smartTime } from "@/lib/utils";
import { useUrlFilters } from "@/lib/url-filters";

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
  总数,
  users,
  filters,
}: {
  rows: Row[];
  /** 库里一共多少条。行只取了前 300，分页条不能拿行数冒充总数 */
  总数: number;
  users: 可选成员[];
  filters: { keyword: string; type: string; ownerId: string };
}) {
  const router = useRouter();
  const 要跟 = useFollowDue();
  const b = useBusiness();
  const { f, setF, apply, reset, pending } = useUrlFilters("/follow-ups", filters);
  /** 只有一个人：跟进人那一列、「全部成员」筛选都不摆（审查 D2），见 lib/solo.ts */
  const 不问归属 = !f.ownerId && 列表不问归属(users, rows.map((r) => r.ownerName));

  const 列表: 列<Row>[] = [
    {
      // 第一列是「这条是谁的」，和别的列表一样钉在左边；类型再有用也回答不了「是谁」
      title: `所属${b.customer}`, 列名: `所属${b.customer}`, key: "customerName", dataIndex: "customerName", width: 150, 常驻: true,
      render: (v, r) => <CustomerLink id={r.customerId} name={v} />,
    },
    {
      // 「什么时候」紧跟在「是谁」后面（审查 M3）：原来排在最右，13 寸窗口下只剩一个数字露在外面。
      // 这张表按时间倒序排，时间是扫一眼就要对上的东西
      title: "时间", key: "occurredAt", dataIndex: "occurredAt", width: 110, 常驻: true,
      render: (v) => <span className="muted nowrap">{smartTime(v)}</span>,
    },
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
    { title: "对接人", key: "contactName", dataIndex: "contactName", width: 96, render: (v) => v ?? <span className="muted">—</span> },
    ...(不问归属 ? [] : [{ title: "跟进人", key: "ownerName", dataIndex: "ownerName", width: 120, render: (v: string) => <UserCell name={v} size={24} /> }]),

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
            {/* 左栏「跟进」上那个红数字到了这一页，就挂在「计划」上：它数的正是计划页里逾期和今天那两组 */}
            <Badge count={要跟.逾期 + 要跟.今天} size="small" color="var(--danger)" offset={[-4, 2]}>
              <Button
                icon={<CalendarOutlined />}
                onClick={() => router.push("/follow-ups/plans")}
                aria-label={要跟.逾期 + 要跟.今天 > 0 ? `计划，要跟 ${要跟.逾期 + 要跟.今天} 条` : "计划"}
              >
                计划
              </Button>
            </Badge>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push("/customers")}>
              记录跟进
            </Button>
          </Space>
        }
      />

      <DataList<Row>
        截断={{ 总数 }}
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
            <ListSearch
              width={300}
              placeholder={`标题 / 内容 / ${b.customer}`}
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
            />
            <Select
              style={{ width: 156 }}
              placeholder="全部类型"
              allowClear
              value={f.type || undefined}
              onChange={(v) => apply({ type: v ?? "" })}
              options={FOLLOW_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            />
            {!不问归属 && (
              <Select
                style={{ width: 150 }}
                placeholder="全部成员"
                allowClear
                value={f.ownerId || undefined}
                onChange={(v) => apply({ ownerId: v ?? "" })}
                options={成员选项(users)}
              />
            )}
            <ResetFilters 显示={Object.values(f).some(Boolean)} onClick={reset} />
          </Space>
        }
      />
    </>
  );
}
