import Board from "../dashboard/Board";

export const dynamic = "force-dynamic";

/** 数据看板。首页改成了对话面之后，指标卡、趋势、漏斗、排行、盯盘都住在这里 */
export default function OverviewPage() {
  return <Board />;
}
