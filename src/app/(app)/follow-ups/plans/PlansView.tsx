"use client";

import { useBusinessTimeZone } from "@/lib/business-client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Segmented, Space, Button, App, Tag } from "antd";
import { PlusOutlined, UnorderedListOutlined, CheckCircleOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import EmptyState from "@/components/EmptyState";
import { dayjs, fmtDateTime } from "@/lib/utils";
import { 是逾期 } from "@/lib/overdue";
import { 每批, 组名, 写每组 } from "@/lib/plans-groups";
import type { 轻行 as 轻列表行 } from "@/lib/plans-page";
import { toggleTask, completePlan, deletePlan, deleteTask } from "../../customers/[id]/actions";
import TaskForm from "../../customers/[id]/TaskForm";
import InlineConfirm from "@/components/InlineConfirm";
import PlanForm from "../../customers/[id]/PlanForm";
import { 截止说法 } from "@/lib/deadline";
import { 滚法 } from "@/lib/reduced-motion";
import CompletePlanModal, { 提示记完了, type 要完成的计划, type 记完了 as 记完了结果 } from "../../customers/[id]/CompletePlanModal";


/** 无空格的长客户名（AlRashidTrading…FreeZoneAuthority）曾把后面两个标签挤出这一行、压住「逾期 N 天」，1024 宽整页横滚（10-19 排版闸门）：名字可断行 */
const 客户名样式 = { minWidth: 0, overflowWrap: "anywhere" } as const;

/** 只用来认「水合完了没有」（见下面的 已水合） */
const 无订阅 = () => () => {};
type Plan = {
  id: string;
  subject: string;
  plannedAt: string;
  plannedHasTime?: boolean | null;
  method: string;
  /** 编辑框的版本号（J-105） */
  updatedAt: string;
  customerId: string;
  customerName: string;
  /** 档案里填了 WhatsApp 号：完成小框、排下一次的方式默认 WhatsApp（2026-10-17 PR26 手测） */
  有WhatsApp?: boolean;
  ownerId: string;
  ownerName: string;
};

type Task = {
  id: string;
  title: string;
  dueAt: string | null;
  dueHasTime?: boolean | null;
  /** 编辑框的版本号（J-105） */
  updatedAt: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

/** 旧记录未留存实际完成时间时保留 null，不拿编辑时间代替。 */
export type 已完成 = {
  key: string;
  kind: "plan" | "task";
  标题: string;
  方式?: string;
  计划时间: string | null;
  完成时间: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

/** 待办和跟进计划在这一页是同一件事：「我接下来要做的」。只是完成的方式不同 */
type 事项 = {
  key: string;
  kind: "plan" | "task";
  id: string;
  标题: string;
  时间: string | null;
  方式?: string;
  /** 打开「改」那一刻的 updatedAt，保存时当版本闸门（J-105） */
  版本: string;
  明确钟点?: boolean | null;
  customerId: string;
  customerName: string;
  有WhatsApp?: boolean;
  ownerId: string;
  ownerName: string;
};

/** 分组只要这三样：分批时页面手里只有「全部」的这三样，详情只有要摆出来的那些（lib/plans-page.ts） */
type 轻事项 = { key: string; 时间: string | null; ownerId: string };

const 计划成事项 = (p: Plan): 事项 => ({
  key: `plan:${p.id}`, kind: "plan", id: p.id, 标题: p.subject, 时间: p.plannedAt, 明确钟点: p.plannedHasTime, 方式: p.method, 版本: p.updatedAt,
  customerId: p.customerId, customerName: p.customerName, 有WhatsApp: p.有WhatsApp, ownerId: p.ownerId, ownerName: p.ownerName,
});
const 待办成事项 = (t: Task): 事项 => ({
  key: `task:${t.id}`, kind: "task", id: t.id, 标题: t.title, 时间: t.dueAt, 明确钟点: t.dueHasTime, 版本: t.updatedAt,
  customerId: t.customerId, customerName: t.customerName, ownerId: t.ownerId, ownerName: t.ownerName,
});

/**
 * 跟进计划。
 *
 * 原来是左右两张卡：左边「待办任务」，右边「跟进计划」。可人早上打开这一页
 * 想知道的不是「哪些是任务哪些是计划」，而是**哪些已经拖了、今天必须做哪些**——
 * 所以改成按时间分三组：逾期、今天、本周。两类事项混在一组里，各自带一个小标。
 *
 * 点完成之后那一行**留在原地 600 毫秒**再消失（划掉、压暗）。
 * 立刻抽走的话，下面的行会跳上来顶替它的位置，眼睛得重新找一遍自己看到哪儿了。
 */
export default function PlansView({
  plans,
  tasks,
  done,
  meId,
  预选客户,
  直接新建,
  全员 = false,
  轻,
  负责人,
  每组,
  补详情,
}: {
  plans: Plan[];
  tasks: Task[];
  done: 已完成[];
  meId: string;
  /** 从某位客户带过来的（?customer=）：「新建计划」预填这一位 */
  预选客户: { id: string; name: string } | null;
  /** ?new=1：进来就把新建框打开 */
  直接新建: boolean;
  /**
   * ?scope=all：从数据页那几张全团队口径的卡点进来，先看「全部成员」。
   * 原来写死「我的」：卡上写团队逾期 12，点进来「逾期 3」，对不上（2026-10-01 排查 C2）
   */
  全员?: boolean;
  /**
   * 分批（2026-10-24 企业版压测，lib/plans-page.ts）：事项太多时 plans / tasks 只有每组前 N 条的详情，
   * 轻 是全部未完成事项的 [key, 时间, 负责人下标]，组头条数、「我的 / 全部成员」都在它上面算。
   * 全取回来了的时候（个人版几乎都是）这四样都不带，页面和原来一模一样。
   */
  轻?: 轻列表行[];
  负责人?: string[];
  /** 每组摆几条（逾期、今天、本周、以后），「再看 50 条」加一批 */
  每组?: number[];
  /** 要摆、手里却没详情的那几条去取（plan-rows.ts）：刚新建的、浏览器和服务器时区不同分组差了的 */
  补详情?: (keys: string[]) => Promise<{ plans: Plan[]; tasks: Task[] }>;
}) {
  const timeZone = useBusinessTimeZone();
  const router = useRouter();
  const { message } = App.useApp();
  const [scope, setScope] = useState<string | number>(全员 ? "全部成员" : "我的");
  /**
   * 看待办还是看做完的。
   *
   * 点完成之后那条计划原来就从界面上彻底消失了——「我上周排的那次回访到底做没做」
   * 没有任何地方答得上来（2026-09-18 问到的）。默认仍然是「待办」：
   * 这一页首先是今天要干什么，回顾是第二位的。
   */
  const [看, set看] = useState<string | number>("待办");
  /** 刚点过完成、还留在原地的那几条 */
  const [刚完成, set刚完成] = useState<string[]>([]);
  /** 「排下一次」给哪一位排：完成一条计划之后提示条里点进来（审查 M10） */
  const [排给, set排给] = useState<{ customerId: string; 有WhatsApp?: boolean } | null>(null);
  /** 正在完成的那条计划：先弹小框记一笔（2026-10-16 外贸基础），待办照旧一点就完 */
  const [在完成, set在完成] = useState<(要完成的计划 & { key: string; 标题: string }) | null>(null);
  /** 正在改的那一条（计划或待办） */
  const [在改, set在改] = useState<事项 | null>(null);
  // 表单的 record 要稳定：它是 useEffect 的依赖，每次渲染新建一个对象会让表单边输入边被重置
  const 改计划 = useMemo(
    () => (在改?.kind === "plan" ? { id: 在改.id, subject: 在改.标题, plannedAt: 在改.时间 ?? new Date().toISOString(), plannedHasTime: 在改.明确钟点, method: 在改.方式 ?? "电话沟通", updatedAt: 在改.版本 } : null),
    [在改],
  );
  const 改待办 = useMemo(() => (在改?.kind === "task" ? { id: 在改.id, title: 在改.标题, dueAt: 在改.时间, dueHasTime: 在改.明确钟点, updatedAt: 在改.版本 } : null), [在改]);

  async function 删掉(x: 事项) {
    const r = x.kind === "plan" ? await deletePlan(x.id) : await deleteTask(x.id);
    if (!r.ok) return void message.error("error" in r ? r.error : "没删掉，请重试");
    message.success(x.kind === "plan" ? "计划已删除" : "待办已删除");
    // Dock 上的数、到点提醒要马上跟上
    void window.desktopReminders?.刷新();
    router.refresh();
  }
  /** 手里有详情的事项：服务端给的，加上分批时页面后来补取的（换了一版 plans / tasks 就作废，新的一版里有） */
  const 带来的 = useMemo(() => new Map([...plans.map(计划成事项), ...tasks.map(待办成事项)].map((x) => [x.key, x])), [plans, tasks]);
  const [补到, set补到] = useState<{ 源: Map<string, 事项>; 行: Map<string, 事项>; 没了: Set<string> }>(() => ({ 源: 带来的, 行: new Map(), 没了: new Set() }));
  const 补 = 补到.源 === 带来的 ? 补到 : null;
  const 详 = useMemo(() => (补?.行.size ? new Map([...带来的, ...补.行]) : 带来的), [带来的, 补]);
  /** 全部未完成的事项（分批时只有 key、时间、负责人）：条数、分组都在它上面算 */
  const 全部: 轻事项[] = useMemo(
    () => (轻 && 负责人 ? 轻.map(([key, 时间, i]) => ({ key, 时间, ownerId: 负责人[i] })) : [...带来的.values()]),
    [轻, 负责人, 带来的],
  );

  /**
   * 「新建计划」就地弹框（2026-09-29）。原来它跳去客户列表，让人自己挑一位再进记录页排——
   * 按钮写着「新建」却把人带走了，被当成 bug 报上来。现在框里第一格挑人，
   * 挑中后给一行「上次谈到哪儿」（CustomerPick），保存后人还在这一页，新的那行亮一下
   */
  const [新建开着, set新建开着] = useState(直接新建);
  /** ?new=1 进来就开：等水合完再开。服务端先画一个开着的弹窗，会和客户端那一版对不上 */
  const 已水合 = useSyncExternalStore(无订阅, () => true, () => false);
  /** 刚建的那条计划：等它出现在列表里亮两秒（和 DataList 的 row-fresh 同一个样子） */
  const [刚建, set刚建] = useState<string | null>(null);
  const 刚建那行 = useRef<HTMLDivElement | null>(null);
  /** 这一页上新建过的：分批时排在第 N 条之后也一直摆着，不然亮完两秒就从眼前没了 */
  const [新建过, set新建过] = useState<string[]>([]);
  const 刚建到了 = 刚建 !== null && 详.has(刚建);
  useEffect(() => {
    if (!刚建到了) return;
    // 排在下面几组的时候人看不见它：滚到眼前。减弱动态时直接跳过去，不滑
    刚建那行.current?.scrollIntoView({ block: "nearest", behavior: 滚法() });
    const t = setTimeout(() => set刚建(null), 2000);
    return () => clearTimeout(t);
  }, [刚建到了]);
  /**
   * 这一页上的事全是我的（一个人的库就是这样）：「我的 / 全部成员」这一层不摆（审查 D2）——
   * 两边永远一样，摆着只是让人多想一下「全部成员」里会不会还有别的
   */
  const 只有我 = 全部.every((x) => x.ownerId === meId) && done.every((d) => d.ownerId === meId);

  const 我的 = useMemo(() => 全部.filter((x) => (scope === "我的" ? x.ownerId === meId : true)), [全部, scope, meId]);

  /**
   * 分组。没定时间的算「以后」而不是塞进本周——它不是这周要做的，
   * 只是还没排期；混进来会让「本周」这个数变得不可信。
   */
  const 组 = useMemo(() => {
    const 今天结束 = dayjs().endOf("day");
    const 本周结束 = dayjs().endOf("week");
    const out = { 逾期: [] as 轻事项[], 今天: [] as 轻事项[], 本周: [] as 轻事项[], 以后: [] as 轻事项[] };
    for (const x of 我的) {
      if (!x.时间) out.以后.push(x);
      else {
        const t = dayjs(x.时间);
        // 「逾期」和首页信号、数据页那张卡同一个判断（lib/overdue.ts），数才对得上
        if (是逾期(x.时间)) out.逾期.push(x);
        else if (t.isBefore(今天结束)) out.今天.push(x);
        else if (t.isBefore(本周结束)) out.本周.push(x);
        else out.以后.push(x);
      }
    }
    for (const k of Object.keys(out) as (keyof typeof out)[]) {
      out[k].sort((a, c) => (a.时间 ? dayjs(a.时间).valueOf() : Infinity) - (c.时间 ? dayjs(c.时间).valueOf() : Infinity));
    }
    return out;
  }, [我的]);

  /** 每组摆出来的：前 N 条（分批时），加上这一页新建过的；没详情的先占一行「正在取」 */
  const 摆 = useMemo(() => {
    const 留 = new Set(新建过);
    return Object.fromEntries(组名.map((g, i) => {
      const n = 每组?.[i] ?? Infinity;
      const 这些 = 组[g].filter((x, j) => (j < n || 留.has(x.key)) && !补?.没了.has(x.key));
      return [g, { 行: 这些.map((x) => 详.get(x.key) ?? { key: x.key, 待取: true as const }), 还有: Math.max(0, 组[g].length - n) }];
    })) as Record<(typeof 组名)[number], { 行: (事项 | 待取)[]; 还有: number }>;
  }, [组, 每组, 新建过, 详, 补]);
  const 缺 = 组名.flatMap((g) => 摆[g].行.filter((x) => "待取" in x).map((x) => x.key)).slice(0, 500).join(",");
  /** 补详情失败时缺的那一串：那几行不再转「正在取」，写「没取到」给重试（不然断网一下就一直转） */
  const [补失败, set补失败] = useState<string | null>(null);
  const [补第几次, set补第几次] = useState(0);
  const 没取到 = 补失败 !== null && 补失败 === 缺;
  const 重取 = () => { set补失败(null); set补第几次((n) => n + 1); };
  useEffect(() => {
    if (!缺 || !补详情) return;
    let 停 = false;
    const keys = 缺.split(",");
    补详情(keys).then((r) => {
      if (停) return;
      set补到((v) => {
        const 行 = new Map(v.源 === 带来的 ? v.行 : []);
        for (const x of [...r.plans.map(计划成事项), ...r.tasks.map(待办成事项)]) 行.set(x.key, x);
        // 取了却没有：刚被别人做完、删掉了。不摆，也不再去取
        const 没了 = new Set(v.源 === 带来的 ? v.没了 : []);
        for (const k of keys) if (!行.has(k)) 没了.add(k);
        return { 源: 带来的, 行, 没了 };
      });
    }).catch(() => { if (!停) set补失败(缺); });
    return () => { 停 = true; };
  }, [缺, 补详情, 带来的, 补第几次]);

  /** 换 URL 参数重新取（每组几条 n），页面不跳回顶上；和商机看板同一个做法 */
  const [翻着, 开始翻] = useTransition();
  const 再看 = (i: number) => {
    const p = new URLSearchParams(window.location.search);
    p.set("n", 写每组(组名.map((_, j) => (每组?.[j] ?? 每批) + (j === i ? 每批 : 0))));
    开始翻(() => router.replace(`${window.location.pathname}?${p}`, { scroll: false }));
  };

  /** 点了计划前面的 ✓：先弹小框（方式 + 一句话 + 下次），待办照旧直接完成 */
  function 点完成(x: 事项) {
    if (x.kind === "plan") return void set在完成({ id: x.id, subject: x.标题, method: x.方式 ?? "", customerId: x.customerId, customerName: x.customerName, 有WhatsApp: x.有WhatsApp, key: x.key, 标题: x.标题 });
    void 完成(x);
  }

  /** 小框里保存了：计划已经在服务端一起完成了，这里只管留位、提示（带撤销） */
  function 记完了(x: 要完成的计划 & { key: string }, r: 记完了结果) {
    set刚完成((v) => [...v, x.key]);
    提示记完了(message, x, r, () => {
      set刚完成((v) => v.filter((k) => k !== x.key));
      void window.desktopReminders?.刷新();
      router.refresh();
    });
    void window.desktopReminders?.刷新();
    setTimeout(() => {
      set刚完成((v) => v.filter((k) => k !== x.key));
      router.refresh();
    }, 600);
  }

  async function 完成(x: 事项) {
    set刚完成((v) => [...v, x.key]);
    if (x.kind === "plan") await completePlan(x.id);
    else await toggleTask(x.id, true);
    /*
      提示里带「撤销」，计划还带「排下一次」（审查 M10）：原来点完 600ms 这条就没了，
      点错了只能去「已完成」里找也改不回来；做完一次跟进，下一次什么时候也没人问
    */
    const key = `done-${x.key}`;
    message.success({
      key,
      duration: 6,
      content: (
        <span>
          「{x.标题}」已完成
          <Button type="link" size="small" onClick={() => { message.destroy(key); void 撤销完成(x); }}>
            撤销
          </Button>
          {x.kind === "plan" && (
            <Button type="link" size="small" onClick={() => { message.destroy(key); set排给({ customerId: x.customerId, 有WhatsApp: x.有WhatsApp }); }}>
              排下一次
            </Button>
          )}
        </span>
      ),
    });
    // 桌面端：Dock 上那个数马上跟着少一个，不等壳下一分钟再问（网页版没有这个口子）
    void window.desktopReminders?.刷新();
    // 留位 600ms 再让它从列表里消失：立刻抽走，下面的行会跳上来顶替位置
    setTimeout(() => {
      set刚完成((v) => v.filter((k) => k !== x.key));
      router.refresh();
    }, 600);
  }

  async function 撤销完成(x: 事项) {
    if (x.kind === "plan") await completePlan(x.id, false);
    else await toggleTask(x.id, false);
    set刚完成((v) => v.filter((k) => k !== x.key));
    message.success(`「${x.标题}」已改回未完成`);
    void window.desktopReminders?.刷新();
    router.refresh();
  }

  const 我的已完成 = useMemo(
    () => done.filter((x) => (scope === "我的" ? x.ownerId === meId : true)).slice(0, 200),
    [done, scope, meId],
  );

  // 待办空、但做完的有一堆时，不该说「还没有排任何跟进」——那是句不对的话
  const 空了 = 全部.length === 0 && done.length === 0;

  return (
    <>
      {/* 计划和记录是同一件事的两头，「记录」是页头上的次动作，不再占一列中栏。
          「新建计划」就地弹框、第一格挑人；「上次谈到哪儿」跟着挑中的人进框里 */}
      <PageHead
        title="跟进计划"
        subtitle={`逾期、今天、本周要联系的人 · ${timeZone ? "北京时间（UTC+8）" : "本机时区"}`}
        extra={
          <Space>
            <Button icon={<UnorderedListOutlined />} onClick={() => router.push("/follow-ups")}>
              记录
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => set新建开着(true)}>
              新建计划
            </Button>
          </Space>
        }
      />

      {空了 ? (
        <div className="card-soft">
          <EmptyState
            title="还没有排任何跟进"
            hint={`跟进计划是「下次什么时候、找谁、谈什么」。排好之后，到时间了这一页会把它顶到最前面。`}
            primary={{ label: "排第一条计划", onClick: () => set新建开着(true) }}
          />
        </div>
      ) : (
        <>
          <Space wrap style={{ marginBottom: 16 }}>
            <Segmented value={看} onChange={set看} options={["待办", `已完成${我的已完成.length ? ` ${我的已完成.length}` : ""}`]} />
            {!只有我 && <Segmented value={scope} onChange={setScope} options={["我的", "全部成员"]} />}
            {/* 自己名下空、团队里却有一堆的时候要说一声。
                三组全写着「这一组是空的」，人会以为整个团队都没排 */}
            {看 === "待办" && scope === "我的" && 我的.length === 0 && 全部.length > 0 && (
              <button type="button" className="plan-switch" onClick={() => setScope("全部成员")}>
                你名下没有；全部成员还有 {全部.length} 条 ›
              </button>
            )}
          </Space>

          {String(看).startsWith("已完成") ? (
            <div className="plans">
              <section className="plan-g">
                <div className="plan-g-h">
                  <b>做完的</b>
                  <span className="plan-g-n">{我的已完成.length}</span>
                  <span className="plan-g-s">按实际完成时间倒序，最多 200 条；旧时间未知的排后</span>
                </div>
                {我的已完成.length === 0 ? (
                  <div className="plan-empty">{scope === "我的" ? "你还没完成过计划或待办" : "还没有完成过的"}</div>
                ) : (
                  我的已完成.map((x) => (
                    <div key={x.key} className="plan-row plan-row-was">
                      <CheckCircleOutlined style={{ color: "var(--success)" }} />
                      <span className="plan-row-m">
                        <span className="plan-row-t">{x.标题}</span>
                        <span className="plan-row-s">
                          <a href={`/customers/${x.customerId}`} style={客户名样式}>{x.customerName}</a>
                          {x.方式 && <Tag style={{ margin: 0, borderRadius: 6 }}>{x.方式}</Tag>}
                          <Tag style={{ margin: 0, borderRadius: 6 }}>{x.kind === "plan" ? "跟进计划" : "待办"}</Tag>
                          {/* 原定什么时候做，和实际什么时候做完，是两件事——两个都留着 */}
                          {x.计划时间 && <span className="plan-row-was-p">原定 {fmtDateTime(x.计划时间)}</span>}
                        </span>
                      </span>
                      {!只有我 && scope === "全部成员" && <UserCell name={x.ownerName} size={22} />}
                      <span className="plan-row-d">{x.完成时间 ? `${fmtDateTime(x.完成时间)} 完成` : "已完成 · 完成时间未记录"}</span>
                    </div>
                  ))
                )}
              </section>
            </div>
          ) : (
          <div className="plans">
            {/* 三组的空文案各不相同：全写「这一组是空的」，人分不出
                「今天没排」和「已经全做完了」——那是两件完全不同的事 */}
            <组块 名="逾期" 说明="计划时间已经过去了，先处理这些" 空话="没有逾期的，都跟上了" 行={摆.逾期.行} 共={组.逾期.length} 还有={摆.逾期.还有} 再看={() => 再看(0)} 翻着={翻着} 没取到={没取到 ? 重取 : undefined} 危险 完成={点完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} 只有我={只有我} 改={set在改} 删={删掉} />
            <组块 名="今天" 说明="今天之内要做的" 空话="今天没有排计划" 行={摆.今天.行} 共={组.今天.length} 还有={摆.今天.还有} 再看={() => 再看(1)} 翻着={翻着} 没取到={没取到 ? 重取 : undefined} 完成={点完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} 只有我={只有我} 改={set在改} 删={删掉} />
            <组块 名="本周" 说明="这周剩下的几天" 空话="这周剩下的几天还没排" 行={摆.本周.行} 共={组.本周.length} 还有={摆.本周.还有} 再看={() => 再看(2)} 翻着={翻着} 没取到={没取到 ? 重取 : undefined} 完成={点完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} 只有我={只有我} 改={set在改} 删={删掉} />
            {组.以后.length > 0 && (
              <组块 名="以后" 说明="更远的，和还没定时间的" 空话="没有更远的" 行={摆.以后.行} 共={组.以后.length} 还有={摆.以后.还有} 再看={() => 再看(3)} 翻着={翻着} 没取到={没取到 ? 重取 : undefined} 完成={点完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} 只有我={只有我} 改={set在改} 删={删掉} />
            )}
          </div>
          )}
        </>
      )}

      <CompletePlanModal
        plan={在完成}
        onClose={() => set在完成(null)}
        onDone={(r) => {
          const x = 在完成;
          set在完成(null);
          if (!x) return;
          if (r.kind === "saved") return 记完了(x, r);
          // 跳过：和原来点 ✓ 一模一样（先原地打勾、再存；提示里带撤销、排下一次）
          const 原 = 详.get(x.key);
          if (原) void 完成(原);
        }}
      />
      {排给 && (
        <PlanForm open onClose={() => set排给(null)} onSaved={() => { set排给(null); router.refresh(); }} customerId={排给.customerId} 有WhatsApp={排给.有WhatsApp} record={null} 默认天数={7} />
      )}
      {在改?.kind === "plan" && (
        <PlanForm
          open
          onClose={() => set在改(null)}
          onSaved={() => { set在改(null); void window.desktopReminders?.刷新(); router.refresh(); }}
          customerId={在改.customerId}
          record={改计划}
        />
      )}
      {在改?.kind === "task" && (
        <TaskForm
          open
          onClose={() => set在改(null)}
          onSaved={() => { set在改(null); router.refresh(); }}
          customerId={在改.customerId}
          record={改待办}
        />
      )}
      <PlanForm
        open={新建开着 && 已水合}
        onClose={() => set新建开着(false)}
        onSaved={(id) => {
          set新建开着(false);
          // 新的一条在「待办」里；人正看着「已完成」的话切回来，不然亮的那行看不见
          set看("待办");
          if (id) { set刚建(`plan:${id}`); set新建过((v) => [...v, `plan:${id}`]); }
          router.refresh();
        }}
        预选客户={预选客户}
        record={null}
      />
    </>
  );
}

/** 分批时要摆、详情还在路上的那一行 */
type 待取 = { key: string; 待取: true };

function 组块({
  名, 说明, 空话, 行, 共, 还有, 再看, 翻着, 没取到, 危险, 完成, 刚完成, 刚建, 刚建那行, scope, 只有我, 改, 删,
}: {
  /** 改这一条：计划开计划表单，待办开待办表单（2026-10-02 排查 3-4：原来计划页上只能「完成」） */
  改: (x: 事项) => void;
  删: (x: 事项) => Promise<void>;
  名: string;
  说明: string;
  /** 这一组空着时说的那句话。每组都不一样 */
  空话: string;
  /** 摆出来的那些（不分批时就是这一组全部） */
  行: (事项 | 待取)[];
  /** 这一组一共多少条：组头上写的数 */
  共: number;
  /** 还没摆出来的条数：大于 0 时底下给「再看 50 条」 */
  还有: number;
  再看: () => void;
  翻着: boolean;
  /** 待取的详情没取到时给的重试；不传就是还在取 */
  没取到?: () => void;
  危险?: boolean;
  完成: (x: 事项) => void;
  刚完成: string[];
  /** 刚在这一页新建的那条的 key：亮两秒 */
  刚建: string | null;
  刚建那行: React.RefObject<HTMLDivElement | null>;
  scope: string | number;
  只有我: boolean;
}) {
  return (
    <section className={`plan-g${危险 ? " plan-g-warn" : ""}`}>
      <div className="plan-g-h">
        <b>{名}</b>
        <span className="plan-g-n">{共}</span>
        <span className="plan-g-s">{说明}</span>
      </div>
      {共 === 0 ? (
        <div className="plan-empty">{空话}</div>
      ) : (
        行.map((x) => {
          if ("待取" in x) {
            return (
              <div key={x.key} className="plan-row plan-row-wait" aria-busy={!没取到}>
                <span className="plan-row-m">
                  <span className="plan-row-t">{没取到 ? "没取到" : "正在取…"}</span>
                  <span className="plan-row-s">&nbsp;</span>
                </span>
                {没取到 && <Button type="link" size="small" onClick={没取到}>重试</Button>}
              </div>
            );
          }
          const 完了 = 刚完成.includes(x.key);
          return (
            <div
              key={x.key}
              ref={x.key === 刚建 ? 刚建那行 : undefined}
              className={`plan-row${完了 ? " plan-row-done" : ""}${x.key === 刚建 ? " row-fresh" : ""}`}
            >
              <Button
                type="text"
                size="small"
                aria-label={`完成 ${x.标题}`}
                icon={<CheckCircleOutlined style={{ color: 完了 ? "var(--success)" : undefined }} />}
                disabled={完了}
                onClick={() => 完成(x)}
              />
              <span className="plan-row-m">
                <span className="plan-row-t">{x.标题}</span>
                <span className="plan-row-s">
                  <a href={`/customers/${x.customerId}`} style={客户名样式}>{x.customerName}</a>
                  {x.方式 && <Tag style={{ margin: 0, borderRadius: 6 }}>{x.方式}</Tag>}
                  <Tag style={{ margin: 0, borderRadius: 6 }}>{x.kind === "plan" ? "跟进计划" : "待办"}</Tag>
                </span>
              </span>
              {!只有我 && scope === "全部成员" && <UserCell name={x.ownerName} size={22} />}
              {/* 截止时间一种说法：逾期 N 天 / 今天 / 明天 / M 月 D 日（审查 D1，lib/deadline.ts） */}
              <span className="plan-row-d" title={x.时间 ? fmtDateTime(x.时间) : undefined}>{截止说法(x.时间)}</span>
              {!完了 && (
                <span className="plan-row-act">
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label={`改 ${x.标题}`} onClick={() => 改(x)} />
                  <InlineConfirm 问="删除这条？" 做={() => 删(x)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除 ${x.标题}`} />
                  </InlineConfirm>
                </span>
              )}
            </div>
          );
        })
      )}
      {还有 > 0 && (
        <Button block type="text" size="small" className="pipe-more" loading={翻着} onClick={再看}>
          {还有 > 每批 ? `再看 ${每批} 条` : `再看剩下 ${还有} 条`}
          {还有 > 每批 && <span className="pipe-n">还有 {还有}</span>}
        </Button>
      )}
    </section>
  );
}
