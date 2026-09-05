"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Table, Button, Input, Select, Space, Dropdown, App, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  PlusOutlined,
  ExportOutlined,
  UserSwitchOutlined,
  TagsOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  IdcardOutlined,
} from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { maskPhone, smartTime, money, fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
import { toCsv } from "@/lib/csv";
import { FollowStatusTag, PageHead, UserCell, DecisionStatusTag } from "@/components/ui";
import CustomerForm, { type CustomerRow } from "./CustomerForm";
import { deleteCustomers, assignSalesOwner, bulkFollowStatus, type BulkResult } from "./actions";
import { useBusiness } from "@/lib/business-client";
import type { BusinessConfig } from "@/lib/business-config";
import { statusLabel } from "@/lib/business-config";

/**
 * 批量操作的结果文案。
 * 原本无论实际改了几条都提示「已变更」——选错页、行被别人删掉都看不出来。
 * 只有真改了才说改了几条；没改动和已消失的分开讲，否则人对不上自己勾了几条。
 */
function bulkSummary(res: Extract<BulkResult, { ok: true }>, action: string): string {
  const parts = [`${action}：${res.updated} 条`];
  if (res.unchanged) parts.push(`${res.unchanged} 条本来就是`);
  if (res.missing) parts.push(`${res.missing} 条已不存在（可能已被其他人删除）`);
  return parts.join("，");
}

type Option = { id: string; name: string };

type Props = {
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  users: 可选成员[];
  channels: Option[];
  customers: Option[];
  filters: {
    keyword: string;
    grade: string;
    followStatus: string;
    decisionStatus: string;
    salesOwnerId: string;
    channelOwnerId: string;
  };
};

export default function CustomersView({
  rows, total, page, pageSize, users, channels, customers, filters,
}: Props) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [pending, startTransition] = useTransition();
  const b = useBusiness();

  const [f, setF] = useState(filters);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  function apply(next: Partial<typeof f> = {}) {
    const merged = { ...f, ...next };
    setF(merged);
    const q = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => v && q.set(k, String(v)));
    startTransition(() => router.push(`/customers?${q}`));
  }

  function reset() {
    const blank = { keyword: "", grade: "", followStatus: "", decisionStatus: "", salesOwnerId: "", channelOwnerId: "" };
    setF(blank);
    startTransition(() => router.push("/customers"));
  }

  const columns: ColumnsType<CustomerRow> = [
    {
      title: "客户姓名",
      dataIndex: "name",
      width: 170,
      fixed: "left",
      render: (v, r) => (
        <Link href={`/customers/${r.id}`} className="link-strong">{v}</Link>
      ),
    },
    { title: "联系电话", dataIndex: "phone", width: 150, render: (v) => <span className="nowrap">{maskPhone(v)}</span> },
    { title: b.fields.school, dataIndex: "school", width: 190, render: (v) => v ?? <span className="muted">—</span> },
    { title: b.fields.major, dataIndex: "major", width: 180, render: (v) => v ?? <span className="muted">—</span> },
    { title: b.fields.grade, dataIndex: "grade", width: 100, render: (v) => v ?? <span className="muted">—</span> },
    {
      title: "推荐人",
      dataIndex: "referrerName",
      width: 130,
      render: (v) => v ?? <span className="muted">自然流量</span>,
    },
    {
      title: "渠道归属",
      dataIndex: "attributionName",
      width: 130,
      render: (v) => (v ? <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> : <span className="muted">—</span>),
    },
    {
      title: "跟进状态",
      dataIndex: "followStatus",
      width: 118,
      render: (v) => <FollowStatusTag status={v} />,
    },
    {
      title: "决策状态",
      dataIndex: "decisionStatus",
      width: 130,
      render: (v) => <DecisionStatusTag status={v} />,
    },
    {
      title: "预计签约",
      dataIndex: "expectedSignAt",
      width: 130,
      render: (v) => <span className="muted nowrap">{v ? fmtDate(v) : "—"}</span>,
    },
    {
      title: "签约金额",
      dataIndex: "signedAmount",
      width: 130,
      sorter: (a, b) => a.signedAmount - b.signedAmount,
      render: (v: number) =>
        v > 0 ? <span style={{ fontWeight: 500 }}>{money(v)}</span> : <span className="muted">—</span>,
    },
    { title: "销售负责人", dataIndex: "salesOwnerName", width: 128, render: (v) => <UserCell name={v} size={30} /> },
    {
      title: "渠道负责人",
      dataIndex: "channelOwnerName",
      width: 128,
      render: (v) => (v ? <UserCell name={v} size={30} /> : <span className="muted">—</span>),
    },
    {
      title: "最近跟进",
      dataIndex: "lastFollowAt",
      width: 130,
      render: (v) => <span className="muted nowrap">{smartTime(v)}</span>,
    },
    {
      title: "",
      key: "action",
      width: 116,
      fixed: "right",
      render: (_, r) => (
        // 纯图标按钮必须自带可访问名称：没有它，屏幕阅读器只会读出「按钮」，
        // 自动化也只能按位置取第一个——这类选择器一改动就漂
        <Space size={2}>
          <Button aria-label={`编辑 ${r.name}`} title="编辑"
            type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); setFormOpen(true); }} />
          <Button aria-label={`查看 ${r.name} 的详情`} title="详情"
            type="text" size="small" icon={<IdcardOutlined />} onClick={() => router.push(`/customers/${r.id}`)} />
          <Button
            aria-label={`删除 ${r.name}`} title="删除"
            type="text" size="small" danger icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: `删除${b.customer}「${r.name}」？`,
                content: "其跟进记录、待办与签约记录将一并删除。",
                okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
                async onOk() {
                  const res = await deleteCustomers([r.id]);
                  if (!res.ok) return message.error(res.error, 8);
                  message.success("已删除");
                  router.refresh();
                },
              })
            }
          />
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHead
        icon={<IdcardOutlined />}
        title={`${b.customer}管理`}
        subtitle="客户信息集中沉淀，跟进转化清晰可控"
        tag="客户管理"
        tagNote={`统一管理${b.customer}信息，追踪推荐来源与签约进度`}
      />

      <Card styles={{ body: { padding: 22 } }}>
        <Space wrap size={[10, 10]} style={{ marginBottom: 14 }}>
          <Select style={{ width: 130 }} placeholder={`全部${b.fields.grade}`} allowClear
            value={f.grade || undefined} onChange={(v) => apply({ grade: v ?? "" })}
            options={b.grades.map((g) => ({ value: g, label: g }))} />
          <Select style={{ width: 140 }} placeholder="全部跟进状态" allowClear
            value={f.followStatus || undefined} onChange={(v) => apply({ followStatus: v ?? "" })}
            options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
          <Select style={{ width: 150 }} placeholder="全部决策状态" allowClear
            value={f.decisionStatus || undefined} onChange={(v) => apply({ decisionStatus: v ?? "" })}
            options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
          <Select style={{ width: 150 }} placeholder="全部销售负责人" allowClear
            value={f.salesOwnerId || undefined} onChange={(v) => apply({ salesOwnerId: v ?? "" })}
            options={成员选项(users)} />
          <Select style={{ width: 150 }} placeholder="全部渠道负责人" allowClear
            value={f.channelOwnerId || undefined} onChange={(v) => apply({ channelOwnerId: v ?? "" })}
            options={成员选项(users)} />
          <Input style={{ width: 260 }} placeholder="姓名 / 电话 / 院校 / 专业"
            prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
            value={f.keyword} allowClear
            onChange={(e) => setF({ ...f, keyword: e.target.value })}
            onPressEnter={() => apply()} />
          <Button type="primary" onClick={() => apply()} loading={pending}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={reset}>重置</Button>
        </Space>

        <Space wrap style={{ marginBottom: 14 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            新建{b.customer}
          </Button>
          <Button icon={<ExportOutlined />} onClick={() => exportCsv(rows, b)}>导出</Button>
          <Dropdown
            disabled={!selected.length}
            menu={{
              // 同样走 成员选项：批量分配比单条更需要认清人，转错了是一批数据
              items: 成员选项(users).map((o) => ({
                key: o.value,
                label: o.label,
                onClick: async () => {
                  const res = await assignSalesOwner(selected, o.value);
                  setSelected([]);
                  router.refresh();
                  if (!res.ok) {
                    message.error(res.error);
                    return;
                  }
                  message.success(bulkSummary(res, `已转给 ${o.label}`));
                },
              })),
            }}
          >
            <Button icon={<UserSwitchOutlined />}>批量分配</Button>
          </Dropdown>
          <Dropdown
            disabled={!selected.length}
            menu={{
              items: FOLLOW_STATUSES.map((s) => ({
                key: s,
                label: statusLabel(b, s),
                onClick: async () => {
                  const res = await bulkFollowStatus(selected, s);
                  setSelected([]);
                  router.refresh();
                  if (!res.ok) {
                    message.error(res.error);
                    return;
                  }
                  message.success(bulkSummary(res, `已改为「${statusLabel(b, s)}」`));
                },
              })),
            }}
          >
            <Button icon={<TagsOutlined />}>批量状态</Button>
          </Dropdown>
          <Dropdown
            disabled={!selected.length}
            menu={{
              items: [{
                key: "del", danger: true, icon: <DeleteOutlined />, label: `删除选中 ${selected.length} 条`,
                onClick: () =>
                  modal.confirm({
                    title: `确认删除选中的 ${selected.length} 名${b.customer}？`,
                    content: "其跟进记录、待办与签约记录会一并删除，且不可恢复。",
                    okText: "确认删除", okButtonProps: { danger: true }, cancelText: "取消",
                    async onOk() {
                      const res = await deleteCustomers(selected);
                      if (!res.ok) return message.error(res.error, 8);
                      setSelected([]);
                      message.success(`已删除 ${res.deleted} 条`);
                      router.refresh();
                    },
                  }),
              }],
            }}
          >
            <Button icon={<MoreOutlined />}>更多操作</Button>
          </Dropdown>
        </Space>

        <Table<CustomerRow>
          rowKey="id"
          size="middle"
          dataSource={rows}
          columns={columns}
          loading={pending}
          scroll={{ x: 1900 }}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
          pagination={{
            current: page, pageSize, total,
            showTotal: (t) => `共 ${t} 条`,
            showSizeChanger: true,
            onChange: (p, ps) => {
              const q = new URLSearchParams();
              Object.entries(f).forEach(([k, v]) => v && q.set(k, String(v)));
              q.set("page", String(p));
              q.set("pageSize", String(ps));
              startTransition(() => router.push(`/customers?${q}`));
            },
          }}
        />
      </Card>

      <CustomerForm
        open={formOpen}
        editing={editing}
        users={users}
        channels={channels}
        customers={customers}
        onClose={(saved) => {
          setFormOpen(false);
          setEditing(null);
          if (saved) router.refresh();
        }}
      />
    </>
  );
}

function exportCsv(rows: CustomerRow[], b: BusinessConfig) {
  const head = ["客户姓名", "联系电话", b.fields.school, b.fields.major, b.fields.grade, "推荐人", "渠道归属", "跟进状态", "决策状态", "预计签约", "签约金额", "销售负责人", "渠道负责人"];
  const body = rows.map((r) => [
    r.name, r.phone, r.school ?? "", r.major ?? "", r.grade ?? "",
    r.referrerName ?? "", r.attributionName ?? "", statusLabel(b, r.followStatus), statusLabel(b, r.decisionStatus),
    r.expectedSignAt ? fmtDate(r.expectedSignAt) : "", r.signedAmount || "",
    r.salesOwnerName, r.channelOwnerName ?? "",
  ]);

  // 转义、BOM、公式注入防护都在 toCsv 里，见 src/lib/csv.ts
  const blob = new Blob([toCsv(head, body)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${b.customer}列表-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
