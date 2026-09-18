/**
 * 把一轮里调过的工具折成一句人话，写在过程条上：「查了渠道清单，读了 1 位客户的记录」。
 *
 * 独立成文件、不引 tools.ts：这里要在浏览器里跑，tools.ts 带着 prisma。
 * 每个工具一句口语，**新加工具必须来这儿登记**——tests/agent-schemas.test.ts 会对一遍。
 * 2026-09-18 之前这张表是 HomeChat 里的一段 if，只认五个工具；后来加的六个
 * （渠道 / 线索 / 商机 / 跟进记录 / 签约 / 团队）一个都不认，于是明明查了渠道清单、
 * 答对了，过程条上却写「没有读取任何记录」——对用户来说这句话和"它没查就答"是一个意思。
 */
export const 工具口语: Record<string, (次: number, 客户: string) => string> = {
  search_customers: (n) => `搜了 ${n} 次`,
  get_customer: (n, 客户) => `读了 ${n} 位${客户}的记录`,
  query_metric: (n) => `查了 ${n} 个数`,
  get_watchlist: () => "看了盯盘",
  get_my_plans: () => "看了我的计划和待办",
  list_channels: () => "查了渠道清单",
  list_leads: () => "查了线索",
  list_opportunities: () => "查了商机",
  list_contracts: () => "查了签约记录",
  list_users: () => "查了团队名单",
  search_followups: (n) => `搜了 ${n} 次跟进记录`,
  // 建议卡那几个：过程条上另有卡片，这里只说一声
  propose_status_change: () => "拟了一张建议卡",
  propose_followup: () => "拟了一张建议卡",
  propose_plan: () => "拟了一张建议卡",
  propose_lead: () => "拟了一张建议卡",
  propose_customer_update: () => "拟了一张建议卡",
  propose_opportunity: () => "拟了一张建议卡",
  propose_contract: () => "拟了一张建议卡",
  propose_channel_update: () => "拟了一张建议卡",
};

/** 过程条上的 label 形如 `list_channels({})`，取括号前的工具名 */
const 工具名 = (label: string) => label.split("(")[0];

export function summarizeSteps(steps: { id: string; label: string }[], 客户: string): string {
  const 次数 = new Map<string, number>();
  for (const s of steps) {
    if (!s.id.startsWith("tool")) continue;
    const t = 工具名(s.label);
    次数.set(t, (次数.get(t) ?? 0) + 1);
  }
  const parts: string[] = [];
  const 说过 = new Set<string>();
  for (const [t, n] of 次数) {
    const 说 = 工具口语[t]?.(n, 客户) ?? `调了 ${t}`;
    if (说过.has(说)) continue; // 几张建议卡合成一句
    说过.add(说);
    parts.push(说);
  }
  // 一个工具都没调：0.37.3 起只有闲聊类问题会这样，如实写「没查数据」，别写「没有读取任何记录」
  return parts.join("，") || "没查数据";
}
