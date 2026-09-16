import { requireUser } from "@/lib/auth";
import { llmEnabled } from "@/lib/llm";
import { dayjs } from "@/lib/utils";
import Board from "../dashboard/Board";
import ReportsView from "../reports/ReportsView";
import { 加载复盘 } from "./data";
import { 视图们, type 视图 } from "./views";
import DataShell from "./DataShell";

export const dynamic = "force-dynamic";

type SP = Promise<{ view?: string }>;

/**
 * 「数据」——看数的唯一入口。
 *
 * 以前有三处：首页那个看板、`/overview`、`/reports`，外加两个各自独立的问答框。
 * 新来的人分不清该去哪儿，老用户也记不住哪个数在哪一页。现在合成一页三视图：
 *   现在 —— 此刻的状态：指标、漏斗、业绩排行、盯盘
 *   本月 —— 这个月签了多少，按天铺开，按人和渠道拆
 *   本年 —— 今年的走势，按月铺开
 * `/reports` 这条 URL 留着（有人存了书签、也有链接指过来），跳到「本年」。
 */
export default async function DataPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;
  const view: 视图 = (视图们 as readonly string[]).includes(sp.view ?? "") ? (sp.view as 视图) : "现在";
  const ai = await llmEnabled();

  if (view === "现在") {
    return (
      <DataShell view={view} aiEnabled={ai}>
        <Board 内嵌 />
      </DataShell>
    );
  }

  const now = dayjs();
  const 本月 = view === "本月";
  const from = (本月 ? now.startOf("month") : now.startOf("year")).toDate();
  const to = (本月 ? now.endOf("month") : now.endOf("year")).toDate();
  const 口径 = 本月 ? `${now.format("YYYY 年 M 月")}，按签约日期算` : `${now.year()} 年，按签约日期算`;

  const 数 = await 加载复盘(from, to, 本月 ? "day" : "month");
  return (
    <DataShell view={view} aiEnabled={ai}>
      <ReportsView {...数} 口径={口径} />
    </DataShell>
  );
}
