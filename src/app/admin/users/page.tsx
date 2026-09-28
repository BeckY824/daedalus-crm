import OpsShell from "../OpsShell";
import UsersView from "./UsersView";
import { 反馈没处理数, 读账号们 } from "../data";
import { 环境, 验口令 } from "../guard";

export const dynamic = "force-dynamic";

/** 运营台 · 用户。每个云端账号一行：桌面端的人全在这里（他们没有工作区） */
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const [账号, 没处理] = await Promise.all([读账号们(), 反馈没处理数()]);
  return (
    <OpsShell 当前="用户" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <UsersView token={token} 账号={账号} />
    </OpsShell>
  );
}
