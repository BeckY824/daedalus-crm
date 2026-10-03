"use client";

import OrderForm from "../../orders/OrderForm";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Drawer, Dropdown, Input, Space, Tag, Avatar, Checkbox, Tooltip, App, Select, Typography } from "antd";
import {
  DownOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  UnorderedListOutlined,
  InboxOutlined,
  UserAddOutlined,
  ThunderboltOutlined as AiOutlined,
} from "@ant-design/icons";
import { motion, AnimatePresence } from "motion/react";
import InlineConfirm from "@/components/InlineConfirm";
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_STATUSES, DECISION_STATUSES, FOLLOW_RECORD_STATUS_COLOR } from "@/lib/constants";
import { dayjs, duration, fmtDate, fmtDateTime, initial, avatarColor, AVATAR_TEXT, 独自一人 } from "@/lib/utils";
import { FollowStatusTag, StageTag, DecisionStatusTag, FOLLOW_TYPE_ICON } from "@/components/ui";
import { useBusiness } from "@/lib/business-client";
import { statusLabel } from "@/lib/business-config";
import FollowUpForm from "./FollowUpForm";
import TaskForm from "./TaskForm";
import PlanForm from "./PlanForm";
import ContactForm from "./ContactForm";
import ContractForm, { type ContractRow } from "./ContractForm";
import CustomerForm from "../CustomerForm";
import InlineField from "./InlineField";
import AiPanel from "./AiPanel";
import StarButton from "./StarButton";
import AiCost from "@/components/AiCost";
import { toggleTask, deleteTask, deleteFollowUp, restoreFollowUp, completePlan, saveFollowUp } from "./actions";
import { useContactRemoval } from "./useContactRemoval";
import { 开名单, useNarrow, useRosterInDrawer, useWidth } from "@/lib/roster";
import { 登记详情名 } from "@/lib/page-rows";
import Heat, { 冷热说法, 要看冷热 } from "@/components/Heat";
import { deleteContract } from "../actions";
import type { RecordProps, FollowUpRow, ContactRow } from "./types";
import { useMotionTheme } from "@/components/MotionTheme";
import { 截止说法, 已过期 } from "@/lib/deadline";
import { 记下最近客户 } from "@/lib/last-customer";
import { 金额, 合计文字 } from "@/lib/currency";
import { 公海标签 } from "@/lib/pool";
import { 带走说法 } from "@/lib/carry-over";
import { 放进公海, 领取, 撤销公海 } from "../pool-actions";

/**
 * 记录页（v0.4）：三栏。
 *   左：档案——点一下就能改，不弹窗
 *   中：一条时间线，跟进与签约按时间合成一条流；顶部是速记框，粘一段就能记
 *   右：AI 面板常驻——打开谁，它已经读完了谁；下面是计划与待办
 * 没有页签。联系人 / 商机 / 签约都是档案的一部分，放左栏。
 */

/**
 * 删掉最后一笔签约后跟进状态退到哪一档：退单和录错是两回事，由操作的人选。
 * 标签**运行时拼**，不写死——状态的显示名跟着业务配置走（通用版里「与家人商议」叫「内部讨论」）。
 */
const REVERT_CHOICES = [
  { value: "意向较高", decision: "与家人商议", 说明: "谈崩了，还想再争取" },
  { value: "跟进中", decision: "了解中", 说明: "录错了，回到普通跟进" },
  { value: "已流失", decision: "暂不考虑", 说明: "确定不报了" },
] as const;

type Entry =
  | { kind: "follow"; at: string; f: FollowUpRow }
  | { kind: "contract"; at: string; c: ContractRow };

/** 负责人下拉的选项：现任不在候选里（管理员、已停用）时补进去，标上「（不在候选里）」，别显示成一串 id */
function 带上现任(users: { id: string; name: string }[], 现任: string | null, 现任名: string | null | undefined) {
  const 选项 = users.map((u) => ({ value: u.id, label: u.name }));
  if (现任 && !users.some((u) => u.id === 现任)) 选项.unshift({ value: 现任, label: `${现任名 ?? "（已删除的成员）"}（不在候选里）` });
  return 选项;
}

export default function RecordView({
  customer,
  contacts,
  contracts,
  opportunities,
  报价记录 = [],
  订单 = [],
  tasks,
  plan,
  followUps,
  users,
  channels,
  referrableCustomers,
  aiEnabled,
  已收藏 = false,
  能放公海 = false,
}: RecordProps) {
  const { 曲线, 时长, 间隔 } = useMotionTheme();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const { 问怎么拿掉 } = useContactRemoval();
  const revertChoice = useRef<string>(REVERT_CHOICES[0].value);
  const [报价全开, set报价全开] = useState(false);
  const [建订单, set建订单] = useState(false);
  /** 下次跟进过了几天（按日历天；今天到期不算过） */
  /** 已签约按币种分开写（「US$ 3,200 · ¥ 18,000」）——不同币种不能加在一起。老调用方没给 signedTotals 就按人民币 */
  const 已签约文字 = 合计文字(customer.signedTotals ?? [{ 币种: "CNY", 合计: customer.signedAmount }]);
  const 计划过期天 = plan ? Math.max(0, dayjs().startOf("day").diff(dayjs(plan.plannedAt).startOf("day"), "day")) : 0;
  // 右边的全局 AI 面板据此知道「他」「这位」是谁（lib/ai-context-page.ts 的客户详情那支）
  useEffect(() => {
    登记详情名(customer.name);
    return () => 登记详情名(null);
  }, [customer.name]);
  // 左栏点「客户」时回到这一位（customers/recent）
  useEffect(() => 记下最近客户(customer.id), [customer.id]);

  const [filter, setFilter] = useState<string>("全部");
  const [memo, setMemo] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);

  const [followOpen, setFollowOpen] = useState(false);
  const [followInit, setFollowInit] = useState<{ record: FollowUpRow | null; aiText?: string }>({ record: null });
  const [taskOpen, setTaskOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  /*
    从到点提醒点进来（desktop/reminders.js 带 ?focus=plan:… / task:…）：把那一条滚到眼前、闪一下，
    人不用在一页里自己找「刚才叫我的是哪件事」。闪完把参数去掉，刷新不会再闪一遍
  */
  useEffect(() => {
    const 要 = new URLSearchParams(window.location.search).get("focus");
    if (!要) return;
    const el = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(要)}"]`);
    router.replace(window.location.pathname, { scroll: false });
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.add("rec-tl-item-flash");
    const t = setTimeout(() => el.classList.remove("rec-tl-item-flash"), 1600);
    return () => clearTimeout(t);
    // 只在进来那一下看
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 这次打开计划表单是「排下一次」（新建，默认一周后），不是改眼前这条（审查 M10） */
  const [排新计划, set排新计划] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<ContractRow | null>(null);
  /**
   * 两条断点（见 globals.css 里 .rec 上面那段）：
   * 1440 以下名单收成抽屉，1180 以下 AI 也收成抽屉。
   * 收起来的东西必须有一个看得见的开关，否则就是没了。
   */
  const 名单在抽屉里 = useRosterInDrawer();
  /**
   * AI 栏收不收看正文实际多宽，不看视口：右边的全局面板开着时视口断点会误判（见 lib/roster.ts）。
   * 1090 = 资料 240 + AI 栏 340 + 两道间距 + 时间线至少 480。原来是 908（视口 1180 减左栏和留白，那时还没有名单），
   * 时间线只剩不到 300：1512 宽的 15 寸、1920 开着面板，「直接记」都折到第二行，最要紧的一栏最窄（2026-10-03 五档窗口走查）。
   * 收起来的 AI 栏在头部「AI」按钮里，一点就开。630 以下单栏（对应视口 900）。
   * 量到之前先按视口猜。
   */
  const recRef = useRef<HTMLDivElement>(null);
  const 正文宽 = useWidth(recRef);
  const 视口窄 = useNarrow("(max-width: 1673px)");
  const AI在抽屉里 = 正文宽 === null ? 视口窄 : 正文宽 < 1090;
  const 单栏 = 正文宽 !== null && 正文宽 < 630;
  const [AI抽屉开着, setAI抽屉开着] = useState(false);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      ...followUps.filter((f) => filter === "全部" || filter === f.type).map((f) => ({ kind: "follow" as const, at: f.occurredAt, f })),
      ...(filter === "全部" || filter === "CONTRACT" ? contracts.map((c) => ({ kind: "contract" as const, at: c.signedAt, c })) : []),
    ];
    return list.sort((a, b2) => dayjs(b2.at).valueOf() - dayjs(a.at).valueOf());
  }, [followUps, contracts, filter]);

  const openTasks = tasks.filter((t) => !t.done);

  /**
   * 待办勾完成：这一条原地留几秒（划线），提示里给「撤销」，然后再收起（交互审查 S7-③）。
   * 原来一勾就从记录页消失，记录页又不列已完成的，误勾了只能去「跟进 → 计划 → 已完成」里找。
   *
   *   勾选态 —— 先按人点的来（乐观），服务端的 done 跟上来以后这一条自己退掉
   *   留着   —— 勾完成的那几条，到点收起；撤销了（服务端又是未完成）也自己退掉
   * 撤销 = 取消完成，走同一个 toggleTask；在留着的那几秒里把勾点掉也是撤销。
   */
  const [勾选态, set勾选态] = useState<Record<string, boolean>>({});
  const [留着, set留着] = useState<string[]>([]);
  const 收起计时 = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const m = 收起计时.current;
    return () => m.forEach((t) => clearTimeout(t));
  }, []);
  // 服务端的待办换了一版（router.refresh 回来）就对一下账，在渲染里改，不放 effect
  const [上次的待办, set上次的待办] = useState(tasks);
  if (上次的待办 !== tasks) {
    set上次的待办(tasks);
    const 服务端 = new Map(tasks.map((t) => [t.id, t.done]));
    const 剩态 = Object.entries(勾选态).filter(([id, v]) => 服务端.has(id) && 服务端.get(id) !== v);
    if (剩态.length !== Object.keys(勾选态).length) set勾选态(Object.fromEntries(剩态));
    const 剩留 = 留着.filter((id) => 服务端.get(id) !== false);
    if (剩留.length !== 留着.length) set留着(剩留);
  }
  const 已完成 = (t: { id: string; done: boolean }) => 勾选态[t.id] ?? t.done;
  // 服务端按「未完成在前、再按截止」排，刚勾完的那条会跳到末尾；这里只按截止排，它就还在原处
  const 待办行 = tasks
    .filter((t) => !已完成(t) || 留着.includes(t.id))
    .sort((a, b2) => (a.dueAt ?? "").localeCompare(b2.dueAt ?? ""));
  /** 留几秒。和提示条一样长：提示收了，这一条也收 */
  const 留秒 = 5;

  async function 勾待办(t: (typeof tasks)[number], 完成: boolean) {
    const 计时 = 收起计时.current.get(t.id);
    if (计时) clearTimeout(计时);
    收起计时.current.delete(t.id);
    set勾选态((s) => ({ ...s, [t.id]: 完成 }));
    if (完成) set留着((s) => (s.includes(t.id) ? s : [...s, t.id]));
    else message.destroy(`task-${t.id}`);
    try {
      await toggleTask(t.id, 完成);
    } catch {
      set勾选态((s) => ({ ...s, [t.id]: !完成 }));
      message.error("没改成，再试一次");
      return;
    }
    router.refresh();
    if (!完成) return void message.success(`「${t.title}」已改回未完成`);
    message.success({
      key: `task-${t.id}`,
      duration: 留秒,
      content: (
        <span>
          「{t.title}」已完成
          <Button type="link" size="small" onClick={() => void 勾待办(t, false)}>
            撤销
          </Button>
        </span>
      ),
    });
    收起计时.current.set(
      t.id,
      setTimeout(() => {
        收起计时.current.delete(t.id);
        set留着((s) => s.filter((x) => x !== t.id));
      }, 留秒 * 1000),
    );
  }
  /**
   * 完成眼前这条计划（审查 M10）。提示里带「撤销」和「排下一次」：
   * 原来点完「下次跟进」那块直接变成「尚未安排」，点错了改不回来，做完了也没人问下一次什么时候
   */
  async function 完成计划(p: NonNullable<typeof plan>, 顺带?: string) {
    await completePlan(p.id);
    router.refresh();
    const key = `plan-${p.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          {顺带 ?? `「${p.subject}」已完成`}
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              await completePlan(p.id, false);
              message.success(`「${p.subject}」已改回未完成`);
              router.refresh();
            }}
          >
            撤销
          </Button>
          <Button type="link" size="small" onClick={() => { message.destroy(key); set排新计划(true); setPlanOpen(true); }}>
            排下一次
          </Button>
        </span>
      ),
    });
  }

  const fingerprint = `${followUps.length}:${followUps[0]?.occurredAt ?? ""}:${followUps[0]?.id ?? ""}`;

  /** 公海（第 6 块）：放进 / 领取这一位，提示条上带一次撤销（和列表上同一个做法） */
  async function 公海动作(动作: "放进" | "领取") {
    const res = 动作 === "放进" ? await 放进公海([customer.id]) : await 领取([customer.id]);
    router.refresh();
    if (!res.ok) return void message.error(res.error);
    if (!res.updated) return void message.info(动作 === "放进" ? "已经在公海里了" : "已经被别人领走了");
    const 原 = 动作 === "领取" ? (res.原负责人 ?? []) : [{ id: customer.id, 值: "" }];
    const key = `pool-${动作}-${customer.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          {动作 === "放进" ? "已放进公海，谁都能领" : `已领取，负责人改成你${带走说法(res.带走)}`}
          <Button type="link" size="small" onClick={async () => {
            message.destroy(key);
            const r = await 撤销公海(动作, 原, res.ok ? res.带过来 : undefined);
            router.refresh();
            if (!r.ok) return void message.error(`没能撤销：${r.error}`);
            message.success("已撤销");
          }}>撤销</Button>
        </span>
      ),
    });
  }

  function openFollow(record: FollowUpRow | null, aiText?: string) {
    setFollowInit({ record, aiText });
    setFollowOpen(true);
  }

  /** 速记框的两个出口：交给 AI 解析，或者不解析直接记一笔「其他记录」 */
  async function quickSave() {
    const text = memo.trim();
    if (!text) return;
    setQuickSaving(true);
    const res = await saveFollowUp({
      customerId: customer.id,
      type: "OTHER",
      title: "",
      content: text,
      status: "已完成",
      occurredAt: new Date().toISOString(),
    });
    setQuickSaving(false);
    if (!res.ok) {
      message.error(res.error);
      return;
    }
    setMemo("");
    router.refresh();
  }

  return (
    <>
      <div className="rec-head">
        {/*
          没有「← 返回列表」。左边就是窄名单，换一个人点一下就换（设计稿 12/PAGE：
          「切人不再返回列表」）；真要回列表，侧栏那一项一直在。
          名单收窄进抽屉时（<1440）才补一个「换一位」——那时它才真的没了。
        */}
        {/* 头像圆片 + 名字 + 星（2026-10-02 照毛玻璃原型）：一眼认出这是谁，星是「放到左栏，下次一点就到」 */}
        <span className="rec-head-av" aria-hidden="true" style={{ background: avatarColor(customer.name), color: AVATAR_TEXT }}>
          {initial(customer.name)}
        </span>
        <div className="rec-head-id">
          <div className="rec-head-line">
            <h1 className="rec-head-name" style={{ margin: 0 }}>{customer.name}</h1>
            <StarButton customerId={customer.id} 初值={已收藏} />
          </div>
          {/* 副标题是这个人的三个定位：年级 · 专业 · 谁在跟。没填的那项不占位 */}
          <div className="rec-head-sub">
            {[customer.grade, customer.major, customer.salesOwnerName].filter(Boolean).join(" · ")}
          </div>
        </div>
        {名单在抽屉里 && (
          <Button size="small" icon={<UnorderedListOutlined />} onClick={开名单}>
            换一位（⌘K）
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {aiEnabled && AI在抽屉里 && (
          <Button size="small" icon={<AiOutlined />} onClick={() => setAI抽屉开着(true)} style={{ marginRight: 8 }}>
            AI
          </Button>
        )}
        <Space.Compact>
          <Button type="primary" onClick={() => openFollow(null)}>
            记录跟进
          </Button>
          <Dropdown
            menu={{
              items: [
                ...FOLLOW_TYPES.map((t) => ({ key: t.value, label: t.label, onClick: () => openFollow({ type: t.value } as FollowUpRow) })),
                { type: "divider" as const },
                { key: "edit", icon: <EditOutlined />, label: `编辑${b.customer}资料`, onClick: () => setCustOpen(true) },
                // 公海（第 6 块）：多人时、我是负责人或管理员、还不在公海里
                ...(!独自一人(users) && 能放公海 && !customer.pool
                  ? [{ key: "pool", icon: <InboxOutlined />, label: "放进公海", onClick: () => void 公海动作("放进") }]
                  : []),
              ],
            }}
          >
            <Button type="primary" icon={<DownOutlined />} />
          </Dropdown>
        </Space.Compact>
      </div>

      {/*
        标签行：跟进状态、决策状态、预计签约（设计稿 12/PAGE 里紧跟在名字下面那一行）。
        这三样原来压在左栏档案卡里，要先把视线移到侧边才看得到这个人现在是什么状态——
        而它恰恰是打开一条记录时第一个要知道的事。两个状态点一下就能改，
        预计签约只读（在档案里改），所以它不长得像按钮。
      */}
      <div className="rec-tags">
        <StatusPicker customerId={customer.id} field="followStatus" value={customer.followStatus} options={FOLLOW_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))}>
          <FollowStatusTag status={customer.followStatus} />
        </StatusPicker>
        <StatusPicker customerId={customer.id} field="decisionStatus" value={customer.decisionStatus} options={DECISION_STATUSES.map((s) => ({ value: s, label: statusLabel(b, s) }))}>
          <DecisionStatusTag status={customer.decisionStatus} />
        </StatusPicker>
        {/* 来源（照毛玻璃原型的那枚「来源：WhatsApp」）：渠道或推荐人。自然流量不摆——没有来源就不占位 */}
        {customer.referrerName && <span className="rec-tags-n">来源：{customer.referrerName}</span>}
        {/* 在公海里（第 6 块）：标签写原负责人，旁边就是「领取」——看到就能接手 */}
        {customer.pool && (
          <span className="rec-tags-n rec-pool">
            <Tag className="pool-tag" title={customer.pool.reason === "手动" ? "手动放进公海" : customer.pool.reason}>{公海标签(customer.salesOwnerName)}</Tag>
            <Button size="small" type="link" icon={<UserAddOutlined />} onClick={() => void 公海动作("领取")}>领取</Button>
          </span>
        )}
        {/* 一个数都没有就不出现：「预计签约 —」占着一行却什么也没说 */}
        {(customer.signedAmount > 0 || customer.expectedSignAt) && (
          <span className="rec-tags-n">
            {customer.signedAmount > 0 ? `已签约 ${已签约文字}` : "预计签约"}
            {/* 已签约后面跟的是实际签约日（最近一笔；contracts 按签约日倒序）。原来跟的是预计签约日，
                9 月 28 日签的约读起来像 10 月 5 日签的（2026-09-28 审查 M2） */}
            {customer.signedAmount > 0
              ? contracts[0] && ` · ${fmtDate(contracts[0].signedAt)}`
              : customer.expectedSignAt && ` · ${fmtDate(customer.expectedSignAt)}`}
          </span>
        )}
        {要看冷热(customer.followStatus) && (
          <span className={`rec-heat${计划过期天 > 0 ? " is-over" : ""}`}>
            <Heat at={customer.lastFollowAt} />
            {/* 排了计划又过了期，比「几天没跟」更要紧：那是答应过的事 */}
            {计划过期天 > 0 ? `下次跟进已过 ${计划过期天} 天` : 冷热说法(customer.lastFollowAt)}
          </span>
        )}
      </div>

      <div ref={recRef} className={`rec${AI在抽屉里 ? " rec-2col" : ""}${单栏 ? " rec-1col" : ""}`}>
        {/* ================= 左栏：档案 ================= */}
        <aside className="rec-rail rec-card">
          {/* 名字和头像不在这儿重画一遍：页头上已经有了（设计稿 12/PAGE 的「基本资料」卡
              第一行就是电话）。电话是只读的——改手机号要查重，走完整表单 */}
          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>基本资料</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => setCustOpen(true)}>编辑全部</Button>
            </div>
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">电话</div>
              <div className="rec-field-v">{customer.phone || <span className="rec-field-empty">未填</span>}</div>
            </div>
            <InlineField customerId={customer.id} field="school" label={b.fields.school} value={customer.school} />
            <InlineField customerId={customer.id} field="major" label={b.fields.major} value={customer.major} />
            <InlineField customerId={customer.id} field="grade" label={b.fields.grade} value={customer.grade} kind="combo" options={b.grades.map((g) => ({ value: g, label: g }))} />
            {/* 选项里带上现任：负责人是管理员或已停用时不在候选里，原来下拉直接显示一串 id（排查 D8）。
                一个人用（桌面端）时这两格不摆：下拉里只有自己，摆着只是让人多想一下（和客户表单同一个 独自一人 规则） */}
            {!独自一人(users, customer.salesOwnerId) && (
              <InlineField customerId={customer.id} field="salesOwnerId" label="销售负责人" value={customer.salesOwnerId} kind="select" options={带上现任(users, customer.salesOwnerId, customer.salesOwnerName)} />
            )}
            {/* 渠道负责人默认跟着推荐链；这里改的是这一位的单独订正，清空即恢复按推荐链 */}
            {!独自一人(users, customer.channelOwnerId) && (
              <InlineField customerId={customer.id} field="channelOwnerId" label="渠道负责人" value={customer.channelOwnerId} kind="select" options={带上现任(users, customer.channelOwnerId, customer.channelOwnerName)} placeholder="按推荐链自动确定" 可清空 />
            )}
            <InlineField customerId={customer.id} field="expectedSignAt" label="预计签约" value={customer.expectedSignAt} kind="date" placeholder="未定" />
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">签约金额</div>
              <div className="rec-field-v">{customer.signedAmount > 0 ? 已签约文字 : <span className="rec-field-empty">未签约</span>}</div>
            </div>
            <InlineField customerId={customer.id} field="remark" label="备注" value={customer.remark} kind="textarea" placeholder="点击写备注" />
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>推荐关系</span>
            </div>
            <div className="rec-field" style={{ cursor: "default" }}>
              <div className="rec-field-k">推荐人</div>
              <div className="rec-field-v">{customer.referrerName ?? <span style={{ color: "var(--text-muted)" }}>自然流量</span>}</div>
            </div>
            <Tooltip title="推荐链往上第二代，不足两代取链条最顶端" placement="left">
              <div className="rec-field" style={{ cursor: "default" }}>
                <div className="rec-field-k">渠道归属</div>
                <div className="rec-field-v">{customer.attributionName ?? "—"}</div>
              </div>
            </Tooltip>

          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>联系人 {contacts.length > 0 && contacts.length}</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => { setEditingContact(null); setContactOpen(true); }}>添加联系人</Button>
            </div>
            {contacts.length === 0 && <div className="rec-empty">还没有联系人</div>}
            {contacts.map((c) => (
              <div key={c.id} className="rec-mini">
                <Avatar size={26} style={{ background: avatarColor(c.name), color: AVATAR_TEXT, fontSize: 12 }}>{initial(c.name)}</Avatar>
                {/* 截断成「母亲…」之后，鼠标停上去得看得到全名 */}
                <span className="rec-mini-n" title={c.name}>
                  {c.name}
                  {c.isPrimary && <Tag color="blue" style={{ marginLeft: 6, borderRadius: 6, fontSize: 12, lineHeight: "18px", padding: "0 5px" }}>关键</Tag>}
                </span>
                <span className="rec-mini-m">{c.position ?? c.phone ?? ""}</span>
                {/* 编辑 / 删除平时不占位（审查 M4）：原来两颗图标常驻，三个字的名字被挤成「周明远…」。
                    悬停或键盘焦点进来时盖在右边那段说明上出现，和时间线每条的做法一样 */}
                <span className="rec-mini-acts">
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑联系人 ${c.name}`} onClick={() => { setEditingContact(c); setContactOpen(true); }} />
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={`删除联系人 ${c.name}`}
                    // 先问只移出还是彻底删（2026-10-01 用户反馈：删完联系人页里也没了）
                    onClick={() => 问怎么拿掉(c)}
                  />
                </span>
              </div>
            ))}
          </div>

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>商机 {opportunities.length > 0 && opportunities.length}</span>
              <Link href="/opportunities">全部 ›</Link>
            </div>
            {opportunities.length === 0 && <div className="rec-empty">还没有商机</div>}
            {opportunities.map((o) => (
              // 两行：名字独占一行，阶段和金额在下面（审查 M4）。原来三样挤一行，
              // 264 宽的左栏里名字只剩「恒拓 · …」，截掉的恰恰是认出这一单的那半截
              <Link key={o.id} href={`/opportunities?keyword=${encodeURIComponent(o.name)}`} className="rec-mini rec-mini-2">
                <span className="rec-mini-n" title={o.name}>{o.name}</span>
                <span className="rec-mini-sub">
                  <StageTag stage={o.stage} />
                  <span className="rec-mini-m">{金额(o.amount, o.currency)}</span>
                </span>
              </Link>
            ))}
          </div>

          {/* 订单（2026-10-03，外贸模版才有）：每单一行，当前走到哪一步、有没有超期 */}
          {b.template === "trade" && (
            <div className="rec-sec">
              <div className="rec-sec-t">
                <span>订单 {订单.length > 0 && 订单.length}</span>
                <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => set建订单(true)}>新建订单</Button>
              </div>
              {订单.length === 0 && <div className="rec-empty">还没有订单。商机赢单时可以一起生成</div>}
              {订单.map((o) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="rec-mini rec-mini-2">
                  <span className="rec-mini-n">{o.no} · {金额(o.amount, o.currency)}</span>
                  <span className="rec-mini-sub">
                    <span className="rec-mini-m">{o.当前 ? `${o.当前.idx}. ${o.当前.name}` : "已走完"}</span>
                    {o.超期 > 0 ? <span className="ord-late">超期 {o.超期}</span> : <span className="rec-mini-m">{o.进度}%</span>}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {/*
            报价记录（2026-10-03）：这个客户历次报过的产品和单价，新的在前。没报过就不出现这一节（少即是多）。
            先摆 5 行，多了点开——左栏是档案，不是报价单
          */}
          {报价记录.length > 0 && (
            <div className="rec-sec">
              <div className="rec-sec-t">
                <span>报价记录 {报价记录.length}</span>
                {报价记录.length > 5 && (
                  <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => set报价全开(!报价全开)} aria-expanded={报价全开}>
                    {报价全开 ? "收起" : "全部"}
                  </Button>
                )}
              </div>
              {(报价全开 ? 报价记录 : 报价记录.slice(0, 5)).map((r, i) => (
                <Link key={`${r.quotedAt}-${i}`} href={`/opportunities?keyword=${encodeURIComponent(r.商机)}`} className="rec-mini rec-mini-2" title={`商机「${r.商机}」`}>
                  <span className="rec-mini-n" title={r.spec ? `${r.product}（${r.spec}）` : r.product}>
                    {r.product}
                    {r.spec && <span className="rec-mini-m"> · {r.spec}</span>}
                  </span>
                  <span className="rec-mini-sub">
                    <span className="rec-mini-m">
                      {金额(r.unitPrice, r.currency)} × {r.qty}{r.unit ? ` ${r.unit}` : ""}
                    </span>
                    <span className="rec-mini-m">{r.状态 === "WON" ? "成交 · " : ""}{fmtDate(r.quotedAt)}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}

          <div className="rec-sec">
            <div className="rec-sec-t">
              <span>签约 {contracts.length > 0 && contracts.length}</span>
              <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => { setEditingContract(null); setContractOpen(true); }}>登记签约</Button>
            </div>
            {contracts.length === 0 && <div className="rec-empty">还没有签约</div>}
            {contracts.map((c) => (
              <div key={c.id} className="rec-mini">
                <DollarOutlined style={{ color: "var(--success)" }} />
                <span className="rec-mini-n rec-mini-amt">{金额(c.amount, c.currency)}</span>
                <span className="rec-mini-m">{fmtDate(c.signedAt)}</span>
                <span className="rec-mini-acts">
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑这笔签约" onClick={() => { setEditingContract(c); setContractOpen(true); }} />
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除这笔签约" onClick={() => confirmDeleteContract(c)} />
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* ================= 中栏：时间线 ================= */}
        <section className="rec-col rec-card">
          <div className="rec-composer">
            <Input.TextArea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 8 }}
              maxLength={5000}
              placeholder={aiEnabled ? `记一笔，或直接粘贴和${b.customer}的微信聊天记录…` : "记一笔…"}
            />
            <div className="rec-composer-bar">
              <span className="rec-composer-hint">
                {aiEnabled ? "「AI 解析」会把它整理成跟进记录并留存原文；「直接记」原样存为一条记录" : "Enter 换行，写完点「直接记」"}
              </span>
              {aiEnabled && (
                <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} disabled={memo.trim().length < 5} onClick={() => openFollow(null, memo)}>
                  AI 解析
                  <AiCost />
                </Button>
              )}
              <Button size="small" loading={quickSaving} disabled={!memo.trim()} onClick={() => void quickSave()}>
                直接记
              </Button>
            </div>
          </div>

          {plan && (
            <div className="rec-plan" data-focus={`plan:${plan.id}`}>
              <span className="rec-plan-k">下次跟进</span>
              <span className="rec-plan-v">
                {plan.subject} · {plan.method}
              </span>
              {/* 截止时间和计划页、待办同一种说法（审查 D1）；具体几点在悬停里 */}
              <span className={`rec-plan-m${已过期(plan.plannedAt) ? " is-over" : ""}`} title={fmtDateTime(plan.plannedAt)}>
                {截止说法(plan.plannedAt)}
              </span>
              <Button size="small" type="text" onClick={() => { set排新计划(false); setPlanOpen(true); }}>
                改
              </Button>
              <Button size="small" type="text" icon={<CheckCircleOutlined />} onClick={() => void 完成计划(plan)}>
                完成
              </Button>
            </div>
          )}

          <div className="rec-filters">
            {["全部", ...FOLLOW_TYPES.map((t) => t.value), "CONTRACT"].map((k) => {
              const label = k === "全部" ? "全部" : k === "CONTRACT" ? "签约" : FOLLOW_TYPE_MAP[k]?.label ?? k;
              return (
                <span key={k} className={`rec-chip${filter === k ? " rec-chip-on" : ""}`} onClick={() => setFilter(k)}>
                  {label}
                </span>
              );
            })}
          </div>

          <div className="rec-tl">
            {entries.length === 0 && (
              <div style={{ padding: "36px 0", textAlign: "center", color: "var(--text-muted)" }}>
                {filter === "全部" ? "还没有任何记录。上面随手记一笔，或粘一段聊天记录让 AI 整理。" : "这个类型下还没有记录"}
              </div>
            )}
            {/* 打开一位的记录时逐条进场（间隔 70ms、八条以后一起）——原来 initial={false}，
                下面算好的 delay 从来没机会生效，整条时间线是「啪」一下出来的 */}
            <AnimatePresence>
              {entries.map((e, i) =>
                e.kind === "contract" ? (
                  <motion.div key={`c-${e.c.id}`} className="rec-tl-item" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(i, 8) * 间隔, duration: 时长.base, ease: 曲线.ease }}>
                    <div className="rec-tl-dot" style={{ background: "var(--success)" }}>
                      <DollarOutlined />
                    </div>
                    <div className="rec-tl-body">
                      <div className="rec-tl-contract">
                        <div className="rec-tl-head">
                          <span className="rec-tl-type">签约 {金额(e.c.amount, e.c.currency)}</span>
                          {e.c.remark && <span className="rec-tl-title" title={e.c.remark}>· {e.c.remark}</span>}
                          <span className="rec-tl-time">{fmtDate(e.c.signedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <FollowItem key={e.f.id} f={e.f} index={i} onEdit={() => openFollow(e.f)} onDelete={() => deleteFollow(e.f)} />
                ),
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* ================= 右栏：AI + 计划/待办 ================= */}
        <aside className="rec-right rec-rail">
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            {aiEnabled && !AI在抽屉里 && (
              <div className="rec-card">
                <AiPanel customerId={customer.id} customerName={customer.name} fingerprint={fingerprint} signed={customer.followStatus === "已签约"} hasRecords={followUps.length > 0} />
              </div>
            )}

            <div className="rec-card rec-side-card">
              <div className="rec-side-t">
                <span>待办 {openTasks.length > 0 && openTasks.length}</span>
                <Button type="link" size="small" style={{ padding: 0, height: "auto", fontWeight: 400 }} icon={<PlusOutlined />} onClick={() => setTaskOpen(true)}>
                  新建任务
                </Button>
              </div>
              {待办行.length === 0 && <Typography.Text type="secondary" style={{ fontSize: 13 }}>暂无待办</Typography.Text>}
              {/* 收起只淡出、不收高度：减弱动态时不许有位移，淡出在两种设置下都一样 */}
              <AnimatePresence initial={false}>
                {待办行.map((t) => (
                  <motion.div
                    key={t.id}
                    data-focus={`task:${t.id}`}
                    className={`rec-task${已完成(t) ? " is-done" : ""}`}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 时长.base, ease: 曲线.ease }}
                  >
                    <Checkbox checked={已完成(t)} onChange={(e) => void 勾待办(t, e.target.checked)} aria-label={`完成 ${t.title}`} />
                    <span className="rec-task-t">{t.title}</span>
                    {/* 「逾期 2 天」而不是「2 天前」（审查 D1）：欠着没做的事，不是发生过的事 */}
                    <span className="rec-task-due" title={t.dueAt ? fmtDateTime(t.dueAt) : undefined} style={{ color: !已完成(t) && 已过期(t.dueAt) ? "var(--danger)" : undefined }}>
                      {t.dueAt ? 截止说法(t.dueAt) : ""}
                    </span>
                    {/* 就地确认：一条待办删了还能再建，一句话说得完，不值得弹框（见 components/InlineConfirm.tsx） */}
                    <InlineConfirm
                      问="删除这条？"
                      做={async () => {
                        await deleteTask(t.id);
                        message.success("待办已删除");
                        router.refresh();
                      }}
                    >
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除待办" />
                    </InlineConfirm>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {!plan && (
              <div className="rec-card rec-side-card">
                <div className="rec-side-t">
                  <span>下次跟进</span>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>尚未安排</Typography.Text>
                <Button block style={{ marginTop: 10 }} onClick={() => setPlanOpen(true)}>
                  制定跟进计划
                </Button>
              </div>
            )}
          </Space>
        </aside>
      </div>

      {/* 1180 以下 AI 收进抽屉。面板本身一个字都不用改——它的状态挂在
          进程内任务表上（lib/ai-jobs），不在组件 state 里，关掉再开还在那儿 */}
      {aiEnabled && AI在抽屉里 && (
        <Drawer placement="right" styles={{ wrapper: { width: 380 } }} open={AI抽屉开着} onClose={() => setAI抽屉开着(false)} title={`AI · ${customer.name}`}>
          <AiPanel customerId={customer.id} customerName={customer.name} fingerprint={fingerprint} signed={customer.followStatus === "已签约"} hasRecords={followUps.length > 0} />
        </Drawer>
      )}

      {/* 弹窗：新建/编辑跟进仍用完整表单（字段多），其余小表单也保留 */}
      <FollowUpForm
        open={followOpen}
        onClose={() => setFollowOpen(false)}
        onSaved={() => {
          setFollowOpen(false);
          setMemo("");
          router.refresh();
        }}
        customerId={customer.id}
        record={followInit.record}
        initialAiText={followInit.aiText}
        /* 到期了（今天或更早）的那条计划：记完这一笔默认顺手完成它（审查 M9） */
        待收口计划={plan && !dayjs(plan.plannedAt).isAfter(dayjs().endOf("day")) ? plan : null}
        完成了计划={(p) => void 完成计划(p, `跟进已记录，计划「${p.subject}」一并完成`)}
        contacts={contacts}
        opportunities={opportunities}
        aiEnabled={aiEnabled}
      />
      {b.template === "trade" && <OrderForm open={建订单} customerId={customer.id} onClose={() => set建订单(false)} />}
      <TaskForm open={taskOpen} onClose={() => setTaskOpen(false)} onSaved={() => { setTaskOpen(false); router.refresh(); }} customerId={customer.id} />
      <PlanForm
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        onSaved={() => { setPlanOpen(false); router.refresh(); }}
        customerId={customer.id}
        record={排新计划 ? null : plan}
        默认天数={排新计划 ? 7 : 2}
      />
      <ContactForm open={contactOpen} onClose={() => setContactOpen(false)} onSaved={() => { setContactOpen(false); router.refresh(); }} customerId={customer.id} record={editingContact} />
      <ContractForm
        open={contractOpen}
        customerId={customer.id}
        editing={editingContract}
        onClose={(saved) => {
          setContractOpen(false);
          setEditingContract(null);
          if (saved) router.refresh();
        }}
      />
      <CustomerForm
        open={custOpen}
        editing={customer}
        users={users}
        channels={channels}
        customers={referrableCustomers}
        onClose={(saved) => {
          setCustOpen(false);
          if (saved) router.refresh();
        }}
      />
    </>
  );

  /**
   * 删一条跟进记录。**确认在那一行上就地问**（见 FollowItem 里的 InlineConfirm），
   * 所以这里不再弹框——原来那个框只有一句「删除这条跟进记录？」，
   * 盖半屏问一句话，代价比它防住的误点还大。
   */
  async function deleteFollow(f: FollowUpRow) {
    const r = await deleteFollowUp(f.id, customer.id);
    router.refresh();
    if (!r.ok) return void message.error(r.error);
    // 给一次撤销（排查 D2）：AI 速记的跟进连原文一起删，原来删了就再也找不回来
    const key = `follow-${f.id}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          已删除这条跟进
          <Button
            type="link"
            size="small"
            onClick={async () => {
              message.destroy(key);
              const u = await restoreFollowUp(r.快照);
              if (!u.ok) return void message.error(u.error);
              message.success("这条跟进回来了");
              router.refresh();
            }}
          >
            撤销
          </Button>
        </span>
      ),
    });
  }

  function confirmDeleteContract(r: ContractRow) {
    const 是最后一笔 = contracts.length === 1;
    modal.confirm({
      title: "删除这条签约记录？",
      content: !是最后一笔 ? (
        `金额 ${金额(r.amount, r.currency)}，删除后统计数据会同步变化。`
      ) : (
        <>
          <div>
            金额 {金额(r.amount, r.currency)}。这是该{b.customer}唯一一笔签约，删除后签约金额归零，跟进状态需要跟着退回，否则看板上会一直挂着「已签约、金额 0」。
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 6, fontSize: 13 }}>跟进状态退回到：</div>
            <Select
              style={{ width: "100%" }}
              defaultValue={revertChoice.current}
              onChange={(v) => (revertChoice.current = v)}
              options={[
                ...REVERT_CHOICES.map((c) => ({
                  value: c.value,
                  label: `${statusLabel(b, c.value)} · ${statusLabel(b, c.decision)}（${c.说明}）`,
                })),
                { value: "", label: `保持「${statusLabel(b, "已签约")}」不变（我知道自己在做什么）` },
              ]}
            />
          </div>
        </>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const picked = REVERT_CHOICES.find((c) => c.value === revertChoice.current);
        const res = await deleteContract(r.id, customer.id, 是最后一笔 && picked ? { followStatus: picked.value, decisionStatus: picked.decision } : null);
        router.refresh();
        if (!res.ok) {
          message.error(res.error);
          return;
        }
        message.success(是最后一笔 && picked ? `已删除，跟进状态已退回「${picked.value}」` : "已删除");
      },
    });
  }
}

/** 状态标签：点一下弹出下拉直接改，改完 Tag 过渡到新颜色 */
function StatusPicker({
  customerId,
  field,
  value,
  options,
  children,
}: {
  customerId: string;
  field: "followStatus" | "decisionStatus";
  value: string;
  options: { value: string; label: string }[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        selectedKeys: [value],
        items: options.map((o) => ({ key: o.value, label: o.label })),
        onClick: async ({ key }) => {
          if (key === value) return;
          setSaving(true);
          const { patchCustomer } = await import("../actions");
          const res = await patchCustomer(customerId, field, key);
          setSaving(false);
          if (!res.ok) message.error(res.error);
          else router.refresh();
        },
      }}
    >
      <motion.span style={{ cursor: "pointer", display: "inline-flex", opacity: saving ? 0.5 : 1 }} whileTap={{ scale: 0.96 }} layout>
        {children}
      </motion.span>
    </Dropdown>
  );
}

function FollowItem({ f, index, onEdit, onDelete }: { f: FollowUpRow; index: number; onEdit: () => void; onDelete: () => void }) {
  const { 曲线, 时长, 间隔 } = useMotionTheme();
  const meta = FOLLOW_TYPE_MAP[f.type] ?? FOLLOW_TYPE_MAP.OTHER;
  const [srcOpen, setSrcOpen] = useState(false);
  return (
    <motion.div id={`fu-${f.id}`} className="rec-tl-item" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: Math.min(index, 8) * 间隔, duration: 时长.base, ease: 曲线.ease }}>
      <div className="rec-tl-dot" style={{ background: meta.color }}>
        {FOLLOW_TYPE_ICON[f.type]}
      </div>
      <div className="rec-tl-body">
        <div className="rec-tl-head">
          <span className="rec-tl-type">{meta.label}</span>
          {f.title?.trim() && <span className="rec-tl-title" title={f.title}>· {f.title}</span>}
          {f.status !== "已完成" && (
            <Tag color={FOLLOW_RECORD_STATUS_COLOR[f.status] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
              {f.status}
            </Tag>
          )}
          {/* 时间和编辑/删除包在一起：图标得跟着时间走，不能按整个头部居中 */}
          <span className="rec-tl-when">
            {/* 今年的不写年份（审查 D5）：标题改成一行省略之后，每省一截时间就多露几个字的标题。全的在悬停里 */}
            <span className="rec-tl-time" title={fmtDateTime(f.occurredAt)}>
              {dayjs(f.occurredAt).isSame(dayjs(), "year") ? dayjs(f.occurredAt).format("M 月 D 日 HH:mm") : fmtDateTime(f.occurredAt)}
            </span>
            <span className="rec-tl-acts">
              <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label="编辑跟进" />
              {/* 就地确认，不弹框：一条跟进记录，删了还能再写一条——
                  后果一句话说得完的事，不值得一个盖住半屏的框（见 components/InlineConfirm.tsx） */}
              <InlineConfirm 问="删除这条？" 做={onDelete}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除跟进" />
              </InlineConfirm>
            </span>
          </span>
        </div>
        <div className="rec-tl-content">{f.content}</div>
        {f.sourceText && (
          <div style={{ marginTop: 2 }}>
            <Typography.Link style={{ fontSize: 12, color: "var(--text-muted)" }} onClick={() => setSrcOpen((v) => !v)}>
              {srcOpen ? "收起原文" : "查看原文"}
            </Typography.Link>
            <AnimatePresence>
              {srcOpen && (
                <motion.pre
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  style={{
                    marginTop: 6, marginBottom: 0, padding: "10px 12px", background: "var(--workbench)", border: "1px solid var(--line-soft)",
                    borderRadius: 8, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    fontFamily: "inherit", color: "var(--ink-soft)", maxHeight: 320, overflow: "auto",
                  }}
                >
                  {f.sourceText}
                </motion.pre>
              )}
            </AnimatePresence>
          </div>
        )}
        <div className="rec-tl-meta">
          {f.duration ? <span>时长 {duration(f.duration)}</span> : null}
          {f.contactName && <span>{f.contactName}{f.contactPosition ? `（${f.contactPosition}）` : ""}</span>}
          {f.participants && <span>参与人：{f.participants}</span>}
          {f.dueAt && <span>截止 {fmtDateTime(f.dueAt)}</span>}
          <span style={{ marginLeft: "auto" }}>{f.ownerName}</span>
        </div>
      </div>
    </motion.div>
  );
}
