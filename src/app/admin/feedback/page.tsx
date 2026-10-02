import OpsShell from "../OpsShell";
import FeedbackView from "./FeedbackView";
import { 读反馈 } from "../data";
import { 回信地址 } from "@/lib/feedback-reply";
import { 环境, 验口令 } from "../guard";

export const dynamic = "force-dynamic";

/** 运营台 · 反馈。没人看的收件箱等于没有这个功能——导航上那个红数就是为了让它被看见 */
export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  const 反馈 = await 读反馈();
  return (
    <OpsShell 当前="反馈" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={反馈.filter((f) => !f.handled).length}>
      <FeedbackView token={token} 反馈={反馈} 回信到={回信地址()} />
    </OpsShell>
  );
}
