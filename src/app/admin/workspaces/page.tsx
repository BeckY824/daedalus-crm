import OpsShell from "../OpsShell";
import WorkspacesView from "./WorkspacesView";
import { 反馈没处理数, 读工作区们 } from "../data";
import { 环境, 验口令 } from "../guard";

export const dynamic = "force-dynamic";

/** 运营台 · 工作区（网页版）。开工作区、开通、延长试用、停用、加次数都在这一页 */
export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const [rows, 没处理] = await Promise.all([读工作区们(), 反馈没处理数()]);
  return (
    <OpsShell 当前="工作区" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <WorkspacesView token={token} rows={rows} />
    </OpsShell>
  );
}
