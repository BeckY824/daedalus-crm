import { notFound } from "next/navigation";
import OpsShell from "../../OpsShell";
import TeamView from "./TeamView";
import { 反馈没处理数 } from "../../data";
import { 环境, 验口令 } from "../../guard";
import { 团队详情, 加次记录 } from "@/lib/tenant/admin-credits";
import { 团队们的开通情况, 北京日期, 剩几天, 已到期 } from "@/lib/tenant/team-plan";

export const dynamic = "force-dynamic";

/** 运营台 · 一个团队（2026-10-19）：每个成员是谁、什么角色、几台设备、背调 / AI 还剩几次，直接给某个人加次数 */
export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const { id } = await params;
  const [详情, 没处理] = await Promise.all([团队详情(id), 反馈没处理数()]);
  if (!详情) notFound();
  const [{ plans }, 记录] = await Promise.all([团队们的开通情况([id]), 加次记录({ accountIds: 详情.rows.map((r) => r.id), take: 100 })]);
  const p = plans.get(id);
  const now = new Date();
  return (
    <OpsShell 当前="团队同步" token={token} 环境={环境()} 渲染于={now.toISOString()} 反馈没处理={没处理}>
      <TeamView
        token={token}
        team={详情.team}
        rows={详情.rows}
        到期={p?.paidUntil ? { 日: 北京日期(p.paidUntil), 剩: 剩几天(p.paidUntil, now), 过了: 已到期(p, now) } : null}
        席位={p?.seats ?? null}
        记录={记录}
      />
    </OpsShell>
  );
}
