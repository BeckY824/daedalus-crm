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
import { 名字在别处, 别处说法, 别处附件, 找人 } from "./find-name";
import type { BusinessConfig } from "../business-config";
import type { BriefRecord } from "../ai-draft";
import { 扩同义词 } from "./synonyms";
import { 校验规格, 说人话, 编译, 表们, 分组上限 } from "./query";
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
  /**
   * 号码脱敏器。共享工作区打码，自部署原样返回（lib/shared-ws/current.ts）。
   *
   * **2026-09-19 补上的洞**：那个脱敏器的注释写着「客户列表、联系人、记录页
   * 三处共用同一个出口」——而 AI 工具是没人接上的**第四个出口**。
   * 网页那个共享工作区是多个团队共用一套账号密码进来的，表格里显示 `139****1111`，
   * 问一句 AI 却能拿到完整号码，而且它还会原样写进回答、写进对话存档。
   * 数据多半是编的，但一串 11 位数字在截图和录屏里与真号无从分辨。
   *
   * 不给就是不打码（自部署实例、单测）——那也是 `号码脱敏器()` 在非多租户下的行为。
   */
  号?: <T extends string | null>(p: T) => T;
};

/** ctx 没带脱敏器时原样返回。自部署实例本来就该看见真号 */
export const 脱敏 = (ctx: ToolContext) => ctx.号 ?? (<T extends string | null>(p: T): T => p);
export type ToolResult = { summary: string; data: unknown; records?: BriefRecord[] };

type Tool = {
  name: string;
  description: string;
  args: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

const str = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * 解析模型给的日期。和 report-query 的 asDate 一条路子：不较真格式，只看能不能解析。
 * 返回 undefined 表示没给，null 表示给了但不合法——两者要分开，
 * 「没给」是不筛，「不合法」要报错，不能当成不筛然后把全库倒出来。
 */
const 日期 = (v: unknown) => {
  const s = str(v, 20);
  if (!s) return undefined;
  const d = dayjs(s);
  return d.isValid() ? d : null;
};
/** 一对 from/to：写反了换过来。返回 null 表示有不合法的 */
const 日期区间 = (a: unknown, b: unknown) => {
  const [x, y] = [日期(a), 日期(b)];
  if (x === null || y === null) return null;
  return x && y && x.isAfter(y) ? { from: y, to: x } : { from: x, to: y };
};
/** 建成 Prisma 的 gte/lte，to 含当天——用户说「到 9 月 30 日」指那天也算 */
const 区间条件 = (r: { from?: dayjs.Dayjs; to?: dayjs.Dayjs }) =>
  r.from || r.to ? { ...(r.from ? { gte: r.from.startOf("day").toDate() } : {}), ...(r.to ? { lte: r.to.endOf("day").toDate() } : {}) } : null;

export const TOOLS: Tool[] = [
  {
    name: "search_customers",
    description:
      "按关键词找客户，返回总数和名单。关键词同时匹配姓名、学校、年级、专业、备注（问「武汉大学的有几位、分别是谁」就用 query=\"武汉大学\"，问「大三的有哪些」就用 query=\"大三\"）；" +
      "还能按渠道（channelName，问「小红这个渠道里有谁」用它，先用 list_channels 看渠道叫什么）、按负责人（ownerName，问「李四手上有哪些客户」用它）、" +
      "按跟进状态、按决策状态、只看我负责的过滤。" +
      "还能按建档时间（createdFrom/createdTo，问「这周新增了哪些客户」用它）、按预计签约时间（expectedSignFrom/expectedSignTo，问「这个月预计能签哪几个」用它，结果按预计签约日从近到远排）。" +
      "找到具体某一位后再用 get_customer 读记录。",
    args: '{"query": "姓名 / 学校 / 年级 / 专业 / 备注里的关键词，可为空", "channelName": "渠道名称，可选", "ownerName": "销售负责人姓名，可选", "followStatus": "跟进状态，可选", "decisionStatus": "决策状态，可选", "createdFrom": "建档起始 YYYY-MM-DD，可选", "createdTo": "建档截止，可选", "expectedSignFrom": "预计签约起始，可选", "expectedSignTo": "预计签约截止，可选", "mine": true|false 可选}',
    async run(args, ctx) {
      const q = str(args.query, 20);
      const channel = str(args.channelName, 20);
      const owner = str(args.ownerName, 20);
      const status = str(args.followStatus, 20);
      const decision = str(args.decisionStatus, 20);
      const mine = args.mine === true;
      // statusLabels 是「原值 → 这家的叫法」的重命名表，两个状态共用一张；反查回原值，查不到就按原样用
      const 原值 = (v: string) => (v ? (Object.entries(ctx.b.statusLabels).find(([, x]) => x === v)?.[0] ?? v) : "");
      const statusKey = 原值(status);
      const decisionKey = 原值(decision);
      const 建档 = 日期区间(args.createdFrom, args.createdTo);
      const 预签 = 日期区间(args.expectedSignFrom, args.expectedSignTo);
      if (!建档 || !预签) return { summary: "日期不合法", data: { error: "日期要写成 YYYY-MM-DD" } };
      const 建档条件 = 区间条件(建档);
      const 预签条件 = 区间条件(预签);
      const 号 = 脱敏(ctx);
      if (!q && !channel && !owner && !status && !decision && !mine && !建档条件 && !预签条件)
        return { summary: "没给条件", data: { error: "query / channelName / ownerName / followStatus / decisionStatus / mine / createdFrom-To / expectedSignFrom-To 至少给一个" } };
      const where = {
        ...(q ? { OR: [{ name: { contains: q } }, { school: { contains: q } }, { grade: { contains: q } }, { major: { contains: q } }, { remark: { contains: q } }] } : {}),
        // 用 channelId（推荐链**最顶端**的渠道，所有后代继承），不是 attributionChannelId
        // （那个是「往上第二代」的归属口径，算提成用的）。「小红这个渠道里有谁」问的是
        // 整条链上的人，包括转介绍来的后代——所以是前者。两个口径的数字会不一样。
        ...(channel ? { channel: { name: { contains: channel } } } : {}),
        ...(owner ? { salesOwner: { name: { contains: owner } } } : {}),
        ...(statusKey ? { followStatus: statusKey } : {}),
        ...(decisionKey ? { decisionStatus: decisionKey } : {}),
        ...(建档条件 ? { createdAt: 建档条件 } : {}),
        ...(预签条件 ? { expectedSignAt: 预签条件 } : {}),
        ...(mine ? { salesOwnerId: ctx.userId } : {}),
      };
      const [total, rows] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where,
          take: 30,
          // 问「这个月预计能签哪几个」时按预计签约日从近到远排——那是在问顺序，不是在问最近聊过谁
          orderBy: 预签条件 ? { expectedSignAt: "asc" } : { lastFollowAt: "desc" },
          select: { id: true, name: true, phone: true, school: true, grade: true, major: true, followStatus: true, decisionStatus: true, salesOwner: { select: { name: true } }, channel: { select: { name: true } }, expectedSignAt: true, createdAt: true, lastFollowAt: true },
        }),
      ]);
      const data = {
        total,
        shown: rows.length,
        customers: rows.map((r) => ({ id: r.id, name: r.name, phone: 号(r.phone), school: r.school, grade: r.grade, major: r.major, followStatus: statusLabel(ctx.b, r.followStatus), decisionStatus: statusLabel(ctx.b, r.decisionStatus), owner: r.salesOwner.name, channel: r.channel?.name ?? null, expectedSignAt: r.expectedSignAt ? dayjs(r.expectedSignAt).format("YYYY-MM-DD") : null, createdAt: dayjs(r.createdAt).format("YYYY-MM-DD"), lastFollowAt: r.lastFollowAt ? dayjs(r.lastFollowAt).format("MM-DD") : null })),
      };
      const 区间说法 = (r: { from?: dayjs.Dayjs; to?: dayjs.Dayjs }, 名: string) =>
        r.from || r.to ? `${名} ${r.from ? r.from.format("YYYY-MM-DD") : "最早"}~${r.to ? r.to.format("YYYY-MM-DD") : "今天"}` : "";
      const cond = [q && `「${q}」`, channel && `渠道 ${channel}`, owner && `负责人 ${owner}`, status && `状态 ${status}`, decision && `决策 ${decision}`, 区间说法(建档, "建档"), 区间说法(预签, "预计签约"), mine && "我负责的"].filter(Boolean).join("、");
      if (total) {
        return { summary: `${cond}：${total} 位${total > rows.length ? `，列出前 ${rows.length}` : ""}——${rows.slice(0, 6).map((r) => r.name).join("、")}${rows.length > 6 ? "…" : ""}`, data };
      }
      /*
        **搜空的时候，别只说「没有」。**

        「找一个人」原来只有这一条路，客户表空了模型就没线索了，只能反过来问用户
        「给个更完整的姓名」——而那个人可能好好地躺在渠道表里（2026-09-19 首页那一问：
        明杰哥是一个渠道）。这里顺手把另外四张有人名的表查一遍，**连电话一起给回去**：
        一次调用就够，不用第二次往返，也不指望模型愿意跟进一句「你去别处看看」的提示。

        只在 q 非空且真的一条都没有时才多查这四次。有结果的那条路一次都不多花。
      */
      const 别处 = q ? await 名字在别处(q, 号) : [];
      const 附 = 别处附件(q, 别处);
      return {
        summary: `没有匹配 ${cond} 的${ctx.b.customer}${别处说法(q, 别处)}`,
        data: 附 ? { ...data, ...附 } : { ...data, 没有匹配: cond },
      };
    },
  },
  {
    name: "find_person",
    description:
      "**按名字找一个人——不知道他是客户、渠道、联系人、线索还是同事时，用这个。**" +
      "它把这五张表一起找，返回每一条的电话和身份。" +
      "问「某某的电话是多少」「某某是谁」「某某的联系方式」一律先用它；" +
      "确定是客户、而且要看他的跟进时间线时，再用它给的 id 调 get_customer。" +
      "名字原样传，不要自己截短（「李老师」就传「李老师」，不要传「李」）。",
    args: '{"name": "人名，原样传"}',
    async run(args, ctx) {
      const name = str(args.name, 20);
      if (!name) return { summary: "没给名字", data: { error: "name 必填" } };
      const 命中 = await 找人(name, 脱敏(ctx));
      if (!命中.length) return { summary: `库里没有叫「${name}」的人`, data: { error: `客户、渠道、联系人、线索、团队成员五张表里都没有「${name}」` } };
      const 条 = 命中.reduce((n, h) => n + h.条数, 0);
      return {
        summary: `「${name}」：${命中.map((h) => `${h.表} ${h.条数} 条`).join("、")}`,
        data: {
          找到: 条,
          结果: 命中,
          该怎么办: `上面就是「${name}」在这个库里的全部身份。电话、状态都在记录里，直接据此回答；不要说「没找到」，也不要反过来让用户给更完整的姓名。`,
        },
      };
    },
  },
  {
    name: "get_customer",
    description: "读一位客户的档案、联系人（家长/对接人的电话微信）、商机、待办、下次计划和最近的跟进记录（含聊天原文）。回答里引用记录时用它给的 [编号]。",
    args: '{"id": "客户 id", "name": "或者直接给姓名，重名会让你去挑"}',
    async run(args, ctx) {
      let id = str(args.id, 40);
      const name = str(args.name, 20);
      const 号 = 脱敏(ctx);
      /*
        schema 从 0.37.0 起就声明了 name，实现却一直只认 id——模型照着 schema 传姓名，
        拿回的是「客户不存在」，等于对着库里明明有的人说没有。比缺功能更伤。
        重名不猜：把候选摆出来让人挑，挑错人比查不到严重得多。
      */
      if (!id && name) {
        const 候选 = await prisma.customer.findMany({
          where: { name: { contains: name } },
          take: 6,
          orderBy: { lastFollowAt: "desc" },
          select: { id: true, name: true, school: true, phone: true, salesOwner: { select: { name: true } } },
        });
        if (!候选.length) {
          // 和 search_customers 同一条：查无此人时把别的表一起看了，别让模型只会说「没有」
          const 别处 = await 名字在别处(name, 号);
          const 附 = 别处附件(name, 别处);
          return {
            summary: `没有叫「${name}」的${ctx.b.customer}${别处说法(name, 别处)}`,
            data: 附 ?? { error: "查无此人" },
          };
        }
        if (候选.length > 1)
          return {
            summary: `叫「${name}」的有 ${候选.length} 位，要哪一位`,
            data: { 需要挑一位: 候选.map((c) => ({ id: c.id, 姓名: c.name, 学校: c.school, 电话: 号(c.phone), 负责人: c.salesOwner.name })) },
          };
        id = 候选[0].id;
      }
      if (!id) return { summary: "没给客户", data: { error: "id / name 至少给一个" } };
      const c = await prisma.customer.findUnique({
        where: { id },
        include: {
          salesOwner: { select: { name: true } },
          referrerCustomer: { select: { name: true } },
          channel: { select: { name: true } },
          contracts: { select: { amount: true, signedAt: true } },
          // 联系人是另一张表。不给的话，问「张三家长的微信是多少」时模型只能说没有——
          // 而数据就在库里，等于向用户断言 CRM 丢了东西（同下面电话那条的道理）
          contacts: { select: { name: true, position: true, phone: true, wechat: true, email: true, isPrimary: true }, orderBy: { isPrimary: "desc" } },
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
        profile: `${[c.school, c.grade, c.major].filter(Boolean).join(" / ") || "档案未填"}；电话 ${号(c.phone) || "未填"}；跟进状态「${statusLabel(b, c.followStatus)}」，决策状态「${statusLabel(b, c.decisionStatus)}」；负责人 ${c.salesOwner.name}；推荐来源 ${c.referrerCustomer?.name ?? c.channel?.name ?? "无"}；预计签约 ${c.expectedSignAt ? dayjs(c.expectedSignAt).format("YYYY-MM-DD") : "未定"}；已签约 ${c.contracts.reduce((s, x) => s + x.amount, 0) || "无"}；备注：${c.remark || "无"}`,
        contacts: c.contacts.map((p) => `${p.name}${p.position ? `（${p.position}）` : ""}${p.isPrimary ? " 主要联系人" : ""}：${[p.phone && `电话 ${号(p.phone)}`, p.wechat && `微信 ${p.wechat}`, p.email && `邮箱 ${p.email}`].filter(Boolean).join("、") || "没留联系方式"}`),
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
    /*
      跟进计划和待办是**两张表**（FollowPlan / Task），而用户问「我今天要做什么」
      「我有哪些待办」时心里只有一件事：接下来该干的活。原来这里只查 FollowPlan，
      Task 表除非逐个 get_customer 否则够不着——于是「我有哪些待办」答不全。
      合在一起给，各自标明是哪一类；工具名不改，改了直连表和前端文案都要跟着动。
    */
    description: "我（当前销售）手上没做完的活：跟进计划 + 待办，都按时间从早到晚，逾期的会标出来。问「今天该做什么」「我有哪些待办」「还有哪些计划没做」都用它。",
    args: "{}",
    async run(_args, ctx) {
      const [plans, tasks] = await Promise.all([
        prisma.followPlan.findMany({ where: { done: false, ownerId: ctx.userId }, orderBy: { plannedAt: "asc" }, take: 10, select: { subject: true, plannedAt: true, method: true, customer: { select: { id: true, name: true } } } }),
        prisma.task.findMany({ where: { done: false, ownerId: ctx.userId }, orderBy: [{ dueAt: "asc" }], take: 10, select: { title: true, dueAt: true, customer: { select: { id: true, name: true } } } }),
      ]);
      const 逾期 = (d: Date | null) => (d ? dayjs(d).isBefore(dayjs()) : false);
      const data = {
        跟进计划: plans.map((p) => ({ customerId: p.customer.id, name: p.customer.name, when: dayjs(p.plannedAt).format("MM-DD HH:mm"), method: p.method, subject: p.subject, overdue: 逾期(p.plannedAt) })),
        待办: tasks.map((t) => ({ customerId: t.customer.id, name: t.customer.name, when: t.dueAt ? dayjs(t.dueAt).format("MM-DD HH:mm") : null, title: t.title, overdue: 逾期(t.dueAt) })),
      };
      const 逾期数 = [...data.跟进计划, ...data.待办].filter((x) => x.overdue).length;
      const 段 = [plans.length && `${plans.length} 条计划`, tasks.length && `${tasks.length} 条待办`].filter(Boolean).join("、");
      return { summary: 段 ? `${段}${逾期数 ? `，其中 ${逾期数} 条已逾期` : ""}` : "手上没有没做完的", data };
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
    async run(args, ctx) {
      const 号 = 脱敏(ctx);
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
          电话: 号(c.phone ?? null),
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
    async run(args, ctx) {
      const 号 = 脱敏(ctx);
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
            id: l.id, 名称: l.name, 联系人: l.contact, 电话: 号(l.phone),
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
    description: `列商机（在谈的单子）。可按阶段、状态、客户过滤，按金额从大到小。阶段只能是 ${OPP_STAGES.join(" / ")}；status: OPEN 进行中 / WON 赢单 / LOST 丢单。问「手上有哪些单子」「哪些单子快成了」用它；\
问「超过 10 万的单子」用 minAmount，问「这个月要关的单子」用 dealFrom/dealTo。`,
    args: '{"stage": "阶段，可空", "status": "OPEN/WON/LOST，可空，默认 OPEN", "customerName": "客户姓名，可空", "minAmount": 最小金额（元），可空, "dealFrom": "预计成交起始 YYYY-MM-DD，可空", "dealTo": "预计成交截止，可空"}',
    async run(args) {
      const stage = str(args.stage, 10);
      const status = str(args.status, 6).toUpperCase();
      const name = str(args.customerName, 20);
      const 金额下限 = typeof args.minAmount === "number" && args.minAmount > 0 ? args.minAmount : null;
      const 成交 = 日期区间(args.dealFrom, args.dealTo);
      if (!成交) return { summary: "日期不合法", data: { error: "dealFrom / dealTo 要写成 YYYY-MM-DD" } };
      const 成交条件 = 区间条件(成交);
      const where = {
        ...(stage ? { stage } : {}),
        status: ["OPEN", "WON", "LOST"].includes(status) ? status : "OPEN",
        ...(name ? { customer: { name: { contains: name } } } : {}),
        ...(金额下限 ? { amount: { gte: 金额下限 } } : {}),
        // 没填预计成交日的单子，问「这个月要关的」时不该混进来——Prisma 的 gte/lte 本来就会把 null 排除
        ...(成交条件 ? { expectedDealAt: 成交条件 } : {}),
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
    /*
      签约是这个 CRM 里最重要的一件事，却一直只有聚合没有名单：
      问「这个月签了哪几单、分别是谁」，query_metric 只能回一个 {全部: 19800}。
      老板问这句的频率不低于问渠道——所以单开一个列表工具，别让模型拿总额去圆名单。
    */
    name: "list_contracts",
    description:
      "列签约记录（已经成交的单子：谁、多少钱、什么时候签的）。可按时间段、客户、销售负责人、渠道过滤，按签约日期从近到远。" +
      "问「这个月签了哪几单」「分别是谁」「李四这个季度签了多少」「小红这个渠道签了哪些」用它。" +
      "只要总数不要名单时用 query_metric(contract_amount / contract_count)。",
    args: '{"from": "YYYY-MM-DD，可空", "to": "YYYY-MM-DD，可空（含当天）", "customerName": "客户姓名，可空", "ownerName": "销售负责人姓名，可空", "channelName": "渠道名称，可空"}',
    async run(args) {
      // 写反了换过来，别回一个空名单让人以为真没签
      const 区间 = 日期区间(args.from, args.to);
      if (!区间) return { summary: "日期不合法", data: { error: "from / to 要写成 YYYY-MM-DD" } };
      const { from, to } = 区间;
      const name = str(args.customerName, 20);
      const owner = str(args.ownerName, 20);
      const channel = str(args.channelName, 20);
      const where = {
        // to 含当天：用户说「到 9 月 30 日」指的是那天签的也算
        ...(区间条件({ from, to }) ? { signedAt: 区间条件({ from, to })! } : {}),
        ...(name || owner || channel
          ? {
              customer: {
                ...(name ? { name: { contains: name } } : {}),
                ...(owner ? { salesOwner: { name: { contains: owner } } } : {}),
                ...(channel ? { channel: { name: { contains: channel } } } : {}),
              },
            }
          : {}),
      };
      const [total, 合计, rows] = await Promise.all([
        prisma.contract.count({ where }),
        prisma.contract.aggregate({ where, _sum: { amount: true } }),
        prisma.contract.findMany({
          where,
          orderBy: { signedAt: "desc" },
          take: 30,
          select: {
            id: true, amount: true, signedAt: true, remark: true,
            customer: { select: { id: true, name: true, salesOwner: { select: { name: true } }, channel: { select: { name: true } } } },
          },
        }),
      ]);
      const 总额 = 合计._sum.amount ?? 0;
      const 段 = [from && `${from.format("YYYY-MM-DD")} 起`, to && `${to.format("YYYY-MM-DD")} 止`, name && `客户「${name}」`, owner && `负责人 ${owner}`, channel && `渠道 ${channel}`].filter(Boolean).join("、");
      return {
        // 总额要给全量的，不是这 30 行的和——否则超过 30 单时它会报一个偏小的数
        summary: total ? `${段 ? `${段}：` : ""}${total} 笔，合计 ¥${总额}${total > rows.length ? `（列出最近 ${rows.length} 笔）` : ""}` : `没有${段 ? `${段}的` : ""}签约记录`,
        data: {
          总数: total,
          总额,
          已列出: rows.length,
          签约: rows.map((c) => ({
            customerId: c.customer.id,
            客户: c.customer.name,
            金额: c.amount,
            签约日: dayjs(c.signedAt).format("YYYY-MM-DD"),
            负责人: c.customer.salesOwner.name,
            渠道: c.customer.channel?.name ?? null,
            备注: c.remark || null,
          })),
        },
      };
    },
  },
  {
    /*
      团队名单。原来「我们有几个销售」「谁是渠道负责人」够不着——
      query_metric 按 sales 分组只能列出**有数据的**那几个人，
      刚入职、这个月还没开单的一个都不出现，和「有哪些渠道」当初那个坑一模一样。
    */
    name: "list_users",
    description: "列这个工作区里的人：姓名、岗位、角色、手上多少客户、负责几个渠道。问「团队里有哪些人」「我们有几个销售」「谁是渠道负责人」用它。默认不列已停用的。",
    args: '{"keyword": "姓名里的关键词，可空", "includeInactive": true|false 可空，默认不列停用的}',
    async run(args) {
      const kw = str(args.keyword, 20);
      const rows = await prisma.user.findMany({
        where: { ...(kw ? { name: { contains: kw } } : {}), ...(args.includeInactive === true ? {} : { active: true }) },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          id: true, name: true, title: true, role: true, active: true,
          _count: { select: { salesCustomers: true, channels: true } },
        },
      });
      return {
        summary: rows.length ? `${rows.length} 人：${rows.slice(0, 6).map((u) => u.name).join("、")}${rows.length > 6 ? "…" : ""}` : "没有匹配的成员",
        data: rows.map((u) => ({
          id: u.id,
          姓名: u.name,
          岗位: u.title,
          角色: u.role === "ADMIN" ? "管理员" : u.role === "MANAGER" ? "主管" : "销售",
          负责客户: u._count.salesCustomers,
          负责渠道: u._count.channels,
          状态: u.active ? "在职" : "已停用",
        })),
      };
    },
  },
  {
    name: "search_followups",
    description: "在**所有**跟进记录里按关键词搜（「谁提过预算」「哪几个人说过要对比方案」）。会自动连同义词一起搜（预算＝费用＝学费＝价格），不用你换词重试。要读某一位客户的完整跟进，用 get_customer——那条是按人取全，这条是按词跨人找。",
    args: '{"keyword": "内容里的关键词", "days": 最近多少天，可空, "mine": true|false 可空}',
    async run(args, ctx) {
      const q = str(args.keyword, 30);
      if (!q) return { summary: "没给关键词", data: { error: "keyword 必填" } };
      const days = typeof args.days === "number" && args.days > 0 ? Math.min(args.days, 365) : null;
      /*
        同义词一起搜。库里写的是「费用」而人问的是「预算」——这一步不做的话，
        工具如实回「0 条」，模型只能停下来问人「要不要换个词再搜一遍」，
        而那次来回本来可以不发生（见 lib/agent/synonyms.ts）。
      */
      const 词们 = 扩同义词(q);
      const where = {
        OR: 词们.flatMap((w) => [{ content: { contains: w } }, { title: { contains: w } }]),
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
      // 说清到底搜了哪些词：答案里出现「费用」而用户问的是「预算」时，人要能看懂为什么
      const 搜了 = 词们.length > 1 ? `「${词们.slice(0, 4).join("」「")}」` : `「${q}」`;
      return {
        summary: `${total} 条提到${搜了}${total > rows.length ? `（列出最近 ${rows.length} 条）` : ""}`,
        data: {
          搜的词: 词们,
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
  /**
   * 通用查询。**别的工具答不了的问题，交给它。**
   *
   * 十一个专用工具各自只认自己那几个参数，于是一整类真实问法没人接：
   * 联系人根本没有工具（「有几个联系人是母亲」）、不能排序（「哪条线索最久没动」）、
   * 不能跨表（「9 月签约的学员里哪几个是小红老师带来的」）。
   *
   * 它**不写 SQL**，只填一段受限的规格（见 lib/agent/query.ts）——
   * 那些 SQL 护栏在这儿不是拦住的，是表达不出来。
   *
   * 排在专用工具后面登记是有意的：模型按顺序读工具表，能用专用工具解决的
   * 不该绕到这儿来（专用工具的返回更贴合问题，过程条也更好读）。
   */
  {
    name: "query_records",
    description:
      "通用查询：按任意条件找记录、排序、数个数、按某个字段分组统计。" +
      "**别的工具能直接答的就别用它**（找客户用 search_customers、列渠道用 list_channels……）；" +
      "它是给那些答不了的问题准备的：联系人（没有专门的工具）、要排序（「哪条线索最久没动」）、" +
      "要跨一张表（「9 月签约的学员里哪几个是小红老师带来的」）、要按某字段分组数个数。\n" +
      "能查的表：" + Object.keys(表们).join("、") + "。" +
      "每张表有哪些字段、每个字段能用什么运算，填错了会告诉你正确的选项，照着改一次就行。",
    args:
      '{"表": "客户/线索/商机/签约/联系人/跟进记录/跟进计划/任务/渠道", ' +
      '"条件": [{"字段": "字段名", "运算": "包含/等于/不等于/属于/大于/小于/不早于/不晚于/最近天数/为空/非空", "值": "值，为空和非空不填"}], ' +
      '"关联": {"路径": "如 客户.来源渠道", "条件": [同上]}（可空，只能跨一张表）, ' +
      '"排序": {"字段": "字段名", "降序": true}（可空）, "取": 20, ' +
      '"只计数": false（问「有多少」时给 true），"分组": "字段名"（可空，按它分组数个数）}',
    async run(args, ctx) {
      /*
        校验失败**不抛异常**，而是当成一次正常的工具结果返回错误说明。
        抛出去的话 run.ts 只会记一句「工具出错」，模型看不到哪儿错了；
        而这些错误信息全是「没有『意向高』这个取值，只能是：…」这种照着改一次就对的话。
      */
      let 规格;
      try {
        规格 = 校验规格(args);
      } catch (e) {
        return { summary: "查询写得不对", data: { error: e instanceof Error ? e.message : "查询规格不合法" } };
      }

      const 话 = 说人话(规格);
      const { where, orderBy, take } = 编译(规格);
      const 表定义 = 表们[规格.表];
      // 白名单已经把表名收死了，这里的动态取用是安全的
      const 表 = (prisma as unknown as Record<string, {
        count: (a: unknown) => Promise<number>;
        findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
        groupBy: (a: unknown) => Promise<Record<string, unknown>[]>;
      }>)[表定义.模型];

      const 总数 = await 表.count({ where });

      if (规格.分组) {
        const 列 = (表定义.字段 as Record<string, { 列: string; 名: string }>)[规格.分组];
        const g = await 表.groupBy({ by: [列.列], where, _count: { _all: true } });
        const 行 = g
          .map((r) => ({ [列.名]: r[列.列] ?? "(空)", 条数: (r._count as { _all: number })._all }))
          .sort((a, b) => (b.条数 as number) - (a.条数 as number))
          .slice(0, 分组上限);
        return { summary: `${话} → ${行.length} 组，共 ${总数} 条`, data: { 查询: 话, 总数, 分组: 行 } };
      }

      if (规格.只计数) {
        return { summary: `${话} → ${总数} 条`, data: { 查询: 话, 总数 } };
      }

      const 选 = Object.fromEntries(
        Object.values(表定义.字段 as Record<string, { 列: string }>).map((f) => [f.列, true]),
      );
      const rows = await 表.findMany({ where, orderBy, take, select: { id: true, ...选 } });
      // 列名换成中文名再喂回模型：它看到的和过程条上写的是同一套说法
      const 中文 = Object.fromEntries(
        Object.values(表定义.字段 as Record<string, { 列: string; 名: string }>).map((f) => [f.列, f.名]),
      );
      /*
        **电话要打码**（共享工作区）。这个工具一口气开了四张带电话的表
        （客户 / 线索 / 联系人 / 渠道），是这个洞最宽的一处。
        按列名认，不按中文名认——中文名是显示用的，可能重复也可能改。
      */
      const 号 = 脱敏(ctx);
      const 是电话 = (列: string) => 列 === "phone";
      const 结果 = rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            中文[k] ?? k,
            是电话(k) && typeof v === "string" ? 号(v) : v instanceof Date ? dayjs(v).format("YYYY-MM-DD") : v,
          ]),
        ),
      );
      return {
        summary: `${话} → ${总数} 条${总数 > rows.length ? `（给出前 ${rows.length} 条）` : ""}`,
        data: { 查询: 话, 总数, 列出: rows.length, 结果 },
      };
    },
  },
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
          /*
            **这里的 phone 不许打码。** 这是建议卡上的预填值，人点确认之后会原样写回库——
            打了码就是把 `139****1111` 当成真号存进去，把用户的数据改坏了。
            共享区的脱敏针对的是「读出来给人看」，不是「读出来再写回去」。
            tests/agent-phone-mask.test.ts 里把这一处列成了具名例外。
          */
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
