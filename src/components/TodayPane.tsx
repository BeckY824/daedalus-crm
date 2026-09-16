"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App } from "antd";
import { CheckOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import { completePlan, toggleTask } from "@/app/(app)/customers/[id]/actions";
import { dayjs } from "@/lib/utils";

export type TodayData = {
  /** 今天 0 点前（含逾期）到今天结束、我名下、没做完的跟进计划 */
  plans: { id: string; subject: string; plannedAt: string; method: string; customerId: string; customerName: string }[];
  /** 我名下没做完的任务 */
  tasks: { id: string; title: string; dueAt: string | null; customerId: string; customerName: string }[];
};

/**
 * 首页中栏：「今天」。跟进计划 + 待办，勾一下就完成，点名字进档案。
 * 只放今天该做的和逾期没做的——完整的清单在跟进计划页，这里不是它的副本。
 */
export default function TodayPane({ today }: { today: TodayData }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [刚完成, set刚完成] = useState<Set<string>>(new Set());
  const now = dayjs();
  const 周 = ["日", "一", "二", "三", "四", "五", "六"][now.day()];

  function 完成计划(id: string) {
    set刚完成((s) => new Set(s).add(id));
    startTransition(async () => {
      await completePlan(id);
      message.success("计划已完成");
      router.refresh();
    });
  }
  function 完成任务(id: string) {
    set刚完成((s) => new Set(s).add(id));
    startTransition(async () => {
      await toggleTask(id, true);
      message.success("任务已完成");
      router.refresh();
    });
  }

  return (
    <>
      <div className="pane-h">
        <span className="pane-t">
          今天<span className="pane-n">{now.format("M 月 D 日")} · 周{周}</span>
        </span>
        <Link href="/follow-ups/plans" className="pane-ib" aria-label="排一条跟进计划">
          <PlusOutlined />
        </Link>
      </div>
      <div className="pane-rows">
        <div className="pane-sec">
          <b>跟进计划</b>
          {today.plans.length}
        </div>
        {today.plans.length === 0 && (
          <div className="pane-empty">
            今天没有排跟进计划。
            <Link href="/follow-ups/plans" className="pane-empty-a">
              去排一条 <RightOutlined style={{ fontSize: 9 }} />
            </Link>
          </div>
        )}
        {today.plans.map((p) => {
          const t = dayjs(p.plannedAt);
          const 逾期 = t.isBefore(now.startOf("day"));
          const done = 刚完成.has(p.id);
          return (
            <div key={p.id} className={`pane-item${done ? " done" : ""}`}>
              <span className={`pane-time${逾期 ? " late" : ""}`}>{逾期 ? t.format("M/D") : t.format("HH:mm")}</span>
              <Link href={`/customers/${p.customerId}`} className="pane-item-n">
                {p.customerName} <em>· {p.subject || p.method}</em>
              </Link>
              <button type="button" className={`pane-box${done ? " done" : ""}`} aria-label={`完成：${p.customerName} ${p.subject}`} disabled={done || pending} onClick={() => 完成计划(p.id)}>
                {done && <CheckOutlined style={{ fontSize: 10 }} />}
              </button>
            </div>
          );
        })}

        <div className="pane-sec">
          <b>待办</b>
          {today.tasks.length}
        </div>
        {today.tasks.length === 0 && (
          <div className="pane-empty">
            没有待办。
            <Link href="/follow-ups" className="pane-empty-a">
              去记一笔 <RightOutlined style={{ fontSize: 9 }} />
            </Link>
          </div>
        )}
        {today.tasks.map((k) => {
          const done = 刚完成.has(k.id);
          const 逾期 = k.dueAt ? dayjs(k.dueAt).isBefore(now.startOf("day")) : false;
          return (
            <div key={k.id} className={`pane-item${done ? " done" : ""}`}>
              <span className={`pane-time${逾期 ? " late" : ""}`}>{k.dueAt ? dayjs(k.dueAt).format("M/D") : ""}</span>
              <Link href={`/customers/${k.customerId}`} className="pane-item-n">
                {k.title} <em>· {k.customerName}</em>
              </Link>
              <button type="button" className={`pane-box${done ? " done" : ""}`} aria-label={`完成：${k.title}`} disabled={done || pending} onClick={() => 完成任务(k.id)}>
                {done && <CheckOutlined style={{ fontSize: 10 }} />}
              </button>
            </div>
          );
        })}

        <Link href="/follow-ups/plans" className="pane-more">
          全部计划与待办 <RightOutlined style={{ fontSize: 10 }} />
        </Link>
      </div>
    </>
  );
}
