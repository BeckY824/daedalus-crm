"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Segmented, Space, Button, App, Tag } from "antd";
import { PlusOutlined, UnorderedListOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import EmptyState from "@/components/EmptyState";
import { dayjs, fmtDateTime } from "@/lib/utils";
import { 是逾期 } from "@/lib/overdue";
import { toggleTask, completePlan } from "../../customers/[id]/actions";
import PlanForm from "../../customers/[id]/PlanForm";
import { 截止说法 } from "@/lib/deadline";


/** 只用来认「水合完了没有」（见下面的 已水合） */
const 无订阅 = () => () => {};
type Plan = {
  id: string;
  subject: string;
  plannedAt: string;
  method: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

type Task = {
  id: string;
  title: string;
  dueAt: string | null;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

/** 做完的那些。计划没有 doneAt 列，完成时间取 updatedAt，见 page.tsx 的说明 */
export type 已完成 = {
  key: string;
  kind: "plan" | "task";
  标题: string;
  方式?: string;
  计划时间: string | null;
  完成时间: string;
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
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
};

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
}: {
  plans: Plan[];
  tasks: Task[];
  done: 已完成[];
  meId: string;
  /** 从某位客户带过来的（?customer=）：「新建计划」预填这一位 */
  预选客户: { id: string; name: string } | null;
  /** ?new=1：进来就把新建框打开 */
  直接新建: boolean;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [scope, setScope] = useState<string | number>("我的");
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
  const [排给, set排给] = useState<string | null>(null);
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
  const 刚建到了 = 刚建 !== null && plans.some((p) => `plan:${p.id}` === 刚建);
  useEffect(() => {
    if (!刚建到了) return;
    // 排在下面几组的时候人看不见它：滚到眼前。减弱动态时直接跳过去，不滑
    const 减弱 = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    刚建那行.current?.scrollIntoView({ block: "nearest", behavior: 减弱 ? "auto" : "smooth" });
    const t = setTimeout(() => set刚建(null), 2000);
    return () => clearTimeout(t);
  }, [刚建到了]);
  /**
   * 这一页上的事全是我的（一个人的库就是这样）：「我的 / 全部成员」这一层不摆（审查 D2）——
   * 两边永远一样，摆着只是让人多想一下「全部成员」里会不会还有别的
   */
  const 只有我 = plans.every((p) => p.ownerId === meId) && tasks.every((t) => t.ownerId === meId) && done.every((d) => d.ownerId === meId);

  const 全部: 事项[] = useMemo(
    () => [
      ...plans.map((p) => ({
        key: `plan:${p.id}`, kind: "plan" as const, id: p.id, 标题: p.subject, 时间: p.plannedAt, 方式: p.method,
        customerId: p.customerId, customerName: p.customerName, ownerId: p.ownerId, ownerName: p.ownerName,
      })),
      ...tasks.map((t) => ({
        key: `task:${t.id}`, kind: "task" as const, id: t.id, 标题: t.title, 时间: t.dueAt,
        customerId: t.customerId, customerName: t.customerName, ownerId: t.ownerId, ownerName: t.ownerName,
      })),
    ],
    [plans, tasks],
  );

  const 我的 = useMemo(() => 全部.filter((x) => (scope === "我的" ? x.ownerId === meId : true)), [全部, scope, meId]);

  /**
   * 分组。没定时间的算「以后」而不是塞进本周——它不是这周要做的，
   * 只是还没排期；混进来会让「本周」这个数变得不可信。
   */
  const 组 = useMemo(() => {
    const 今天结束 = dayjs().endOf("day");
    const 本周结束 = dayjs().endOf("week");
    const out = { 逾期: [] as 事项[], 今天: [] as 事项[], 本周: [] as 事项[], 以后: [] as 事项[] };
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
      out[k].sort((a, c) => (a.时间 ?? "").localeCompare(c.时间 ?? ""));
    }
    return out;
  }, [我的]);

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
            <Button type="link" size="small" onClick={() => { message.destroy(key); set排给(x.customerId); }}>
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
    () => done.filter((x) => (scope === "我的" ? x.ownerId === meId : true)),
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
        subtitle="逾期、今天、本周要联系的人"
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
            <Segmented value={看} onChange={set看} options={["待办", `已完成${done.length ? ` ${done.length}` : ""}`]} />
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
                  <span className="plan-g-s">按完成时间倒序，最近 200 条</span>
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
                          <a href={`/customers/${x.customerId}`}>{x.customerName}</a>
                          {x.方式 && <Tag style={{ margin: 0, borderRadius: 6 }}>{x.方式}</Tag>}
                          <Tag style={{ margin: 0, borderRadius: 6 }}>{x.kind === "plan" ? "跟进计划" : "待办"}</Tag>
                          {/* 原定什么时候做，和实际什么时候做完，是两件事——两个都留着 */}
                          {x.计划时间 && <span className="plan-row-was-p">原定 {fmtDateTime(x.计划时间)}</span>}
                        </span>
                      </span>
                      {scope === "全部成员" && <UserCell name={x.ownerName} size={22} />}
                      <span className="plan-row-d">{fmtDateTime(x.完成时间)} 完成</span>
                    </div>
                  ))
                )}
              </section>
            </div>
          ) : (
          <div className="plans">
            {/* 三组的空文案各不相同：全写「这一组是空的」，人分不出
                「今天没排」和「已经全做完了」——那是两件完全不同的事 */}
            <组块 名="逾期" 说明="计划时间已经过去了，先处理这些" 空话="没有逾期的，都跟上了" 事项={组.逾期} 危险 完成={完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} />
            <组块 名="今天" 说明="今天之内要做的" 空话="今天没有排计划" 事项={组.今天} 完成={完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} />
            <组块 名="本周" 说明="这周剩下的几天" 空话="这周剩下的几天还没排" 事项={组.本周} 完成={完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} />
            {组.以后.length > 0 && (
              <组块 名="以后" 说明="更远的，和还没定时间的" 空话="没有更远的" 事项={组.以后} 完成={完成} 刚完成={刚完成} 刚建={刚建} 刚建那行={刚建那行} scope={scope} />
            )}
          </div>
          )}
        </>
      )}

      {排给 && (
        <PlanForm open onClose={() => set排给(null)} onSaved={() => { set排给(null); router.refresh(); }} customerId={排给} record={null} 默认天数={7} />
      )}
      <PlanForm
        open={新建开着 && 已水合}
        onClose={() => set新建开着(false)}
        onSaved={(id) => {
          set新建开着(false);
          // 新的一条在「待办」里；人正看着「已完成」的话切回来，不然亮的那行看不见
          set看("待办");
          if (id) set刚建(`plan:${id}`);
          router.refresh();
        }}
        预选客户={预选客户}
        record={null}
      />
    </>
  );
}

function 组块({
  名, 说明, 空话, 事项, 危险, 完成, 刚完成, 刚建, 刚建那行, scope,
}: {
  名: string;
  说明: string;
  /** 这一组空着时说的那句话。每组都不一样 */
  空话: string;
  事项: 事项[];
  危险?: boolean;
  完成: (x: 事项) => void;
  刚完成: string[];
  /** 刚在这一页新建的那条的 key：亮两秒 */
  刚建: string | null;
  刚建那行: React.RefObject<HTMLDivElement | null>;
  scope: string | number;
}) {
  return (
    <section className={`plan-g${危险 ? " plan-g-warn" : ""}`}>
      <div className="plan-g-h">
        <b>{名}</b>
        <span className="plan-g-n">{事项.length}</span>
        <span className="plan-g-s">{说明}</span>
      </div>
      {事项.length === 0 ? (
        <div className="plan-empty">{空话}</div>
      ) : (
        事项.map((x) => {
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
                  <a href={`/customers/${x.customerId}`}>{x.customerName}</a>
                  {x.方式 && <Tag style={{ margin: 0, borderRadius: 6 }}>{x.方式}</Tag>}
                  <Tag style={{ margin: 0, borderRadius: 6 }}>{x.kind === "plan" ? "跟进计划" : "待办"}</Tag>
                </span>
              </span>
              {scope === "全部成员" && <UserCell name={x.ownerName} size={22} />}
              {/* 截止时间一种说法：逾期 N 天 / 今天 / 明天 / M 月 D 日（审查 D1，lib/deadline.ts） */}
              <span className="plan-row-d" title={x.时间 ? fmtDateTime(x.时间) : undefined}>{截止说法(x.时间)}</span>
            </div>
          );
        })
      )}
    </section>
  );
}
