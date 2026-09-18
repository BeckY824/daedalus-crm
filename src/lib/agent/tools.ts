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
import { FOLLOW_TYPE_MAP, OPP_STAGES } from "../constants";
import { formatTimeline } from "../ai-context";
import { runQuery } from "../report-run";
import { METRICS, GROUP_BYS, VALID_GROUPS, sanitizeQuerySpec } from "../report-query";
import { loadWatchlist } from "../sentinel-data";
import { statusLabel } from "../business-config";
import type { BusinessConfig } from "../business-config";
import type { BriefRecord } from "../ai-draft";
import { buildProposal, describeProposal, missingFields, 可改字段表, 可改字段名单, type Proposal, type ProposalKind } from "./proposals";
import { FOLLOW_TYPES, FOLLOW_METHODS, FOLLOW_STATUSES, DECISION_STATUSES, LEAD_STATUSES } from "../constants";

export type ToolContext = {
  userId: string;
  userName: string;
  b: BusinessConfig;
  /** 已读过的记录编号偏移，保证多次读取时编号不重复 */
  recordOffset: number;
  /** 这一轮攒下的写入提议。工具只往里放，落库要人在卡片上点确认 */
  proposals: Proposal[];
};
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
    description: "按关键词找客户，返回总数和名单。关键词同时匹配姓名、学校、专业、备注（问「武汉大学的有几位、分别是谁」就用 query=\"武汉大学\"）；可选按跟进状态、只看我负责的过滤。找到具体某一位后再用 get_customer 读记录。",
    args: '{"query": "姓名 / 学校 / 专业 / 备注里的关键词，可为空", "followStatus": "跟进状态，可选", "mine": true|false 可选}',
    async run(args, ctx) {
      const q = str(args.query, 20);
      const status = str(args.followStatus, 20);
      const mine = args.mine === true;
      const statusKey = status ? (Object.entries(ctx.b.statusLabels).find(([, v]) => v === status)?.[0] ?? status) : "";
      if (!q && !status && !mine) return { summary: "没给条件", data: { error: "query / followStatus / mine 至少给一个" } };
      const where = {
        ...(q ? { OR: [{ name: { contains: q } }, { school: { contains: q } }, { major: { contains: q } }, { remark: { contains: q } }] } : {}),
        ...(statusKey ? { followStatus: statusKey } : {}),
        ...(mine ? { salesOwnerId: ctx.userId } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where,
          take: 30,
          orderBy: { lastFollowAt: "desc" },
          select: { id: true, name: true, phone: true, school: true, grade: true, major: true, followStatus: true, decisionStatus: true, salesOwner: { select: { name: true } }, lastFollowAt: true },
        }),
      ]);
      const data = {
        total,
        shown: rows.length,
        customers: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, school: r.school, grade: r.grade, major: r.major, followStatus: statusLabel(ctx.b, r.followStatus), decisionStatus: statusLabel(ctx.b, r.decisionStatus), owner: r.salesOwner.name, lastFollowAt: r.lastFollowAt ? dayjs(r.lastFollowAt).format("MM-DD") : null })),
      };
      const cond = [q && `「${q}」`, status && `状态 ${status}`, mine && "我负责的"].filter(Boolean).join("、");
      return { summary: total ? `${cond}：${total} 位${total > rows.length ? `，列出前 ${rows.length}` : ""}——${rows.slice(0, 6).map((r) => r.name).join("、")}${rows.length > 6 ? "…" : ""}` : `没有匹配 ${cond} 的${ctx.b.customer}`, data };
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
        // 电话一定要给：不给的话模型会如实说「系统里没存电话」，
        // 然后建议人去补一条**本来就存在**的数据——比缺功能更伤，
        // 它是在向用户断言 CRM 丢了东西
        profile: `${[c.school, c.grade, c.major].filter(Boolean).join(" / ") || "档案未填"}；电话 ${c.phone || "未填"}；跟进状态「${statusLabel(b, c.followStatus)}」，决策状态「${statusLabel(b, c.decisionStatus)}」；负责人 ${c.salesOwner.name}；推荐来源 ${c.referrerCustomer?.name ?? c.channel?.name ?? "无"}；预计签约 ${c.expectedSignAt ? dayjs(c.expectedSignAt).format("YYYY-MM-DD") : "未定"}；已签约 ${c.contracts.reduce((s, x) => s + x.amount, 0) || "无"}；备注：${c.remark || "无"}`,
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
  /*
    下面四个是 2026-09-18 补的「清单类」工具。在这之前 agent 手上只有客户那条线
    （search_customers / get_customer）加一个指标聚合，于是问「我目前的渠道有哪些」
    这种最普通的问题，它够不着数据，只能拿 query_metric(customers_count, groupBy=channel)
    硬凑——那个结果里**没带来过客户的渠道根本不出现**，答案必然是错的，
    而且模型会为了圆这个答案想很久。补工具比换模型、换框架都直接。
  */
  {
    name: "list_channels",
    description: "列渠道（客户是从哪儿来的：合作方、中介、转介绍人）。返回每个渠道的负责人、直接带来多少客户、这条链上的签约额、停用与否。问「有哪些渠道」「哪个渠道带来的客户最多」就用它。",
    args: '{"keyword": "名字里的关键词，可空", "includeInactive": true|false 可空，默认不列停用的}',
    async run(args) {
      const q = str(args.keyword, 20);
      const rows = await prisma.channel.findMany({
        where: {
          ...(q ? { name: { contains: q } } : {}),
          ...(args.includeInactive === true ? {} : { active: true }),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          name: true, phone: true, active: true, remark: true,
          channelOwner: { select: { name: true } },
          directCustomers: { select: { contracts: { select: { amount: true } } } },
        },
      });
      return {
        summary: `${rows.length} 个渠道`,
        data: rows.map((c) => ({
          名称: c.name,
          渠道负责人: c.channelOwner?.name ?? "未指定",
          直接带来: c.directCustomers.length,
          签约额: c.directCustomers.reduce((s, cu) => s + cu.contracts.reduce((t, x) => t + x.amount, 0), 0),
          电话: c.phone ?? null,
          状态: c.active ? "在用" : "已停用",
          备注: c.remark ?? null,
        })),
      };
    },
  },
  {
    name: "list_leads",
    description: "列线索（还没建档的潜在客户）。可按状态、来源、关键词过滤。问「有哪些线索」「哪些线索还没跟」用它；线索和客户是两张表，别用 search_customers 找线索。",
    args: `{"keyword": "名称/联系人/电话里的关键词，可空", "status": "${LEAD_STATUSES.join("/")}，可空", "source": "线索来源，可空"}`,
    async run(args) {
      const q = str(args.keyword, 20);
      const status = str(args.status, 10);
      const source = str(args.source, 20);
      const where = {
        ...(q ? { OR: [{ name: { contains: q } }, { contact: { contains: q } }, { phone: { contains: q } }] } : {}),
        ...(status ? { status } : {}),
        ...(source ? { source } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({
          where, orderBy: { createdAt: "desc" }, take: 30,
          select: { id: true, name: true, contact: true, phone: true, source: true, status: true, industry: true, customerId: true, owner: { select: { name: true } } },
        }),
      ]);
      return {
        summary: `${total} 条线索${total > rows.length ? `（列出前 ${rows.length} 条）` : ""}`,
        data: {
          总数: total,
          线索: rows.map((l) => ({
            id: l.id, 名称: l.name, 联系人: l.contact, 电话: l.phone,
            来源: l.source, 状态: l.status, 行业: l.industry,
            负责人: l.owner?.name ?? null,
            已转化: Boolean(l.customerId),
          })),
        },
      };
    },
  },
  {
    name: "list_opportunities",
    description: `列商机（在谈的单子）。可按阶段、状态、客户过滤，按金额从大到小。阶段只能是 ${OPP_STAGES.join(" / ")}；status: OPEN 进行中 / WON 赢单 / LOST 丢单。问「手上有哪些单子」「哪些单子快成了」用它。`,
    args: '{"stage": "阶段，可空", "status": "OPEN/WON/LOST，可空，默认 OPEN", "customerName": "客户姓名，可空"}',
    async run(args) {
      const stage = str(args.stage, 10);
      const status = str(args.status, 6).toUpperCase();
      const name = str(args.customerName, 20);
      const where = {
        ...(stage ? { stage } : {}),
        status: ["OPEN", "WON", "LOST"].includes(status) ? status : "OPEN",
        ...(name ? { customer: { name: { contains: name } } } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.opportunity.count({ where }),
        prisma.opportunity.findMany({
          where, orderBy: { amount: "desc" }, take: 30,
          select: {
            id: true, name: true, amount: true, stage: true, status: true, probability: true, expectedDealAt: true, updatedAt: true,
            customer: { select: { id: true, name: true } }, owner: { select: { name: true } },
          },
        }),
      ]);
      return {
        summary: `${total} 个商机，合计 ¥${Math.round(rows.reduce((s, o) => s + o.amount, 0))}`,
        data: {
          总数: total,
          商机: rows.map((o) => ({
            customerId: o.customer.id,
            客户: o.customer.name,
            名称: o.name,
            金额: Math.round(o.amount),
            阶段: o.stage,
            状态: o.status === "OPEN" ? "进行中" : o.status === "WON" ? "赢单" : "丢单",
            成交概率: o.probability,
            预计成交: o.expectedDealAt ? dayjs(o.expectedDealAt).format("YYYY-MM-DD") : null,
            多久没动: `${dayjs().diff(dayjs(o.updatedAt), "day")} 天`,
            负责人: o.owner?.name ?? null,
          })),
        },
      };
    },
  },
  {
    name: "search_followups",
    description: "在**所有**跟进记录里按关键词搜（「谁提过预算」「哪几个人说过要对比方案」）。要读某一位客户的完整跟进，用 get_customer——那条是按人取全，这条是按词跨人找。",
    args: '{"keyword": "内容里的关键词", "days": 最近多少天，可空, "mine": true|false 可空}',
    async run(args, ctx) {
      const q = str(args.keyword, 30);
      if (!q) return { summary: "没给关键词", data: { error: "keyword 必填" } };
      const days = typeof args.days === "number" && args.days > 0 ? Math.min(args.days, 365) : null;
      const where = {
        OR: [{ content: { contains: q } }, { title: { contains: q } }],
        ...(days ? { occurredAt: { gte: dayjs().subtract(days, "day").toDate() } } : {}),
        ...(args.mine === true ? { ownerId: ctx.userId } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.followUp.count({ where }),
        prisma.followUp.findMany({
          where, orderBy: { occurredAt: "desc" }, take: 15,
          select: { content: true, type: true, occurredAt: true, customer: { select: { id: true, name: true } }, owner: { select: { name: true } } },
        }),
      ]);
      return {
        summary: `${total} 条提到「${q}」${total > rows.length ? `（列出最近 ${rows.length} 条）` : ""}`,
        data: {
          总数: total,
          记录: rows.map((f) => ({
            customerId: f.customer.id,
            客户: f.customer.name,
            时间: dayjs(f.occurredAt).format("YYYY-MM-DD"),
            类型: FOLLOW_TYPE_MAP[f.type]?.label ?? f.type,
            跟进人: f.owner?.name ?? null,
            // 截断：搜索给的是线索，要读全文再去 get_customer
            内容: f.content.slice(0, 200),
          })),
        },
      };
    },
  },
  proposeTool("propose_status_change", `建议改一位${"客户"}的状态。你改不了数据，这只是给人看的一张建议卡，人点确认才生效。`, '{"id": "客户 id", "to": "新状态", "reason": "一句话：为什么"}', "set_status"),
  proposeTool("propose_followup", "建议记一条跟进记录（比如人刚跟你口述了一次沟通）。你写不进去，人点确认才保存。", '{"id": "客户 id", "type": "电话沟通/线上会议/上门拜访/邮件沟通/短信沟通/跟进任务/跟进提醒/其他记录", "title": "可选，一句话标题", "content": "这次聊了什么", "occurredAt": "可选，YYYY-MM-DD HH:mm，不给就算刚刚", "reason": "一句话：为什么"}', "add_followup"),
  proposeTool("propose_plan", "建议排一次下次跟进计划。你排不了，人点确认才生效。", '{"id": "客户 id", "subject": "下次谈什么", "plannedAt": "YYYY-MM-DD HH:mm", "method": "电话沟通/线上会议/上门拜访/邮件沟通/微信沟通", "reason": "一句话：为什么"}', "add_plan"),
  proposeTool(
    "propose_lead",
    "建议新建一条线索。只知道名字也要提——卡片上留空的字段人会自己补，不要在回答里让人照格式打字。",
    '{"name": "线索名称/姓名", "contact": "联系人，可空", "phone": "电话，可空", "source": "来源，可空", "status": "状态，可空", "remark": "备注，可空", "reason": "一句话：为什么"}',
    "add_lead",
    { needsCustomer: false },
  ),
  proposeTool(
    "propose_customer_update",
    "建议修改一位客户档案里的字段。changes 是个对象，只写要改的那几项，不改的别写。" +
      "负责人 / 渠道 / 推荐人给**名字**就行（salesOwnerName / channelName / referrerName），不要给 id——重名时会拒绝，让人去手动指定。",
    '{"id": "客户 id", "changes": {"要改的字段名": "改成什么"}, "reason": "一句话：为什么"}',
    "update_customer",
  ),
  proposeTool(
    "propose_opportunity",
    "建议给一位客户新建商机（在谈的单子：金额、阶段、预计成交时间）。你建不了，人点确认才生效。",
    '{"id": "客户 id", "name": "商机名称", "amount": 金额数字, "stage": "初步沟通/需求确认/方案报价/谈判审核/赢单成交", "probability": "0~100，可空", "expectedDealAt": "可空，YYYY-MM-DD", "remark": "可空", "reason": "一句话：为什么"}',
    "add_opportunity",
  ),
  proposeTool(
    "propose_contract",
    "建议记一笔签约（已经成交、要入账的那笔钱）。注意这不是商机——商机是在谈，签约是谈成了。",
    '{"id": "客户 id", "amount": 金额数字, "signedAt": "YYYY-MM-DD", "remark": "可空", "reason": "一句话：为什么"}',
    "add_contract",
  ),
  proposeTool(
    "propose_channel_update",
    "建议修改一个**渠道**（不是客户）的负责人 / 电话 / 备注。" +
      "只影响之后由该渠道新增的客户；已有客户的归属不变。" +
      "要改某一位已有客户的渠道负责人，用 propose_customer_update 的 channelOwnerName。",
    '{"channelName": "渠道名称", "ownerName": "新的渠道负责人姓名，可空", "phone": "可空", "remark": "可空", "reason": "一句话：为什么"}',
    "update_channel",
    { needsCustomer: false },
  ),
];

/**
 * 三个提议工具长得一样：认客户 → 校验参数 → 攒一张卡片，全程不写库。
 * 校验失败时把合法取值一并告诉模型，它下一轮就能改对，不用白跑一步。
 */
function proposeTool(name: string, description: string, args: string, kind: ProposalKind, opts: { needsCustomer?: boolean } = {}): Tool {
  const needsCustomer = opts.needsCustomer !== false;
  return {
    name,
    description,
    args,
    async run(a, ctx) {
      let c = { id: "", name: str(a.name, 60) };
      /** 改之前是什么样。只有改档案 / 改状态这两类需要，其余是新建，没有「之前」 */
      let 现值: Record<string, string> | undefined;
      if (needsCustomer) {
        const id = str(a.id, 40);
        const found = id
          ? await prisma.customer.findUnique({
              where: { id },
              select: {
                id: true, name: true, phone: true, school: true, grade: true, major: true,
                followStatus: true, decisionStatus: true, expectedSignAt: true, remark: true,
                salesOwner: { select: { name: true } },
                channelOwner: { select: { name: true } },
                channel: { select: { name: true } },
                referrerCustomer: { select: { name: true } },
              },
            })
          : null;
        if (!found) return { summary: "没有这位", data: { error: "id 不对，先用 search_customers 拿到 id" } };
        c = { id: found.id, name: found.name };
        if (kind === "update_customer" || kind === "set_status") {
          现值 = {
            name: found.name,
            phone: found.phone ?? "",
            school: found.school ?? "",
            grade: found.grade ?? "",
            major: found.major ?? "",
            followStatus: found.followStatus,
            decisionStatus: found.decisionStatus,
            expectedSignAt: found.expectedSignAt ? dayjs(found.expectedSignAt).format("YYYY-MM-DD") : "",
            remark: found.remark ?? "",
            salesOwnerName: found.salesOwner?.name ?? "",
            channelOwnerName: found.channelOwner?.name ?? "",
            channelName: found.channel?.name ?? "",
            referrerName: found.referrerCustomer?.name ?? "",
          };
        }
      }
      // 同一个对象同一类提议只留一张，模型重复调用不会刷出一摞卡
      if (ctx.proposals.some((p) => p.kind === kind && p.customerId === c.id && (needsCustomer || p.customerName === c.name))) {
        return { summary: "已经提过了", data: { note: "这张建议卡已经给出，不要重复提" } };
      }
      const r = buildProposal(`${kind}-${ctx.proposals.length}-${c.id || c.name}`, kind, c, a, ctx.b);
      if (!r.ok) return { summary: `建议不合法：${r.error}`, data: { error: r.error } };
      ctx.proposals.push(现值 ? { ...r.proposal, 现值 } : r.proposal);
      const miss = missingFields(r.proposal);
      return {
        summary: `建议：${describeProposal(r.proposal, ctx.b.customer)}${miss.length ? `（还差 ${miss.join("、")}）` : ""}`,
        data: { ok: true, missing: miss, note: miss.length ? "建议卡已给出，留空的字段人会在卡片上补。不要再调同一个工具，也不要在回答里让人照格式打字" : "建议卡已给出，等人确认。不要再调同一个工具" },
      };
    },
  };
}

/**
 * 提议工具的取值表，拼进系统提示词，省得模型猜。
 *
 * **状态那两行写成「显示名（值：存储值）」**：模型必须输出存储值（库里按值存、代码按值判），
 * 但它读到的上下文里全是显示名——通用版里人看到的是「已演示」，值却是「已试听」。
 * 只给值，模型会在回答里对着企业客户说「试听」；只给显示名，它写回来的值又落不了库。
 * 两个都给，各归各位。名词和档案字段也一律跟着业务配置走，别写死「学员」。
 */
export function proposalVocab(b: BusinessConfig): string {
  const 字段表 = 可改字段表(b);
  const 带值 = (v: string) => {
    const l = statusLabel(b, v);
    return l === v ? v : `${l}（值：${v}）`;
  };
  return `线索状态：${LEAD_STATUSES.join(" / ")}
跟进状态：${FOLLOW_STATUSES.map(带值).join(" / ")}
决策状态：${DECISION_STATUSES.map(带值).join(" / ")}
跟进类型：${FOLLOW_TYPES.map((t) => t.label).join(" / ")}
计划方式：${FOLLOW_METHODS.join(" / ")}
商机阶段：${OPP_STAGES.join(" / ")}
档案里能改的字段：${可改字段名单.map((f) => `${f}（${字段表[f].label}）`).join("、")}
渠道负责人有两种改法，别混：
  改**某一位**${b.customer ?? "客户"}的渠道负责人（登记错误、单个订正）→ propose_customer_update 的 channelOwnerName，只动这一位
  改**渠道本身**的负责人（换人接手）→ propose_channel_update，只影响之后新增的${b.customer ?? "客户"}，已有的不动
channelName 收的是渠道名、referrerName 收的是${b.customer ?? "客户"}名，绝不要把销售的名字塞进去。
${字段表.grade.label}：${(字段表.grade.values ?? []).join(" / ")}`;
}

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
