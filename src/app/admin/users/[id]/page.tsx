import { notFound } from "next/navigation";
import OpsShell from "../../OpsShell";
import UserDetailView from "./UserDetailView";
import { 反馈没处理数, 读用户 } from "../../data";
import { 环境, 验口令 } from "../../guard";

export const dynamic = "force-dynamic";

/** 运营台 · 一个人的详情：设备、AI 余额和用量、赠送流水、他发过的反馈 */
export default async function UserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const { id } = await params;
  const [详情, 没处理] = await Promise.all([读用户(id), 反馈没处理数()]);
  if (!详情) notFound();
  return (
    <OpsShell 当前="用户" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <UserDetailView token={token} 详情={详情} />
    </OpsShell>
  );
}
