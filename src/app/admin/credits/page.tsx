import OpsShell from "../OpsShell";
import CreditsView from "./CreditsView";
import { 反馈没处理数 } from "../data";
import { 环境, 验口令 } from "../guard";
import { 搜账号, 加次记录 } from "@/lib/tenant/admin-credits";

export const dynamic = "force-dynamic";

/** 运营台 · 次数（2026-10-19）：个人版给某个账号手动加背调 / AI 次数（私下买的），下面是加次记录 */
export default async function CreditsPage({ searchParams }: { searchParams: Promise<{ token?: string; q?: string }> }) {
  const token = await 验口令(searchParams);
  const q = String((await searchParams).q ?? "").slice(0, 100);
  const [rows, 记录, 没处理] = await Promise.all([搜账号(q), 加次记录({ take: 100 }), 反馈没处理数()]);
  return (
    <OpsShell 当前="次数" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <CreditsView token={token} q={q} rows={rows} 记录={记录} />
    </OpsShell>
  );
}
