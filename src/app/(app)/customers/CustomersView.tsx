"use client";

import Heat from "@/components/Heat";
import { useEffect, useState, useSyncExternalStore, useRef } from "react";
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
  InboxOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { 合计文字 } from "@/lib/currency";
import { maskPhone, smartTime, fmtDate, 成员选项, 可选成员 } from "@/lib/utils";
import ListSearch from "@/components/ListSearch";
import { FollowStatusTag, PageHead, UserCell, DecisionStatusTag } from "@/components/ui";
import DataList, { type 列 } from "@/components/DataList";
import CustomerForm, { type CustomerRow } from "./CustomerForm";
import { 完整导出 } from "./export-client";
import { 签约各币 } from "./export-table";
import ImportDrawer from "./ImportDrawer";
import { assignSalesOwner, bulkFollowStatus, 撤销改负责人, type BulkResult } from "./actions";
import { useDeleteCustomers } from "./useDeleteCustomers";
import { 带走说法 } from "@/lib/carry-over";
import { useBusiness } from "@/lib/business-client";
import { statusLabel, 外贸精简, 签约叫 } from "@/lib/business-config";
import { WhatsApp网址 } from "@/lib/customer-extra";
import { useUrlFilters } from "@/lib/url-filters";
import { 列表不问归属 } from "@/lib/solo";
import { 公海标签 } from "@/lib/pool";
import { 放进公海, 领取, 撤销公海, type 公海结果 } from "./pool-actions";
import ResetFilters from "@/components/ResetFilters";
import CurrencySelect from "@/components/CurrencySelect";

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

/** 负责人下拉里「公海」那一项的值（不会和成员 id 撞：cuid 没有冒号） */
const 公海值 = "pool:";

type Props = {
  rows: CustomerRow[];
  total: number;
  page: number;
  requestedPage?: string;
  pageSize: number;
  金额排序?: string;
  排序币种?: string;
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
  /**
   * 库里还有人在用、但业务配置里已经删掉的职位（第 2 期 2b）。筛选下拉原来只列现在的选项，
   * 删掉一项后那些老客户还在、显示也对，就是筛不出来
   */
  旧职位?: string[];
  /** 库里用着的国家（外贸模版的国家筛选，2026-10-05） */
  国家们?: string[];
  filters: {
    keyword: string;
    grade: string;
    followStatus: string;
    decisionStatus: string;
    salesOwnerId: string;
    channelOwnerId: string;
    /**
     * 三种子集（数据页「本月新增」、渠道页「直接推荐」、导入「看这一批」）也放进条件里：
     * 原来只在地址栏上，一翻页、一搜索、一改筛选就丢了，第 2 页成了全库的第 2 页（2026-10-02 排查）
     */
    createdWithin: string;
    directOf: string;
    batch: string;
    /** 「1」= 只看公海 */
    pool: string;
    /** 外贸档案的国家 / 来源（2026-10-05） */
    country: string;
    source: string;
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

/** 只用来认「水合完了没有」（见 已水合） */
const 无订阅 = () => () => {};

export default function CustomersView({
  rows, total, page, requestedPage, pageSize, users, channels, customers, filters, 直接新建, 直接粘贴, 本月新增, 直接推荐 = null, 本批, aiEnabled, 旧职位 = [], 国家们 = [], 金额排序 = "", 排序币种,
}: Props) {
  const router = useRouter();
  // 服务端已取有效页的数据；只修正地址，避免二次请求与开发模式流式重定向错误。
  useEffect(() => {
    if (requestedPage === undefined || requestedPage === String(page)) return;
    const url = new URL(window.location.href);
    // 翻页中的旧 props 不能把新目标地址改回旧页。
    if (url.searchParams.get("page") !== requestedPage) return;
    url.searchParams.set("page", String(page));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [page, requestedPage]);

  const { message } = App.useApp();
  const { 问删除 } = useDeleteCustomers();

  /**
   * 批量改完给一次撤销（排查 D1）。原来点一下就写库、没有退路，选错一页就是一批数据改错。
   * 撤销 = 按原值分组再调一次同一个批量动作（改状态）；改负责人不能这样撤——反向再转一次会把新负责人本来就有的活
   * 一起带走，传 整批退回 走 撤销改负责人，只还这次带过来的（2026-10-04 T-018）
   */
  function 可撤销提示(res: Extract<BulkResult, { ok: true }>, 文案: string, 退回: (ids: string[], 值: string) => Promise<BulkResult>, 整批退回?: () => Promise<BulkResult>) {
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
              if (整批退回) {
                const r = await 整批退回();
                router.refresh();
                if (!r.ok) return void message.error(`没能全部改回去：${r.error}`);
                return void (r.unchanged
                  ? message.warning(`已撤销 ${r.updated} 条；${r.unchanged} 条没改回（刚被人改过，或原负责人已停用）`)
                  : message.success(`已撤销，${r.updated} 条改回原样`));
              }
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
  /**
   * 公海两个动作的提示条：说清动了几位、几位没动为什么，带一次撤销（和批量改同一个做法）。
   * 「领取」撤销 = 还给原来的人、放回公海；「放进」撤销 = 拿回来
   */
  function 公海提示(res: 公海结果, 动作: "放进" | "领取", ids: string[]) {
    router.refresh();
    if (!res.ok) return void message.error(res.error);
    const 名 = 动作 === "放进" ? "放进公海" : "领取";
    if (!res.updated) {
      return void message.info(动作 === "放进" ? "选中的已经都在公海里了" : "选中的已经被领走了，没有可领的");
    }
    const 另 = [
      res.unchanged && (动作 === "放进" ? `${res.unchanged} 位本来就在公海` : `${res.unchanged} 位已被别人领走或不在公海`),
      res.没权限 && `${res.没权限} 位不是你负责的，没放（只有负责人或管理员能放）`,
    ].filter(Boolean);
    const 文案 = `已${名} ${res.updated} 位${另.length ? `；${另.join("，")}` : ""}${带走说法(res.带走)}`;
    const 原 = 动作 === "领取" ? (res.原负责人 ?? []) : ids.map((id) => ({ id, 值: "" }));
    const key = `pool-${动作}-${ids[0]}-${ids.length}`;
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
              const r = await 撤销公海(动作, 原, res.ok ? res.带过来 : undefined);
              router.refresh();
              if (!r.ok) return void message.error(`没能撤销：${r.error}`);
              message.success(`已撤销，${r.updated} 位改回原样`);
            }}
          >
            撤销
          </Button>
        </span>
      ),
    });
  }
  const b = useBusiness();

  const { f, setF, apply, 翻页, reset, pending } = useUrlFilters("/customers", { ...filters, sort: 金额排序, sortCurrency: 排序币种 ?? b.currency }, pageSize);
  /**
   * 「空库」是「一条都没有 **且** 没在筛」。筛出 0 条不算——
   * 那时筛选栏必须留着，否则人看不见自己筛了什么，也点不到重置。
   * 按 filters（服务端那次查询用的条件）判而不是 f（输入框里的草稿）。
   */
  const 空库 = total === 0 && !本月新增 && !直接推荐 && !本批 && !Object.values(filters).some((v) => v);
  const [editing, setEditing] = useState<CustomerRow | null>(null);
  const [导出中, set导出中] = useState(false);
  const [导出进度, set导出进度] = useState("");
  const 导出取消 = useRef<AbortController | null>(null);
  useEffect(() => () => 导出取消.current?.abort(), []);
  const [formOpen, setFormOpen] = useState(Boolean(直接新建));
  const [导入开着, set导入开着] = useState(Boolean(直接粘贴));
  /** ?new=1 / ?import=paste 进来就开：等水合完再开。服务端先画一个开着的弹窗，会和客户端那一版对不上（跟进页同一写法） */
  const 已水合 = useSyncExternalStore(无订阅, () => true, () => false);
  /*
    ?new=1 / ?import=paste 是「一次性」的：读完就从地址上抹掉（2026-10-02 排查桌面端 D5）。
    桌面端的壳会记住最后停在哪一页（带着 query），不抹的话第一天点过「手动录一位」，
    之后每次打开应用、每次刷新都会自己弹出新建框。首页的 ?q= 也是这么抹的。
  */
  useEffect(() => {
    if (!直接新建 && !直接粘贴) return;
    const q = new URLSearchParams(window.location.search);
    q.delete("new");
    q.delete("import");
    router.replace(q.size ? `/customers?${q}` : "/customers", { scroll: false });
    // 只在进来那一下
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 收起来的那三个里还筛着几个。收起来不等于可以不告诉人 */
  const 更多筛了 = [f.grade, f.decisionStatus, f.channelOwnerId, f.source].filter(Boolean).length;
  /** 一共筛着几个。0 的时候「重置」看不见——没筛过的页面上它是个哑按钮（位置留着，见 ResetFilters） */
  const 筛了 = Object.values(f).filter(Boolean).length;
  /**
   * 只有一个人的库：负责人列、负责人筛选、渠道负责人、批量分配都不摆（审查 D2 / M3）。
   * 13 寸窗口下负责人那一列正好把「最近跟进」挤出视野，而它每一格都是同一个名字。
   * 正筛着某个负责人（从数据页点名字进来的）时照摆，不然人看不见自己筛了什么
   */
  const 不问归属 =
    !f.salesOwnerId && !f.channelOwnerId && !f.pool &&
    列表不问归属(users, rows.flatMap((r) => [r.salesOwnerName, r.channelOwnerName]));

  /** 外贸模版（2026-10-05 外贸客户建议），见 lib/business-config.ts 外贸精简 */
  const 外贸 = 外贸精简(b);
  const 空 = <span className="muted">—</span>;
  const 外贸列: 列<CustomerRow>[] = [
    { title: "国家", key: "country", width: 100, render: (_: unknown, r) => r.extra?.country ?? 空 },
    {
      title: "WhatsApp", key: "whatsapp", width: 150,
      // 点号码直接打开对话（wa.me）。停在链接上不跳进这位的记录页（行点击会进记录页）
      render: (_: unknown, r) => {
        const 网址 = WhatsApp网址(r.extra?.whatsapp);
        return 网址 ? <a href={网址} target="_blank" rel="noreferrer" className="nowrap" onClick={(e) => e.stopPropagation()} title="在 WhatsApp 里打开对话">{r.extra?.whatsapp}</a> : 空;
      },
    },
    {
      title: "邮箱", key: "email", width: 190,
      render: (_: unknown, r) => (r.extra?.email ? <a href={`mailto:${r.extra.email}`} onClick={(e) => e.stopPropagation()} style={{ display: "inline-block", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }} title={r.extra.email}>{r.extra.email}</a> : 空),
    },
    { title: "微信", key: "wechat", width: 120, 默认: false, render: (_: unknown, r) => r.extra?.wechat ?? 空 },
    { title: "来源", key: "source", width: 110, 默认: false, render: (_: unknown, r) => r.extra?.source ?? 空 },
  ];

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
    // 外贸不摆预计签约（2026-10-05 外贸客户：「没有意义」——采购时间点看商机的询盘时间）
    ...(外贸 ? [] : [{
      title: "预计签约", key: "expectedSignAt", dataIndex: "expectedSignAt", width: 116,
      render: (v: string | null) => <span className="muted nowrap">{v ? fmtDate(v) : "—"}</span>,
    }]),
    /*
      外贸档案的列（2026-10-05 外贸客户：「增加列：国家，Whatsapp，Wechat，邮箱」）。
      国家、WhatsApp、邮箱默认摆；微信、来源收在「列」里
    */
    ...(外贸 ? 外贸列 : []),
    ...(不问归属 ? [] : [{
      title: "负责人", 列名: "负责人", key: "salesOwnerName", dataIndex: "salesOwnerName", width: 140,
      // 在公海里：写「公海（原 X）」——原负责人还挂着，但谁都能领
      render: (v: string, r: CustomerRow) => r.pool
        ? <Tag className="pool-tag" title={`${公海标签(v)} · ${r.pool.reason === "手动" ? "手动放进公海" : r.pool.reason}`}>{公海标签(v)}</Tag>
        : <UserCell name={v} size={24} />,
    }]),
    {
      title: "最近跟进", key: "lastFollowAt", dataIndex: "lastFollowAt", width: 208,
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
      title: <span title={`按 ${f.sortCurrency || b.currency} 金额在全部筛选结果中排序，其他币种不相加`}>{签约叫(b)}金额</span>, 列名: `${签约叫(b)}金额`, key: "signedAmount", dataIndex: "signedAmount", width: 120, 默认: false,
      sorter: true,
      sortOrder: 金额排序 === "amount-asc" ? "ascend" : 金额排序 === "amount-desc" ? "descend" : null,
      render: (v: number, r) => (v > 0 ? <span style={{ fontWeight: 500 }}>{合计文字(签约各币(r))}</span> : <span className="muted">—</span>),
    },
    // 推荐人、渠道归属、渠道负责人：外贸不摆（推荐分佣链是教培那一套，外贸看来源）
    ...(外贸 ? [] : [
      { title: "推荐人", key: "referrerName", dataIndex: "referrerName", width: 120, 默认: false, render: (v: string | null) => v ?? <span className="muted">自然流量</span> },
      {
        title: "渠道归属", key: "attributionName", dataIndex: "attributionName", width: 120, 默认: false,
        render: (v: string | null) => (v ? <Tag style={{ margin: 0, borderRadius: 6 }}>{v}</Tag> : <span className="muted">—</span>),
      },
    ]),
    ...(不问归属 || 外贸 ? [] : [{
      title: "渠道负责人", key: "channelOwnerName", dataIndex: "channelOwnerName", width: 130, 默认: false,
      render: (v: string | null) => (v ? <UserCell name={v} size={24} /> : <span className="muted">—</span>),
    }]),
    {
      // 这一页有公海里的才多一个「领取」、才加宽：表格本来就比 13 寸窗口宽一点，不为用不上的按钮再挤 30px
      title: "", key: "action", width: !不问归属 && rows.some((r) => r.pool) ? 108 : 78, 常驻: true, fixed: "right",
      render: (_, r) => (
        // 纯图标按钮必须自带可访问名称：没有它，屏幕阅读器只会读出「按钮」，
        // 自动化也只能按位置取第一个——这类选择器一改动就漂。
        // 原来还有个「详情」按钮，去掉了：整行点进去就是详情，一行里不摆两条同样的路
        <Space size={2}>
          {r.pool && !不问归属 && (
            <Button aria-label={`领取 ${r.name}`} title="领取：负责人改成我"
              type="text" size="small" icon={<UserAddOutlined />} onClick={async () => 公海提示(await 领取([r.id]), "领取", [r.id])} />
          )}
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
            {!空库 && (<>
              <Button
                icon={<ExportOutlined />}
                loading={导出中}
                onClick={async () => {
                  // 按服务端这次查询用的条件导全部（filters），不是当前这一页，也不是输入框里还没搜的草稿
                  const controller = new AbortController();
                  导出取消.current = controller;
                  set导出中(true);
                  try {
                    const r = await 完整导出(filters, b, set导出进度, controller.signal);
                    message.success(`已完整导出 ${r.客户} 位${b.customer}、${r.跟进} 条跟进，ZIP内附分批Excel和核对清单`);
                  } catch (error) {
                    if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "导出失败，请重试");
                  } finally {
                    导出取消.current = null;
                    set导出中(false);
                    set导出进度("");
                  }
                }}
              >
                导出
              </Button>
              {导出中 && <Space><span role="status" style={{ fontSize: 12 }}>{导出进度}</span><Button size="small" onClick={() => 导出取消.current?.abort()}>取消导出</Button></Space>}
            </>)}
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
          hint: 外贸
            ? `${b.customer}是这套系统的中心：跟进记录、商机、订单都挂在他身上。`
            : `${b.customer}是这套系统的中心：跟进记录、商机、签约都挂在他身上，推荐归属也按他这条线往上算。`,
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
              <Tag closable onClose={() => apply({ createdWithin: "" })} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看本月新增
              </Tag>
            )}
            {直接推荐 && (
              <Tag closable onClose={() => apply({ directOf: "" })} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看「{直接推荐}」直接带来的 · {total} 位
              </Tag>
            )}
            {本批 && (
              <Tag closable onClose={() => apply({ batch: "" })} color="processing" style={{ margin: 0, borderRadius: 999, padding: "3px 10px" }}>
                只看刚导入的这一批 · {本批.几位} 位
              </Tag>
            )}
            <ListSearch
              placeholder={外贸 ? `姓名 / 电话 / ${b.fields.school} / 联系人 / 订单号 / 邮箱` : `姓名 / 电话 / ${b.fields.school} / ${b.fields.major} / 备注 / 订单号`}
              value={f.keyword}
              onChange={(v) => setF({ ...f, keyword: v })}
              onSearch={(v) => apply({ keyword: v })}
            />
            <Select style={{ width: 140 }} placeholder="全部跟进状态" allowClear
              value={f.followStatus || undefined} onChange={(v) => apply({ followStatus: v ?? "" })}
              options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
            {/* 外贸：国家是第一眼要分的（时差、市场、报价口径），摆在外面；只给库里真有的国家 */}
            {外贸 && (国家们.length > 0 || f.country) && (
              <Select style={{ width: 130 }} placeholder="全部国家" allowClear showSearch
                value={f.country || undefined} onChange={(v) => apply({ country: v ?? "" })}
                options={[...new Set([...国家们, ...(f.country ? [f.country] : [])])].map((x) => ({ value: x, label: x }))} />
            )}
            {!不问归属 && (
              /* 公海是负责人下拉的第一项（第 6 块）：它就是「没人负责的那一池」。
                 原来单摆一个开关，1024 宽时把「更多筛选」挤到了第二行 */
              <Select style={{ width: 150 }} placeholder="全部负责人" allowClear
                value={f.pool ? 公海值 : f.salesOwnerId || undefined}
                onChange={(v) => apply(v === 公海值 ? { pool: "1", salesOwnerId: "" } : { salesOwnerId: v ?? "", pool: "" })}
                options={[{ value: 公海值, label: "公海" }, ...成员选项(users)]} />
            )}
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={
                <Space orientation="vertical" size={10} style={{ width: 220 }}>
                  <Select style={{ width: "100%" }} placeholder={`全部${b.fields.grade}`} allowClear
                    value={f.grade || undefined} onChange={(v) => apply({ grade: v ?? "" })}
                    options={[...b.grades.map((g) => ({ value: g, label: g })), ...旧职位.map((g) => ({ value: g, label: `${g}（已不在选项里）` }))]} />
                  <Select style={{ width: "100%" }} placeholder="全部决策状态" allowClear
                    value={f.decisionStatus || undefined} onChange={(v) => apply({ decisionStatus: v ?? "" })}
                    options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))} />
                  {外贸 && (
                    <Select style={{ width: "100%" }} placeholder="全部来源" allowClear showSearch
                      value={f.source || undefined} onChange={(v) => apply({ source: v ?? "" })}
                      options={[...new Set([...b.sources, ...(f.source ? [f.source] : [])])].map((x) => ({ value: x, label: x }))} />
                  )}
                  {!不问归属 && !外贸 && (
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
                    可撤销提示(res, bulkSummary(res, `已转给 ${o.label}`), assignSalesOwner, () => 撤销改负责人(res.原值 ?? [], o.value, res.带过来));
                  },
                })),
              }}
            >
              <Button size="small" icon={<UserSwitchOutlined />}>批量分配</Button>
            </Dropdown>}
            {!不问归属 && (选中行.some((r) => r.pool) ? (
              <Button size="small" icon={<UserAddOutlined />}
                onClick={async () => { const ids = 选中行.filter((r) => r.pool).map((r) => r.id); 公海提示(await 领取(ids), "领取", ids); 清空(); }}>
                领取
              </Button>
            ) : (
              <Button size="small" icon={<InboxOutlined />}
                onClick={async () => { 公海提示(await 放进公海(selected), "放进", selected); 清空(); }}>
                放进公海
              </Button>
            ))}
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
        排序={(key, order) => { if (key === "signedAmount") apply({ sort: order === "ascend" ? "amount-asc" : order === "descend" ? "amount-desc" : "", sortCurrency: f.sortCurrency || b.currency }); }}
        汇总={金额排序 && <Space wrap style={{ marginBottom: 12 }}><span>金额按</span><CurrencySelect aria-label="金额排序币种" value={f.sortCurrency || b.currency} onChange={v => apply({ sortCurrency: v })}/><span>在全部筛选结果中{金额排序 === "amount-asc" ? "升序" : "降序"}排列；其他币种不相加</span></Space>}
        分页={{
          当前页: page,
          每页: pageSize,
          总数: total,
          翻页,
        }}
      />

      <CustomerForm
        open={formOpen && 已水合}
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
        open={导入开着 && 已水合}
        b={b}
        aiEnabled={Boolean(aiEnabled)}
        初始来路={直接粘贴 ? "文本" : undefined}
        onClose={() => set导入开着(false)}
        onDone={() => router.refresh()}
        看这一批={(id) => router.push(`/customers?batch=${id}`)}
        有别的成员={users.length > 1}
      />
    </>
  );
}
