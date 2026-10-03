import OpsShell from "../OpsShell";
import SyncView from "./SyncView";
import { 反馈没处理数 } from "../data";
import { 环境, 验口令 } from "../guard";
import { 全部团队 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 运营台 · 团队同步：谁建了团队、几个人、推了多少、开通没有 */
export default async function SyncPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const [rows, 没处理] = await Promise.all([全部团队(), 反馈没处理数()]);
  return (
    <OpsShell 当前="团队同步" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <SyncView token={token} rows={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), activatedAt: r.activatedAt?.toISOString() ?? null }))} />
    </OpsShell>
  );
}
