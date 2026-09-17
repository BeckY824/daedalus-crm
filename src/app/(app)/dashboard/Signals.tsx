"use client";

import Link from "next/link";
import CountUp from "@/components/CountUp";
import { money } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";
import type { 首页信号 } from "./HomeChat";

/**
 * 首页那一行信号。**是一行，不是三张卡**——三张 KPI 卡再加三张「可以直接开始」卡，
 * 说的是同一件事，还把输入框挤到了屏幕外面。
 *
 * 每个信号三部分，顺序按设计稿 06/HOME·ACTIVE：
 *   口径（小字在上）—— 这个数是什么，不用悬停也看得见
 *   数（大字）    —— 这一刻真查出来的
 *   去处（数右边）—— 「先处理」「看名单」，点进去是一个能把这个数重新数一遍的页面
 *
 * 去处不是装饰：一个不能落地的数只能让人干着急。首页的数字写死过一次
 * （手工测试清单里记着），从那以后规矩是：算不出来就不显示，绝不摆一个
 * 看起来像那么回事的数。注意「算不出来」和「算出来是 0」是两回事：
 * 后者照写 ¥0，写成「—」等于把一个已知的事实说成不知道。
 */
export default function Signals({ 信号 }: { 信号: 首页信号 }) {
  const b = useBusiness();
  const 项 = [
    {
      key: "逾期",
      href: "/follow-ups/plans",
      口径: "逾期跟进",
      数: 信号.逾期,
      去处: 信号.逾期 > 0 ? "先处理" : "都跟上了",
      急: 信号.逾期 > 0,
      title: "我名下计划时间已经过去、还没点完成的跟进计划",
    },
    {
      key: "高意向",
      href: `/customers?followStatus=${encodeURIComponent("意向较高")}`,
      口径: `${信号.高意向标签}${b.customer}`,
      数: 信号.高意向,
      去处: 信号.高意向 > 0 ? "看名单" : "还没有",
      急: false,
      title: `跟进状态是「${信号.高意向标签}」的${b.customer}，全团队`,
    },
    {
      key: "本月签约",
      href: "/overview?view=本月",
      口径: "本月签约",
      // 0 就写 ¥0：「—」读起来是「不知道」，而这个月签了多少我们是知道的
      数: 信号.本月签约,
      格式: money,
      去处: 信号.本月签约 > 0 ? "看拆解" : "本月还没有",
      急: false,
      title: "本月已登记的签约金额合计，按签约日期算，全团队",
    },
  ];

  return (
    <div className="signals">
      {项.map((x) => (
        <Link key={x.key} href={x.href} className={`signal${x.急 ? " signal-warn" : ""}`} title={x.title}>
          <span className="signal-k">{x.口径}</span>
          <span className="signal-v">
            {/* 数字滚一下，只滚这次会话的第一次——说的是「刚数出来的」，不是一张贴在那儿的图 */}
            <b>
              <CountUp 值={x.数} 记号={`signal:${x.key}`} 格式={x.格式} />
            </b>
            <em>{x.去处}</em>
          </span>
        </Link>
      ))}
    </div>
  );
}
