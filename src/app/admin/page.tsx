import OpsShell from "./OpsShell";
import OverviewView from "./OverviewView";
import { 读总览 } from "./data";
import { 环境, 验口令 } from "./guard";

export const dynamic = "force-dynamic";

/**
 * 运营台 · 总览。一页看完：多少人、多少台设备（Mac / Windows）、AI 用了多少、有什么要动手的。
 *
 * 2026-09-28 改版之前这里是一页到底的五张表（工作区 / 账号 / 模型成本 / 反馈堆在一起），
 * 现在拆成左边导航的五页，每个人能点进去看详情。开工作区、开通这些动作搬去了「工作区」页。
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const 数 = await 读总览();
  return (
    <OpsShell 当前="总览" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={数.反馈.没处理}>
      <OverviewView token={token} 数={数} />
    </OpsShell>
  );
}
