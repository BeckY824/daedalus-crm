/**
 * 背调状态 → 一段纯文字报告。三处用：
 *   - 对话历史里那条回答的 text（复制回答、老版本 / 搜索历史时看到的就是它）
 *   - 存进客户档案的那条跟进记录的正文（时间线上直接读得懂，团队版同事那边老版本也照样显示）
 *   - 「复制」按钮
 * 来源链接一条不丢：结论后面标 [n]，文末列出 n 对应的网址。
 */
import { 阶段表, 字段表, 必查表, type 必查项 } from "./types";
import { 补标题, 来源号, type 背调状态 } from "./state";
import { 核验项表, type 核验项 } from "./verify/types";
import { 信息少, 灯符 } from "./verify/rules";

const 档名 = { high: "高", mid: "中", low: "低", unknown: "查不到" } as const;
const 风险名 = { low: "低", mid: "中", high: "高" } as const;

/*
 * 10-18 报告结构（盲评 A + D）：事实照我们的规矩核（直查、来源），顺序学 D——
 * 结论 → 已核实 → 公司 → 关键发现 → 产品匹配 → 评分条 → 真实性（已核实里没列的）→ 风险 + 认证提醒 → 信号 → 老客户 → 切入步骤 → 开发信 → 各步结论 → 来源。
 * 卡片（ResearchCard）和这段文字用同一套挑法，下面几个函数两边都用。
 */

/** 评分条：高 ●●●●● / 中 ●●●○○ / 低 ●○○○○ / 查不到 ○○○○○ */
export const 档条 = { high: "●●●●●", mid: "●●●○○", low: "●○○○○", unknown: "○○○○○" } as const;

/** 这一维要不要标「待验证」：查不到，或者有档没来源（老客户那一维比的是 CRM 里的客户，不要网上来源） */
export function 待验证(d: { 维度: string; 档: string; 来源?: string }): boolean {
  return d.档 === "unknown" || (d.维度 !== "similar" && !d.来源);
}

/** 「已核实」那块的真实性项：程序直查、拿到了确定答案的绿灯和红灯（黄灯是「要留意」，留在真实性里） */
export function 已核实项(s: 背调状态): 核验项[] {
  return (s.真实性?.项 ?? []).filter((x) => x.态 === "已核" && (x.灯 === "green" || x.灯 === "red"));
}

/** 「已核实」那块的财务：必查里近两年财务有来源的那条 */
export function 已核财务(s: 背调状态): 必查项 | undefined {
  return s.必查?.find((x) => x.key === "财务" && x.source);
}

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
  if (s.目标.联系人) 行.push(`联系人：${s.目标.联系人}`);
  const 少 = 信息少(s);
  if (少) 行.push(`⚠ 信息少，谨慎。${少.文字}`);
  if (s.人?.选了) {
    const c = s.人.候选?.[0];
    行.push("", "【询盘人】", `${s.人.名 ? `${s.人.名}，` : ""}${s.人.号.号}（${s.人.号.国名}${s.人.号.类型}）。没给公司名，从网上认出这家、人工点选的${c ? `：${c.依据}${号(c.来源.url)}` : ""}`);
  }

  // 结论：代码按分定的那句 + 它是哪类客户 + 开发前先弄清什么
  const r = s.评分;
  const 结论段: string[] = [];
  if (r?.结论) 结论段.push(`结论：${r.结论.字}${r.分 != null ? `（相关性 ${r.分} 分）` : ""}`);
  if (s.画像) {
    结论段.push(`客户类型：${s.画像.类型}`);
    if (s.画像.先验证.length) 结论段.push(`先弄清：${s.画像.先验证.join("；")}`);
  }
  if (结论段.length) 行.push("", "【结论】", ...结论段);

  // 已核实：程序直查拿到确定答案的项 + 公开进口记录 + 有来源的财务
  const 核 = 已核实项(s);
  const 财 = 已核财务(s);
  const 已核段 = [
    ...核.map((x) => `${灯符[x.灯]} ${核验项表.find((k) => k.key === x.key)?.label ?? x.key}：${x.事实}${(x.链接 ?? []).length ? ` ${x.链接!.map((l) => l.url).join(" ")}` : ""}`),
    ...(s.进口?.有 ? [`进口记录：${s.进口.摘要}${号(s.进口.source)}`] : []),
    ...(财 ? [`近两年财务：${财.结论}${号(财.source)}`] : []),
  ];
  if (已核段.length) 行.push("", "【已核实】", ...已核段);

  const 字段 = 字段表.filter((f) => s.fields[f.key]).map((f) => `${f.label}：${s.fields[f.key]!.value}${号(s.fields[f.key]!.source)}`);
  // 进口记录：查到的写在【已核实】；没查到写在这；老版本的报告没有这一项（s.进口 为空）就不写
  if (s.进口 && !s.进口.有) 字段.push("进口记录：未查到公开进口记录");
  if (字段.length) 行.push("", "【公司】", ...字段);
  if (s.联系人?.length) 行.push("", "【公开联系人】", ...s.联系人.map((c) => `- ${[c.岗位, c.姓名, c.电话, c.邮箱].filter(Boolean).join("，")}${号(c.source)}`));
  if (s.型号?.length) 行.push("", "【在卖的型号】", ...s.型号.map((m) => `- ${m.型号}${m.是什么 ? `：${m.是什么}` : ""}${号(m.source)}`));

  if (s.发现?.length)
    行.push("", "【关键发现】", ...s.发现.flatMap((x) => [`- ${x.事实}${号(x.source)}`, ...(x.机会 ? [`  机会：${x.机会}`] : []), ...(x.障碍 ? [`  障碍：${x.障碍}`] : [])]));
  if (s.匹配?.length)
    行.push(
      "",
      "【产品匹配】",
      ...s.匹配.flatMap((x) => [
        `- ${x.品类}：匹配度${x.匹配}，${x.开发 === "优先" ? "优先开发" : x.开发 === "选择性" ? "选择性开发" : "谨慎"}${x.系列.length ? `；它的系列：${x.系列.join("、")}` : ""}${号(x.source)}`,
        ...(x.依据 ? [`  依据：${x.依据}`] : []),
        ...(x.准备 ? [`  要准备：${x.准备}`] : []),
      ]),
    );

  // 评分条（bench 的 读报告评分 认「【相关性】N 分」和「- 维度：档」开头，别改这两处的写法）
  if (r) {
    行.push("", `【相关性】${r.分 ?? "—"} 分${r.信息不足 ? "（信息不足，仅供参考）" : ""}，可信度 ${Math.round(r.可信度 * 100)}%`);
    if (r.封顶) 行.push(`封顶：按权重算是 ${r.原分} 分，压到 ${r.封顶.上限} 分——${r.封顶.原因.join("；")}`);
    for (const d of r.明细) 行.push(`- ${d.label}：${档名[d.档]} ${档条[d.档]}${待验证(d) ? "（待验证）" : ""}${d.证据 ? `，${d.证据}` : ""}${号(d.来源)}`);
  }

  // 真实性（不进相关性分数）：灯是程序按规则定的；【已核实】里列过的不再列
  if (s.真实性) {
    const v = s.真实性;
    行.push("", `【真实性】${灯符[v.总灯]} ${v.总字}（程序直查，不经模型）`);
    if (v.总结) 行.push(v.总结);
    for (const x of v.项) {
      if (核.includes(x)) continue;
      const 链 = (x.链接 ?? []).map((l) => l.url).join(" ");
      行.push(`${灯符[x.灯]} ${核验项表.find((k) => k.key === x.key)?.label ?? x.key}：${x.事实}${链 ? ` ${链}` : ""}`);
    }
  }

  const 信号 = s.tags.filter((t) => t.tone === "signal");
  const 风险 = s.tags.filter((t) => t.tone === "risk");
  const 应对 = (v?: string) => (v ? [`  应对：${v}`] : []);
  const 必查 = (s.必查 ?? []).flatMap((x) => [`- ${必查表.find((k) => k.key === x.key)?.label ?? x.key}${x.级别 !== "none" ? `（${风险名[x.级别]}）` : ""}：${x.结论}${号(x.source)}`, ...应对(x.应对)]);
  行.push("", "【风险】", ...必查, ...(风险.length ? 风险.flatMap((t) => [`- ${t.level ? `（${风险名[t.level]}）` : ""}${t.text}${号(t.source)}`, ...应对(t.应对)]) : 必查.length ? [] : ["- 没查到明显风险"]));
  if (s.认证提醒?.length) 行.push("", "【认证提醒】", ...s.认证提醒.map((x) => `- ${x}`));
  if (信号.length) 行.push("", "【近期信号】", ...信号.map((t) => `- ${t.text}${号(t.source)}`));
  if (s.similar?.items.length) {
    行.push("", "【像你的老客户】", ...s.similar.items.map((c) => `- ${c.name}（${档名[c.档]}）：${c.像在哪}`));
  }
  // 新报告叫「切入步骤」（代码按 选切口 → 找对人 → 提案 → 先问 → 联系入口 拼的）；老报告还叫「切入建议」
  if (s.approach.length) 行.push("", s.匹配 || s.画像 || s.发现 || s.认证提醒 ? "【切入步骤】" : "【切入建议】", ...s.approach.map((p, i) => `${i + 1}. ${p}`));
  if (s.型号对比?.length) 行.push("", "【型号对比】", ...s.型号对比.map((c) => `- 它的 ${c.对方} ↔ 我们的${c.我们}：${c.怎么比}`));
  if (s.开发信) 行.push("", "【英文开发信】", `Subject: ${s.开发信.主题}`, "", s.开发信.正文);

  const 结论 = 阶段表.filter((st) => s.stages[st.id].summary).map((st) => `${st.label}：${s.stages[st.id].summary}`);
  if (结论.length) 行.push("", "【各步结论】", ...结论);

  const 来源 = 补标题(s);
  if (来源.length) 行.push("", "【来源】", ...来源.map((x, i) => `[${i + 1}] ${x.title === x.url ? x.url : `${x.title} ${x.url}`}`));
  行.push("", `搜索 ${s.usage.searches} 次 · 读 ${s.usage.pages} 页`);
  return 行.join("\n");
}
