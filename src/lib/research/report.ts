/**
 * 背调状态 → 一段纯文字报告。三处用：
 *   - 对话历史里那条回答的 text（复制回答、老版本 / 搜索历史时看到的就是它）
 *   - 存进客户档案的那条跟进记录的正文（时间线上直接读得懂，团队版同事那边老版本也照样显示）
 *   - 「复制」按钮
 * 来源链接一条不丢：结论后面标 [n]，文末列出 n 对应的网址。
 */
import { 阶段表, 字段表 } from "./types";
import { 补标题, 来源号, type 背调状态 } from "./state";
import { 核验项表 } from "./verify/types";
import { 信息少, 灯符 } from "./verify/rules";

const 档名 = { high: "高", mid: "中", low: "低", unknown: "查不到" } as const;
const 风险名 = { low: "低", mid: "中", high: "高" } as const;

/** 跟进记录的标题。客户详情页认「背调｜」这个开头，找最近一次背调（见 lib/research/save.ts） */
export const 背调标题前缀 = "背调｜";

export function 背调标题(s: 背调状态): string {
  const 分 = s.评分?.分;
  return `${背调标题前缀}${s.目标.name}${分 != null ? ` · 相关性 ${分} 分` : ""}${s.done?.不完整 ? "（材料不全）" : ""}`;
}

export function 报告文本(s: 背调状态): string {
  const 号 = (url?: string) => {
    const n = 来源号(s, url);
    return n ? ` [${n}]` : "";
  };
  const 行: string[] = [];
  行.push(`${s.目标.name} 背调${s.done?.不完整 ? "（材料不全，仅供参考）" : ""}`);
  const 少 = 信息少(s);
  if (少) 行.push(`⚠ 信息少，谨慎。${少.文字}`);

  const 字段 = 字段表.filter((f) => s.fields[f.key]).map((f) => `${f.label}：${s.fields[f.key]!.value}${号(s.fields[f.key]!.source)}`);
  // 进口记录：老版本的报告没有这一项（s.进口 为空）就不写
  if (s.进口) 字段.push(`进口记录：${s.进口.有 ? `${s.进口.摘要}${号(s.进口.source)}` : "未查到公开进口记录"}`);
  if (字段.length) 行.push("", "【公司】", ...字段);

  // 真实性（不进相关性分数）：灯是程序按规则定的，每一项的链接原样附上
  if (s.真实性) {
    const v = s.真实性;
    行.push("", `【真实性】${灯符[v.总灯]} ${v.总字}（程序直查，不经模型）`);
    if (v.总结) 行.push(v.总结);
    for (const x of v.项) {
      const 链 = (x.链接 ?? []).map((l) => l.url).join(" ");
      行.push(`${灯符[x.灯]} ${核验项表.find((k) => k.key === x.key)?.label ?? x.key}：${x.事实}${链 ? ` ${链}` : ""}`);
    }
  }

  const 结论 = 阶段表.filter((st) => s.stages[st.id].summary).map((st) => `${st.label}：${s.stages[st.id].summary}`);
  if (结论.length) 行.push("", "【各步结论】", ...结论);

  if (s.评分) {
    const r = s.评分;
    行.push("", `【相关性】${r.分 ?? "—"} 分${r.信息不足 ? "（信息不足，仅供参考）" : ""}，可信度 ${Math.round(r.可信度 * 100)}%`);
    for (const d of r.明细) 行.push(`- ${d.label}：${档名[d.档]}${d.证据 ? `，${d.证据}` : ""}${号(d.来源)}`);
  }
  if (s.similar?.items.length) {
    行.push("", "【像你的老客户】", ...s.similar.items.map((c) => `- ${c.name}（${档名[c.档]}）：${c.像在哪}`));
  }
  const 信号 = s.tags.filter((t) => t.tone === "signal");
  const 风险 = s.tags.filter((t) => t.tone === "risk");
  if (信号.length) 行.push("", "【近期信号】", ...信号.map((t) => `- ${t.text}${号(t.source)}`));
  行.push("", "【风险】", ...(风险.length ? 风险.map((t) => `- ${t.level ? `（${风险名[t.level]}）` : ""}${t.text}${号(t.source)}`) : ["- 没查到明显风险"]));
  if (s.approach.length) 行.push("", "【切入建议】", ...s.approach.map((p, i) => `${i + 1}. ${p}`));

  const 来源 = 补标题(s);
  if (来源.length) 行.push("", "【来源】", ...来源.map((x, i) => `[${i + 1}] ${x.title === x.url ? x.url : `${x.title} ${x.url}`}`));
  行.push("", `搜索 ${s.usage.searches} 次 · 读 ${s.usage.pages} 页`);
  return 行.join("\n");
}
