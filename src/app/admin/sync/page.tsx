import OpsShell from "../OpsShell";
import SyncView from "./SyncView";
import { 反馈没处理数 } from "../data";
import { 环境, 验口令 } from "../guard";
import { 全部团队 } from "@/lib/tenant/sync-relay";
import { 团队们的开通情况, 读价格, 北京日期, 剩几天, 已到期 } from "@/lib/tenant/team-plan";
import { 附件磁盘 } from "@/lib/tenant/sync-attach";
import { 磁盘线 } from "@/lib/ops-notices";

export const dynamic = "force-dynamic";

/** 运营台 · 团队同步：谁建了团队、几个人、推了多少、开通没有、什么时候到期 */
export default async function SyncPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const [rows, 没处理, 价格] = await Promise.all([全部团队(), 反馈没处理数(), 读价格()]);
  const { plans, logs } = await 团队们的开通情况(rows.map((r) => r.id));
  // 剩几天在服务器这一刻算好：浏览器再算一遍跨过零点会和服务器对不上（水合报错，见 ui.tsx 的 TimeAgo）
  const now = new Date();
  const 盘 = 附件磁盘(now.getTime());
  const 线 = 磁盘线();
  return (
    <OpsShell 当前="团队同步" token={token} 环境={环境()} 渲染于={now.toISOString()} 反馈没处理={没处理}>
      <SyncView
        token={token}
        今天={北京日期(now)}
        价格={价格}
        图片盘={盘 ? { ...盘, 剩线: 线.剩, 用线: 线.用 } : null}
        rows={rows.map((r) => {
          const p = plans.get(r.id);
          return {
            ...r,
            createdAt: r.createdAt.toISOString(),
            activatedAt: r.activatedAt?.toISOString() ?? null,
            到期: p?.paidUntil ? { 日: 北京日期(p.paidUntil), 剩: 剩几天(p.paidUntil, now), 过了: 已到期(p, now), iso: p.paidUntil.toISOString() } : null,
            席位: p?.seats ?? null,
            记录: logs
              .filter((l) => l.teamId === r.id)
              .map((l) => ({ id: l.id, at: l.at.toISOString(), by: l.by, kind: l.kind, months: l.months, days: l.days, seats: l.seats, amount: l.amount, before: l.before ? 北京日期(l.before) : null, after: l.after ? 北京日期(l.after) : null, note: l.note })),
          };
        })}
      />
    </OpsShell>
  );
}
