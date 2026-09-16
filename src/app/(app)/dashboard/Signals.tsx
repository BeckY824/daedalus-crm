"use client";

import Link from "next/link";
import { money } from "@/lib/utils";
import { useBusiness } from "@/lib/business-client";
import type { 首页信号 } from "./HomeChat";

/**
 * 首页那一行信号。**是一行，不是三张卡**——三张 KPI 卡再加三张「可以直接开始」卡，
 * 说的是同一件事，还把输入框挤到了屏幕外面。
 *
 * 三个数都在服务端这一刻查出来（见 dashboard/page.tsx），每个都：
 *   - 点得进去，落到一个能把这个数重新数一遍的页面
 *   - 鼠标停上去说清口径
 * 首页的数字写死过一次（手工测试清单里记着），从那以后规矩是：
 * 算不出来就不显示，绝不摆一个看起来像那么回事的数。
 */
export default function Signals({ 信号 }: { 信号: 首页信号 }) {
  const b = useBusiness();
  return (
    <div className="signals">
      <Link href="/follow-ups/plans" className={`signal${信号.逾期 > 0 ? " signal-warn" : ""}`} title="我名下计划时间已经过去、还没点完成的跟进计划">
        <b>{信号.逾期}</b>
        <span>逾期跟进</span>
      </Link>
      <Link href={`/customers?followStatus=${encodeURIComponent("意向较高")}`} className="signal" title={`跟进状态是「${信号.高意向标签}」的${b.customer}，全团队`}>
        <b>{信号.高意向}</b>
        <span>{信号.高意向标签}</span>
      </Link>
      <Link href="/reports" className="signal" title="本月已登记的签约金额合计，按签约日期算，全团队">
        <b>{信号.本月签约 > 0 ? money(信号.本月签约) : "—"}</b>
        <span>本月签约</span>
      </Link>
    </div>
  );
}
