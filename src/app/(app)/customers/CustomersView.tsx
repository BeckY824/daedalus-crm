"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Input, Select, Space, Dropdown, App, Tag, Popover } from "antd";
import {
  PlusOutlined,
  ExportOutlined,
  UserSwitchOutlined,
  TagsOutlined,
  ReloadOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  FilterOutlined,
} from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { maskPhone, smartTime, money, fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
import { toCsv } from "@/lib/csv";
import { FollowStatusTag, PageHead, UserCell, DecisionStatusTag } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
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
  /** 进来就把新建表单打开（首页空库那张「开始」卡的落点） */
  直接新建?: boolean;
  filters: {
    keyword: string;
    grade: string;
    followStatus: string;
    decisionStatus: string;
    salesOwnerId: string;
    channelOwnerId: string;
  };
};

/**
 * 学员列表——全站列表页的母版（批 2）。
 *
 * 表格、筛选栏的收放、分页、列设置、批量工具条都在 `components/DataList.tsx` 里，
 * 这一页只写四样：列、筛选、空状态的第一步、主动作。线索 / 渠道 / 联系人 /
 * 商机 / 跟进照抄这四样就行（批 3）。
 *
 * 默认只摆六列：学员、院校·专业、跟进状态、预计签约、负责人、最近跟进。
 * 原来十四列全摆出来，1440 屏上要横着拖两屏才看得完，而每天真正要扫的就这六样；
 * 其余的收进「列」里，勾了记在这台机器上。
 */
export default function CustomersView({
  rows, total, page, pageSize, users, channels, customers, filters, 直接新建,
}: Props) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [pending, startTransition] = useTransition();
  const b = useBusiness();

  const [f, setF] = useState(filters);
  /**
   * 「空库」是「一条都没有 **且** 没在筛」。筛出 0 条不算——
   * 那时筛选栏必须留着，否则人看不见自己筛了什么，也点不到重置。
   * 按 filters（服务端那次查询用的条件）判而不是 f（输入框里的草稿）。
   */
  const 空库 = total === 0 && !Object.values(filters).some((v) => v);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [formOpen, setFormOpen] = useState(Boolean(直接新建));

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

  /** 收起来的那三个里还筛着几个。收起来不等于可以不告诉人 */
  const 更多筛了 = [f.grade, f.decisionStatus, f.channelOwnerId].filter(Boolean).length;
  /** 一共筛着几个。0 的时候「重置」不出现——没筛过的页面上它是个哑按钮 */
  const 筛了 = Object.values(f).filter(Boolean).length;

  const 列表: 列<CustomerRow>[] = [
    {
      title: b.customer,
      key: "name",
      dataIndex: "name",
      width: 160,
      常驻: true,
      render: (v, r) => <Link href={`/customers/${r.id}`} className="link-strong">{v}</Link>,
    },
    {
      // 院校和专业永远一起看。分成两列只是把同一件事拆开占两倍宽
      title: `${b.fields.school}·${b.fields.major}`,
      key: "schoolMajor",
      列名: `${b.fields.school}·${b.fields.major}`,
      width: 250,
      render: (_, r) =>
        r.school || r.major ? (
          <span>
            {r.school ?? "—"}
            {r.major && <span className="muted"> · {r.major}</span>}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { title: "跟进状态", key: "followStatus", dataIndex: "followStatus", width: 118, render: (v) => <FollowStatusTag status={v} /> },
    {
      title: "预计签约", key: "expectedSignAt", dataIndex: "expectedSignAt", width: 116,
      render: (v) => <span className="muted nowrap">{v ? fmtDate(v) : "—"}</span>,
    },
    { title: "负责人", 列名: "负责人", key: "salesOwnerName", dataIndex: "salesOwnerName", width: 140, render: (v) => <UserCell name={v} size={24} /> },
    { title: "最近跟进", key: "lastFollowAt", dataIndex: "lastFollowAt", width: 116, render: (v) => <span className="muted nowrap">{smartTime(v)}</span> },

    { title: "联系电话", key: "phone", dataIndex: "phone", width: 140, 默认: false, render: (v) => <span className="nowrap">{maskPhone(v)}</span> },
    { title: b.fields.grade, key: "grade", dataIndex: "grade", width: 90, 默认: false, render: (v) => v ?? <span className="muted">—</span> },
    { title: "决策状态", key: "decisionStatus", dataIndex: "decisionStatus", width: 128, 默认: false, render: (v) => <DecisionStatusTag status={v} /> },
    {
      title: "签约金额", key: "signedAmount", dataIndex: "signedAmount", width: 120, 默认: false,
      sorter: (a, b2) => a.signedAmount - b2.signedAmount,
      render: (v: number) => (v > 0 ? <span style={{ fontWeight: 500 }}>{money(v)}</span> : <span className="muted">—</span>),
    },
    { title: "推荐人", key: "referrerName", dataIndex: "referrerName", width: 120, 默认: false, render: (v) => v ?? <span className="muted">自然流量</span> },
    {
      title: "渠道归属", key: "attributionName", dataIndex: "attributionName", width: 120, 默认: false,
      render: (v) => (v ? <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> : <span className="muted">—</span>),
    },
    {
      title: "渠道负责人", key: "channelOwnerName", dataIndex: "channelOwnerName", width: 130, 默认: false,
      render: (v) => (v ? <UserCell name={v} size={24} /> : <span className="muted">—</span>),
    },
    {
      title: "", key: "action", width: 78, 常驻: true, fixed: "right",
      render: (_, r) => (
        // 纯图标按钮必须自带可访问名称：没有它，屏幕阅读器只会读出「按钮」，
        // 自动化也只能按位置取第一个——这类选择器一改动就漂。
        // 原来还有个「详情」按钮，去掉了：整行点进去就是详情，一行里不摆两条同样的路
        <Space size={2}>
          <Button aria-label={`编辑 ${r.name}`} title="编辑"
            type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditing(r); setFormOpen(true); }} />
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
        title={b.customer}
        subtitle="按状态、负责人和来源筛选"
        extra={
          /* 主动作在页头右上角，全站六张列表页同一个位置（设计稿 11/PAGE）。
             导出是次动作，排在它左边，空库时没什么可导，不出现 */
          <Space>
            {!空库 && <Button icon={<ExportOutlined />} onClick={() => exportCsv(rows, b)}>导出</Button>}
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
              新建{b.customer}
            </Button>
          </Space>
        }
      />

      <DataList<CustomerRow>
        页="customers"
        空库={空库}
        列={列表}
        行={rows}
        加载中={pending}
        行链接={(r) => `/customers/${r.id}`}
        空态={{
          title: `还没有${b.customer}`,
          hint: `${b.customer}是这套系统的中心：跟进记录、商机、签约都挂在他身上，推荐归属也按他这条线往上算。`,
          primary: { label: `新建第一位${b.customer}`, onClick: () => { setEditing(null); setFormOpen(true); } },
        }}
        筛选={
          /*
            摆出来的只有三个：搜一句、跟进状态、销售负责人——每天都在用的就这三个。
            年级 / 决策状态 / 渠道负责人收进「更多筛选」，但正筛着几个要写在按钮上：
            收起来不等于可以不告诉人，否则人会对着一张筛过的表当成全部。
          */
          <Space wrap size={[10, 10]}>
            <Input style={{ width: 260 }} placeholder="姓名 / 电话 / 院校 / 专业"
              prefix={<SearchOutlined style={{ color: "var(--text-muted)" }} />}
              value={f.keyword} allowClear
              onChange={(e) => {
                const v = e.target.value;
                setF({ ...f, keyword: v });
                // 点了清空的小叉：立刻生效，不用人再回车一次
                if (!v) apply({ keyword: "" });
              }}
              onPressEnter={() => apply()} />
            <Select style={{ width: 140 }} placeholder="全部跟进状态" allowClear
              value={f.followStatus || undefined} onChange={(v) => apply({ followStatus: v ?? "" })}
              options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
            <Select style={{ width: 150 }} placeholder="全部负责人" allowClear
              value={f.salesOwnerId || undefined} onChange={(v) => apply({ salesOwnerId: v ?? "" })}
              options={成员选项(users)} />
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={
                <Space orientation="vertical" size={10} style={{ width: 220 }}>
                  <Select style={{ width: "100%" }} placeholder={`全部${b.fields.grade}`} allowClear
                    value={f.grade || undefined} onChange={(v) => apply({ grade: v ?? "" })}
                    options={b.grades.map((g) => ({ value: g, label: g }))} />
                  <Select style={{ width: "100%" }} placeholder="全部决策状态" allowClear
                    value={f.decisionStatus || undefined} onChange={(v) => apply({ decisionStatus: v ?? "" })}
                    options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
                  <Select style={{ width: "100%" }} placeholder="全部渠道负责人" allowClear
                    value={f.channelOwnerId || undefined} onChange={(v) => apply({ channelOwnerId: v ?? "" })}
                    options={成员选项(users)} />
                </Space>
              }
            >
              <Button icon={<FilterOutlined />}>更多筛选{更多筛了 > 0 ? ` · ${更多筛了}` : ""}</Button>
            </Popover>
            {/* 没有「搜索」按钮：下拉改了就生效，关键词回车或清空就生效。
                一个要再点一下才算数的筛选栏，会让人以为自己已经筛了其实没有。
                「重置」只在真筛了东西的时候出现——没筛过的页面上它是个哑按钮 */}
            {筛了 > 0 && <Button icon={<ReloadOutlined />} onClick={reset}>重置</Button>}
          </Space>
        }
        批量={(selected, 清空) => (
          <>
            <Dropdown
              menu={{
                // 同样走 成员选项：批量分配比单条更需要认清人，转错了是一批数据
                items: 成员选项(users).map((o) => ({
                  key: o.value,
                  label: o.label,
                  onClick: async () => {
                    const res = await assignSalesOwner(selected, o.value);
                    清空();
                    router.refresh();
                    if (!res.ok) return void message.error(res.error);
                    message.success(bulkSummary(res, `已转给 ${o.label}`));
                  },
                })),
              }}
            >
              <Button size="small" icon={<UserSwitchOutlined />}>批量分配</Button>
            </Dropdown>
            <Dropdown
              menu={{
                items: FOLLOW_STATUSES.map((s) => ({
                  key: s,
                  label: statusLabel(b, s),
                  onClick: async () => {
                    const res = await bulkFollowStatus(selected, s);
                    清空();
                    router.refresh();
                    if (!res.ok) return void message.error(res.error);
                    message.success(bulkSummary(res, `已改为「${statusLabel(b, s)}」`));
                  },
                })),
              }}
            >
              <Button size="small" icon={<TagsOutlined />}>批量状态</Button>
            </Dropdown>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `确认删除选中的 ${selected.length} 名${b.customer}？`,
                  content: "其跟进记录、待办与签约记录会一并删除，且不可恢复。",
                  okText: "确认删除", okButtonProps: { danger: true }, cancelText: "取消",
                  async onOk() {
                    const res = await deleteCustomers(selected);
                    if (!res.ok) return message.error(res.error, 8);
                    清空();
                    message.success(`已删除 ${res.deleted} 条`);
                    router.refresh();
                  },
                })
              }
            >
              删除
            </Button>
          </>
        )}
        分页={{
          当前页: page,
          每页: pageSize,
          总数: total,
          翻页: (p, ps) => {
            const q = new URLSearchParams();
            Object.entries(f).forEach(([k, v]) => v && q.set(k, String(v)));
            q.set("page", String(p));
            q.set("pageSize", String(ps));
            startTransition(() => router.push(`/customers?${q}`));
          },
        }}
      />

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
