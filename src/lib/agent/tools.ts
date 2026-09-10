/**
 * agent 能用的工具。全部只读——AI 只起草，不落库；写操作永远由人在界面上点。
 *
 * 每个工具：一段给模型看的说明、一个参数校验、一个执行器。执行器返回
 *   summary：一句话，写进过程条给人看（「找到 1 位：陈同学」）
 *   data：   喂回模型的结构化内容（截断过，控制上下文）
 *   records：这次读到的跟进记录（带编号），最终回答里的 [n] 引用它们
 */
import { prisma } from "../prisma";
import { dayjs } from "../utils";
import { FOLLOW_TYPE_MAP } from "../constants";
import { formatTimeline } from "../ai-context";
import { runQuery } from "../report-run";
import { METRICS, GROUP_BYS, VALID_GROUPS, sanitizeQuerySpec } from "../report-query";
import { loadWatchlist } from "../sentinel-data";
import { statusLabel } from "../business-config";
import type { BusinessConfig } from "../business-config";
import type { BriefRecord } from "../ai-draft";

export type ToolContext = { userId: string; userName: string; b: BusinessConfig; /** 已读过的记录编号偏移，保证多次读取时编号不重复 */ recordOffset: number };
export type ToolResult = { summary: string; data: unknown; records?: BriefRecord[] };

type Tool = {
  name: string;
  description: string;
  args: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

const str = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const TOOLS: Tool[] = [
  {
    name: "search_customers",
    description: "按姓名（可以是一部分）找客户。找到后再用 get_customer 读记录。",
    args: '{"query": "姓名或片段"}',
    async run(args, ctx) {
      const q = str(args.query, 20);
      if (!q) return { summary: "没给姓名", data: { error: "query 必填" } };
      const rows = await prisma.customer.findMany({
        where: { name: { contains: q } },
        take: 8,
        select: { id: true, name: true, followStatus: true, decisionStatus: true, salesOwner: { select: { name: true } }, lastFollowAt: true },
      });
      const data = rows.map((r) => ({ id: r.id, name: r.name, followStatus: statusLabel(ctx.b, r.followStatus), decisionStatus: statusLabel(ctx.b, r.decisionStatus), owner: r.salesOwner.name, lastFollowAt: r.lastFollowAt ? dayjs(r.lastFollowAt).format("MM-DD") : null }));
      return { summary: rows.length ? `找到 ${rows.length} 位：${rows.map((r) => r.name).join("、")}` : `没有叫「${q}」的${ctx.b.customer}`, data };
    },
  },
  {
    name: "get_customer",
    description: "读一位客户的档案、商机、待办、下次计划和最近的跟进记录（含聊天原文）。回答里引用记录时用它给的 [编号]。",
    args: '{"id": "客户 id"}',
    async run(args, ctx) {
      const id = str(args.id, 40);
      const c = await prisma.customer.findUnique({
        where: { id },
        include: {
          salesOwner: { select: { name: true } },
          referrerCustomer: { select: { name: true } },
          channel: { select: { name: true } },
          contracts: { select: { amount: true, signedAt: true } },
          opportunities: { select: { name: true, amount: true, stage: true, status: true }, orderBy: { createdAt: "desc" } },
          tasks: { where: { done: false }, select: { title: true, dueAt: true } },
          plans: { where: { done: false }, select: { subject: true, plannedAt: true, method: true }, take: 1 },
          followUps: { orderBy: { occurredAt: "desc" }, take: 20, select: { id: true, type: true, title: true, content: true, occurredAt: true, duration: true, owner: { select: { name: true } }, source: { select: { text: true } } } },
        },
      });
      if (!c) return { summary: "没有这位", data: { error: "客户不存在" } };
      const offset = ctx.recordOffset;
      const records: BriefRecord[] = c.followUps.map((f, i) => ({ n: offset + i + 1, id: f.id, date: dayjs(f.occurredAt).format("MM-DD"), label: FOLLOW_TYPE_MAP[f.type]?.label ?? f.type, excerpt: (f.source?.text ?? f.content).slice(0, 160) }));
      // 编号接着上次的走
      const timeline = formatTimeline(c.followUps, { numbered: true }).replace(/^\[(\d+)\]/gm, (_m, n) => `[${Number(n) + offset}]`);
      const sources = c.followUps.filter((f) => f.source?.text).length;
      const b = ctx.b;
      const data = {
        id: c.id,
        name: c.name,
        profile: `${[c.school, c.grade, c.major].filter(Boolean).join(" / ") || "档案未填"}；跟进状态「${statusLabel(b, c.followStatus)}」，决策状态「${statusLabel(b, c.decisionStatus)}」；负责人 ${c.salesOwner.name}；推荐来源 ${c.referrerCustomer?.name ?? c.channel?.name ?? "无"}；预计签约 ${c.expectedSignAt ? dayjs(c.expectedSignAt).format("YYYY-MM-DD") : "未定"}；已签约 ${c.contracts.reduce((s, x) => s + x.amount, 0) || "无"}；备注：${c.remark || "无"}`,
        opportunities: c.opportunities.map((o) => `${o.name} ¥${Math.round(o.amount)} ${o.status === "OPEN" ? o.stage : o.status}`),
        openTasks: c.tasks.map((t) => `${t.title}${t.dueAt ? `（${dayjs(t.dueAt).format("MM-DD HH:mm")}）` : ""}`),
        nextPlan: c.plans[0] ? `${dayjs(c.plans[0].plannedAt).format("MM-DD HH:mm")} ${c.plans[0].method}：${c.plans[0].subject}` : null,
        timeline: timeline || "（从未跟进过）",
      };
      return { summary: `${c.name}：${c.followUps.length} 条跟进${sources ? `、${sources} 段原文` : ""}${c.opportunities.length ? `、${c.opportunities.length} 个商机` : ""}${c.plans[0] ? "、1 条计划" : ""}`, data, records };
    },
  },
  {
    name: "query_metric",
    description: `查业务数字。metric 只能是 ${Object.keys(METRICS).join(" / ")}；groupBy 只能是各指标允许的维度（${Object.entries(VALID_GROUPS).map(([m, g]) => `${m}: ${g.join("|") || "无"}`).join("; ")}）；from/to 为 YYYY-MM-DD 或 null。只查已发生的事，不做预测。`,
    args: '{"metric": "...", "groupBy": "..." 或 null, "from": null, "to": null}',
    async run(args, ctx) {
      let spec;
      try {
        spec = sanitizeQuerySpec(args);
      } catch (e) {
        return { summary: "查询规格不合法", data: { error: e instanceof Error ? e.message : "规格不合法" } };
      }
      const rows = await runQuery(spec, ctx.b);
      const meta = METRICS[spec.metric];
      return {
        summary: `${meta.label.replace(/学员/g, ctx.b.customer)}${spec.groupBy ? ` · ${GROUP_BYS[spec.groupBy]}` : ""}：${rows.length} 行`,
        data: { metric: meta.label, unit: meta.unit, groupBy: spec.groupBy ? GROUP_BYS[spec.groupBy] : null, range: spec.from || spec.to ? `${spec.from ?? "最早"} ~ ${spec.to ?? "今天"}` : "不限时间", rows: rows.slice(0, 30) },
      };
    },
  },
  {
    name: "get_watchlist",
    description: "盯盘清单：正在被遗忘的客户（沉睡 / 计划逾期 / 商机停滞），按紧急程度排好。",
    args: "{}",
    async run(_args, ctx) {
      const list = (await loadWatchlist()).slice(0, 12);
      return { summary: `${list.length} 项`, data: list.map((w) => ({ customerId: w.customerId, name: w.customerName, owner: w.ownerName, reason: w.reason })) };
    },
  },
  {
    name: "get_my_plans",
    description: "我（当前销售）未完成的跟进计划，按时间从早到晚。",
    args: "{}",
    async run(_args, ctx) {
      const plans = await prisma.followPlan.findMany({ where: { done: false, ownerId: ctx.userId }, orderBy: { plannedAt: "asc" }, take: 10, select: { subject: true, plannedAt: true, method: true, customer: { select: { id: true, name: true } } } });
      return { summary: `${plans.length} 条`, data: plans.map((p) => ({ customerId: p.customer.id, name: p.customer.name, when: dayjs(p.plannedAt).format("MM-DD HH:mm"), method: p.method, subject: p.subject, overdue: dayjs(p.plannedAt).isBefore(dayjs()) })) };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
