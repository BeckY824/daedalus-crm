/**
 * 给 AI 用的上下文拼装。
 *
 * 结构化字段（状态、金额、日期）模型读得懂，但学员的原话与语气只在
 * FollowUpSource 里——简报、唤醒话术最需要的恰恰是这部分。
 * 这里统一负责"要点 + 原文"的拼接与预算控制，几个 AI 动作共用同一口径。
 * "use server" 文件只能导出 async 函数，所以同步的拼装逻辑放在 lib。
 */
import { dayjs } from "./utils";
import { FOLLOW_TYPE_MAP } from "./constants";

/** 单条原文最多带这么多字进 prompt；全部原文合计不超过总预算 */
export const SOURCE_EACH_MAX = 1200;
export const SOURCE_TOTAL_BUDGET = 6000;

export type TimelineEntry = {
  type: string;
  title?: string | null;
  content: string;
  occurredAt: Date;
  duration?: number | null;
  owner?: { name: string } | null;
  source?: { text: string } | null;
};

/**
 * 把跟进时间线拼成 prompt 片段（入参应为新→旧）。
 * 有原文的记录附上原文；新→旧优先分配原文预算，旧的只留要点。
 */
export function formatTimeline(followUps: TimelineEntry[], opts: { eachMax?: number; budget?: number; numbered?: boolean } = {}): string {
  let budget = opts.budget ?? SOURCE_TOTAL_BUDGET;
  const eachMax = opts.eachMax ?? SOURCE_EACH_MAX;
  return followUps
    .map((f, idx) => {
      const label = FOLLOW_TYPE_MAP[f.type]?.label ?? f.type;
      const dur = f.duration ? `，${Math.round(f.duration / 60)}分钟` : "";
      const who = f.owner?.name ? `${f.owner.name}${dur}` : dur.replace(/^，/, "");
      const title = f.title ? `【${f.title}】` : "";
      let line = `${opts.numbered ? `[${idx + 1}]` : "-"} ${dayjs(f.occurredAt).format("MM-DD")} ${label}${who ? `（${who}）` : ""}${title}${f.content.slice(0, 300)}`;
      const src = f.source?.text.trim();
      if (src && budget > 0) {
        const cut = src.slice(0, Math.min(eachMax, budget));
        budget -= cut.length;
        line += `\n  原文：${cut.replace(/\n+/g, " / ")}${cut.length < src.length ? "…" : ""}`;
      }
      return line;
    })
    .join("\n");
}
