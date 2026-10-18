/**
 * 背调状态 → 一段纯文字报告。三处用：
 *   - 对话历史里那条回答的 text（复制回答、老版本 / 搜索历史时看到的就是它）
 *   - 存进客户档案的那条跟进记录的正文（时间线上直接读得懂，团队版同事那边老版本也照样显示）
 *   - 「复制」按钮
 * 来源链接一条不丢：结论后面标 [n]，文末列出 n 对应的网址。
 */
import { 阶段表, 字段表, 必查表 } from "./types";
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

/** 只有人名 + 电话、没认出（或没选）公司的「只有人」简版（person.ts）：号码本身能核的几样 + 出现过的页面 + 建议 */
function 简版文本(s: 背调状态): string {
  const 人 = s.人!;
  const 出 = 人.出现 ?? { 号码: [], 名字: [] };
  const 页 = (列: { title: string; url: string }[]) => 列.map((x) => `- ${x.title === x.url ? x.url : `${x.title} ${x.url}`}`);
  const 行 = [`${人.名 ? `${人.名}（${人.号.号}）` : 人.号.号} 只有人，没有公司`, "⚠ 信息少，谨慎。没有公司名，下面只有号码本身能核的几样。"];
  行.push("", "【号码】", `${人.号.号}：${人.号.国名}${人.号.类型}${人.号.有效 ? "" : "（号码位数不对，可能写错了）"}`);
  行.push(出.号码.length ? `在 ${出.号码.length} 个公开页面上出现过：` : "公开网页上没搜到这个号码。", ...页(出.号码));
  if (人.名) 行.push("", "【名字】", 出.名字.length ? `「${人.名}」在 ${出.名字.length} 个和做生意有关的公开页面上出现过（同名的人可能很多）：` : `和做生意有关的公开页面上没搜到「${人.名}」。`, ...页(出.名字));
  if (人.候选?.length) 行.push("", "【搜到过、但没选的公司】", ...人.候选.map((c) => `- ${c.公司}：${c.依据} ${c.来源.url}`));
  if (人.建议?.length) 行.push("", "【建议】", ...人.建议.map((x, i) => `${i + 1}. ${x}`));
  行.push("", "只查了和做生意有关的公开信息；WhatsApp 没有公开查询的渠道，只看号码在搜索结果里出没出现过，没有登录、没有抓取。", "", `搜索 ${s.usage.searches} 次`);
  return 行.join("\n");
}

export function 报告文本(s: 背调状态): string {
  if (s.人 && !s.人.选了) return 简版文本(s);
  const 号 = (url?: string) => {
    const n = 来源号(s, url);
    return n ? ` [${n}]` : "";
  };
  const 行: string[] = [];
  行.push(`${s.目标.name} 背调${s.done?.不完整 ? "（材料不全，仅供参考）" : ""}`);
  const 少 = 信息少(s);
  if (少) 行.push(`⚠ 信息少，谨慎。${少.文字}`);
  if (s.人?.选了) {
    const c = s.人.候选?.[0];
    行.push("", "【询盘人】", `${s.人.名 ? `${s.人.名}，` : ""}${s.人.号.号}（${s.人.号.国名}${s.人.号.类型}）。没给公司名，从网上认出这家、人工点选的${c ? `：${c.依据}${号(c.来源.url)}` : ""}`);
  }

  const 字段 = 字段表.filter((f) => s.fields[f.key]).map((f) => `${f.label}：${s.fields[f.key]!.value}${号(s.fields[f.key]!.source)}`);
  // 进口记录：老版本的报告没有这一项（s.进口 为空）就不写
  if (s.进口) 字段.push(`进口记录：${s.进口.有 ? `${s.进口.摘要}${号(s.进口.source)}` : "未查到公开进口记录"}`);
  if (字段.length) 行.push("", "【公司】", ...字段);
  if (s.联系人?.length) 行.push("", "【公开联系人】", ...s.联系人.map((c) => `- ${[c.岗位, c.姓名, c.电话, c.邮箱].filter(Boolean).join("，")}${号(c.source)}`));
  if (s.型号?.length) 行.push("", "【在卖的型号】", ...s.型号.map((m) => `- ${m.型号}${m.是什么 ? `：${m.是什么}` : ""}${号(m.source)}`));

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
    if (r.结论) 行.push(`结论：${r.结论.字}`);
    if (r.封顶) 行.push(`封顶：按权重算是 ${r.原分} 分，压到 ${r.封顶.上限} 分——${r.封顶.原因.join("；")}`);
    for (const d of r.明细) 行.push(`- ${d.label}：${档名[d.档]}${d.证据 ? `，${d.证据}` : ""}${号(d.来源)}`);
  }
  if (s.similar?.items.length) {
    行.push("", "【像你的老客户】", ...s.similar.items.map((c) => `- ${c.name}（${档名[c.档]}）：${c.像在哪}`));
  }
  const 信号 = s.tags.filter((t) => t.tone === "signal");
  const 风险 = s.tags.filter((t) => t.tone === "risk");
  if (信号.length) 行.push("", "【近期信号】", ...信号.map((t) => `- ${t.text}${号(t.source)}`));
  const 必查 = (s.必查 ?? []).map((x) => `- ${必查表.find((k) => k.key === x.key)?.label ?? x.key}${x.级别 !== "none" ? `（${风险名[x.级别]}）` : ""}：${x.结论}${号(x.source)}`);
  行.push("", "【风险】", ...必查, ...(风险.length ? 风险.map((t) => `- ${t.level ? `（${风险名[t.level]}）` : ""}${t.text}${号(t.source)}`) : 必查.length ? [] : ["- 没查到明显风险"]));
  if (s.approach.length) 行.push("", "【切入建议】", ...s.approach.map((p, i) => `${i + 1}. ${p}`));
  if (s.型号对比?.length) 行.push("", "【型号对比】", ...s.型号对比.map((c) => `- 它的 ${c.对方} ↔ 我们的${c.我们}：${c.怎么比}`));
  if (s.开发信) 行.push("", "【英文开发信】", `Subject: ${s.开发信.主题}`, "", s.开发信.正文);

  const 来源 = 补标题(s);
  if (来源.length) 行.push("", "【来源】", ...来源.map((x, i) => `[${i + 1}] ${x.title === x.url ? x.url : `${x.title} ${x.url}`}`));
  行.push("", `搜索 ${s.usage.searches} 次 · 读 ${s.usage.pages} 页`);
  return 行.join("\n");
}
