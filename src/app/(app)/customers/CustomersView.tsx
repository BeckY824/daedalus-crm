"use client";

import Heat from "@/components/Heat";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Select, Space, Dropdown, App, Tag, Popover } from "antd";
import {
  PlusOutlined,
  ExportOutlined,
  ImportOutlined,
  UserSwitchOutlined,
  TagsOutlined,
  DeleteOutlined,
  EditOutlined,
  FilterOutlined,
} from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { maskPhone, smartTime, money, fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
import { toCsv } from "@/lib/csv";
import ListSearch from "@/components/ListSearch";
import { FollowStatusTag, PageHead, UserCell, DecisionStatusTag } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import CustomerForm, { type CustomerRow } from "./CustomerForm";
import ImportDrawer from "./ImportDrawer";
import { assignSalesOwner, bulkFollowStatus, type BulkResult } from "./actions";
import { useDeleteCustomers } from "./useDeleteCustomers";
import { 带走说法 } from "@/lib/carry-over";
import { useBusiness } from "@/lib/business-client";
import type { BusinessConfig } from "@/lib/business-config";
import { statusLabel } from "@/lib/business-config";
import { useUrlFilters } from "@/lib/url-filters";
import { 列表不问归属 } from "@/lib/solo";
import ResetFilters from "@/components/ResetFilters";

/**
 * 批量操作的结果文案。
 * 原本无论实际改了几条都提示「已变更」——选错页、行被别人删掉都看不出来。
 * 只有真改了才说改了几条；没改动和已消失的分开讲，否则人对不上自己勾了几条。
 */
function bulkSummary(res: Extract<BulkResult, { ok: true }>, action: string): string {
  const parts = [`${action}：${res.updated} 条`];
  if (res.unchanged) parts.push(`${res.unchanged} 条本来就是`);
  if (res.missing) parts.push(`${res.missing} 条已不存在（可能已删除）`);
  // 改负责人时原负责人没做完的活一起转了（排查 B3）。带走说法自带开头的逗号
  return parts.join("，") + 带走说法(res.带走);
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
  /** 进来就把导入抽屉开在「粘一段文本」那一栏。主线入口，见 dashboard/HomeChat.tsx */
  直接粘贴?: boolean;
  /**
   * 「数据」页那张「新增学员」卡点进来的：只看这个月建的。
   * 它不进筛选栏（筛选栏摆的是每天都在用的那几个），但**必须让人看见自己在看一个子集**——
   * 所以工具栏第一格是一枚带叉的标记，点叉就回到全部。
   */
  本月新增?: boolean;
  /** 渠道页「直接推荐」点进来时是哪个渠道的名字；null = 不是从那儿来的 */
  直接推荐?: string | null;
  /**
   * 从导入抽屉点「完成」过来的：只看刚导进来的这一批（审查 D10）。
   * 和「只看本月新增」一样是一枚带叉的标记，点叉回到全部
   */
  本批?: { 几位: number } | null;
  /** 接上模型了没有。没接上时导入抽屉里「粘一段文本」那条路只说明原因，不给按钮 */
  aiEnabled?: boolean;
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
  rows, total, page, pageSize, users, channels, customers, filters, 直接新建, 直接粘贴, 本月新增, 直接推荐 = null, 本批, aiEnabled,
}: Props) {
  const router = useRouter();
  const { message } = App.useApp();
  const { 问删除 } = useDeleteCustomers();

  /**
   * 批量改完给一次撤销（排查 D1）。原来点一下就写库、没有退路，选错一页就是一批数据改错。
   * 撤销 = 按原值分组再调一次同一个批量动作：改负责人那边，没做完的活也会跟着回到原来的人手上（B3 是对称的）
   */
  function 可撤销提示(res: Extract<BulkResult, { ok: true }>, 文案: string, 退回: (ids: string[], 值: string) => Promise<BulkResult>) {
    const 原值 = res.原值 ?? [];
    if (!原值.length) return void message.success(文案);
    const key = `bulk-${原值[0].id}-${原值.length}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          {文案}
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const 组 = new Map<string, string[]>();
              for (const x of 原值) 组.set(x.值, [...(组.get(x.值) ?? []), x.id]);
              for (const [值, ids] of 组) {
                const r = await 退回(ids, 值);
                if (!r.ok) {
                  router.refresh();
                  return void message.error(`没能全部改回去：${r.error}`);
                }
              }
              router.refresh();
              message.success(`已撤销，${原值.length} 条改回原样`);
            }}
          >
            撤销
          </Button>
        </span>
      ),
    });
  }
  const b = useBusiness();

  const { f, setF, apply, 翻页, reset, pending } = useUrlFilters("/customers", filters);
  /**
   * 「空库」是「一条都没有 **且** 没在筛」。筛出 0 条不算——
   * 那时筛选栏必须留着，否则人看不见自己筛了什么，也点不到重置。
   * 按 filters（服务端那次查询用的条件）判而不是 f（输入框里的草稿）。
   */
  const 空库 = total === 0 && !本月新增 && !直接推荐 && !本批 && !Object.values(filters).some((v) => v);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [formOpen, setFormOpen] = useState(Boolean(直接新建));
  const [导入开着, set导入开着] = useState(Boolean(直接粘贴));

  /** 收起来的那三个里还筛着几个。收起来不等于可以不告诉人 */
  const 更多筛了 = [f.grade, f.decisionStatus, f.channelOwnerId].filter(Boolean).length;
  /** 一共筛着几个。0 的时候「重置」看不见——没筛过的页面上它是个哑按钮（位置留着，见 ResetFilters） */
  const 筛了 = Object.values(f).filter(Boolean).length;
  /**
   * 只有一个人的库：负责人列、负责人筛选、渠道负责人、批量分配都不摆（审查 D2 / M3）。
   * 13 寸窗口下负责人那一列正好把「最近跟进」挤出视野，而它每一格都是同一个名字。
   * 正筛着某个负责人（从数据页点名字进来的）时照摆，不然人看不见自己筛了什么
   */
  const 不问归属 =
    !f.salesOwnerId && !f.channelOwnerId &&
    列表不问归属(users, rows.flatMap((r) => [r.salesOwnerName, r.channelOwnerName]));

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
    ...(不问归属 ? [] : [{ title: "负责人", 列名: "负责人", key: "salesOwnerName", dataIndex: "salesOwnerName", width: 140, render: (v: string) => <UserCell name={v} size={24} /> }]),
    {
      title: "最近跟进", key: "lastFollowAt", dataIndex: "lastFollowAt", width: 132,
      // 冷热在前：扫一眼这一列就知道谁凉了，日期留着给要细看的人
      render: (v, r) => (
        <span className="heat-cell">
          <Heat at={v} status={r.followStatus} />
          <span className="muted nowrap">{smartTime(v)}</span>
        </span>
      ),
    },

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
    ...(不问归属 ? [] : [{
      title: "渠道负责人", key: "channelOwnerName", dataIndex: "channelOwnerName", width: 130, 默认: false,
      render: (v: string | null) => (v ? <UserCell name={v} size={24} /> : <span className="muted">—</span>),
    }]),
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
            // 先数清会一起删掉什么再问（排查 B1，见 useDeleteCustomers）
            onClick={() => void 问删除([{ id: r.id, name: r.name }])}
          />
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={b.customer}
        subtitle="全部档案与跟进"
        extra={
          /* 主动作在页头右上角，全站六张列表页同一个位置（设计稿 11/PAGE）。
             导出是次动作，排在它左边，空库时没什么可导，不出现 */
          <Space>
            {/* 导入和导出都是次动作，排在主动作左边。导入空库时也要在——
                第一次进来的人手上那份 Excel 正是他不想一条条录的原因 */}
            <Button icon={<ImportOutlined />} onClick={() => set导入开着(true)}>导入</Button>
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
          secondary: [{ label: "从 Excel 导入", onClick: () => set导入开着(true) }],
        }}
        筛选={
          /*
            摆出来的只有三个：搜一句、跟进状态、销售负责人——每天都在用的就这三个。
            年级 / 决策状态 / 渠道负责人收进「更多筛选」，但正筛着几个要写在按钮上：
            收起来不等于可以不告诉人，否则人会对着一张筛过的表当成全部。
          */
          <Space wrap size={[10, 10]}>
            {/* 从「数据」页那张卡走进来的：说清这是一个子集，并给一条回到全部的路 */}
            {本月新增 && (
              <Tag closable onClose={() => router.push("/customers")} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看本月新增
              </Tag>
            )}
            {直接推荐 && (
              <Tag closable onClose={() => router.push("/customers")} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看「{直接推荐}」直接带来的 · {total} 位
              </Tag>
            )}
            {本批 && (
              <Tag closable onClose={() => router.push("/customers")} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看刚导入的这一批 · {本批.几位} 位
              </Tag>
            )}
            <ListSearch
              placeholder={`姓名 / 电话 / ${b.fields.school} / ${b.fields.major} / 备注`}
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
            />
            <Select style={{ width: 140 }} placeholder="全部跟进状态" allowClear
              value={f.followStatus || undefined} onChange={(v) => apply({ followStatus: v ?? "" })}
              options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
            {!不问归属 && (
              <Select style={{ width: 150 }} placeholder="全部负责人" allowClear
                value={f.salesOwnerId || undefined} onChange={(v) => apply({ salesOwnerId: v ?? "" })}
                options={成员选项(users)} />
            )}
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
                  {!不问归属 && (
                    <Select style={{ width: "100%" }} placeholder="全部渠道负责人" allowClear
                      value={f.channelOwnerId || undefined} onChange={(v) => apply({ channelOwnerId: v ?? "" })}
                      options={成员选项(users)} />
                  )}
                </Space>
              }
            >
              <Button icon={<FilterOutlined />}>更多筛选{更多筛了 > 0 ? ` · ${更多筛了}` : ""}</Button>
            </Popover>
            {/* 没有「搜索」按钮：下拉改了就生效，关键词回车或清空就生效。
                一个要再点一下才算数的筛选栏，会让人以为自己已经筛了其实没有。
                「重置」只在真筛了东西的时候看得见；位置一直留着，筛的那一下表格不往下跳（M17） */}
            <ResetFilters 显示={筛了 > 0} onClick={reset} />
          </Space>
        }
        批量={(selected, 清空, 选中行) => (
          <>
            {!不问归属 && <Dropdown
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
                    可撤销提示(res, bulkSummary(res, `已转给 ${o.label}`), assignSalesOwner);
                  },
                })),
              }}
            >
              <Button size="small" icon={<UserSwitchOutlined />}>批量分配</Button>
            </Dropdown>}
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
                    可撤销提示(res, bulkSummary(res, `已改为「${statusLabel(b, s)}」`), bulkFollowStatus);
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
              // 写出是谁、会一起删掉什么（排查 B1）：人得对得上自己勾的是哪几位
              onClick={() =>
                void 问删除(
                  selected.map((id) => ({ id, name: 选中行.find((r) => r.id === id)?.name ?? "" })),
                  清空,
                )
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
          翻页,
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

      <ImportDrawer
        open={导入开着}
        b={b}
        aiEnabled={Boolean(aiEnabled)}
        初始来路={直接粘贴 ? "文本" : undefined}
        onClose={() => set导入开着(false)}
        onDone={() => router.refresh()}
        看这一批={(id) => router.push(`/customers?batch=${id}`)}
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
