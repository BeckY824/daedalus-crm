/**
 * 一周模拟（企业版验收裁判）：25 人公司（sim/公司.ts）跑 2026-01-26 周一 → 02-01 周日（跨月）七天剧本，
 * 时间用假时钟（sim/时钟.ts，Prisma 的 now() 也跟着走），几秒跑完。
 *
 * 两组：
 * - 「开关开」：CRM_ENTERPRISE=1 + 规则全开。每个检查点断言第四节已定的一条规则（D-34 ~ D-40）：
 *   谁能看到什么、谁能改什么、数字对不对。企业版文件不在（main）就整组跳过。
 *   现在还红的点登记在 sim/红清单.ts，用 it.fails 跑（棘轮：修好了要删那一行）。
 * - 「开关关」：不设 CRM_ENTERPRISE，但组织规则和规则开关的 Setting 照样写上（测得更严：存着也不能生效）。
 *   只调 main 上就有的接口，把每天的观测写成文本和金样 sim/__金样__/开关关.txt 比——金样在 main 上生成，
 *   企业版分支跑出来必须一字不差。
 *
 * 没定稿的（字段权限、必填清单、企划线索……）写 it.todo，不猜。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "", email: "", role: "ADMIN", title: "", avatar: null as null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", async (原) => ({
  ...(await 原<object>()),
  // 并发的调用（两人同时领）各算各的人：先看 AsyncLocalStorage
  requireUser: async () => (await import("./sim/身份")).当前人.getStore() ?? mocks.user,
}));
vi.mock("@/lib/shared-ws/current", async (原) => ({ ...(await 原<object>()), 当前是共享区: async () => false }));
vi.mock("@/lib/sync/dedupe-client", async (原) => ({ ...(await 原<object>()), 问同事: async () => null }));
// 不连团队服务器：公海超时收回 扫全公司（连着时只扫自己名下）
vi.mock("@/lib/sync/client", async (原) => ({ ...(await 原<object>()), 读团队: () => null }));
vi.mock("@/lib/business", async (原) => {
  const m = await 原<typeof import("@/lib/business")>();
  return { ...m, getBusiness: async () => ({ ...(await m.getBusiness()), projectMode: true }) };
});
vi.mock("@/generated/prisma", async (orig) => (await import("./sim/时钟")).补时间的生成客户端(await orig()));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { 建档向导, 改项目节点, 放回项目公海, 领取项目, 编辑项目 } from "@/app/(app)/projects/actions";
import { saveLead, convertLead } from "@/app/(app)/leads/actions";
import { assignSalesOwner } from "@/app/(app)/customers/actions";
import { deactivateUser } from "@/app/(app)/settings/actions";
import { 建公司, type 公司 } from "./sim/公司";
import { 开始假时间, 拨到, 停掉假时间 } from "./sim/时钟";
import { 当前人, type 会话人 } from "./sim/身份";
import { 接口都在, 要, 可有 } from "./sim/适配";
const 开关开能跑 = await 接口都在();
import { 红清单 } from "./sim/红清单";

// ———————————————————— 检查点（开关开那组）：id → 规则号 + 断言什么 ————————————————————

const 检查点: Record<string, string> = {
  "D1-配额-直属上级能设": "D-38 组长给内销1 设每月配额 2",
  "D1-配额-虚线上级能设": "D-38 虚线上级外贸经理给内销4 设配额",
  "D1-营销线索分内贸": "D-38 市场经理把营销线索分给内销1（内贸）",
  "D1-营销线索分外贸": "D-38 同一批营销线索也能分给外销1（外贸）",
  "D1-分满了分不进": "D-38 内销1 本月已分 2 = 配额 2，第三条分不进",
  "D1-非销售不能接": "D-38 线索只分给销售：项目运营内运1 接不了",
  "D1-渠道不能分": "D-38 只有老板 / 总管理员 / 市场管理能分：渠道运营内渠1 分不了",
  "D1-自拓不计数": "D-38 内销1 自己拓的线索不算本月已分（仍是 2）",
  "D1-没下一步不能存": "D-34 开了超时回收：建档首条沟通没下一步时间存不了",
  "D1-销售只看自己": "D-39/组织范围 内销1 只看到自己的项目（P1），看不到同组内销2 的",
  "D1-组长看下属链": "组织范围 组长看到内销1–3 的项目（P1 P2 P10）",
  "D1-虚线上级能看": "D-39 外贸经理看得到虚线下属内销4 的项目 P8",
  "D1-虚线不能转客户": "D-39 外贸经理转内销4 的客户给外销1：客户仍在内销4 名下",
  "D2-当天下一步次日收回": "D-34 P5 下一步填当天 → 次日 08:00 扫描回到公海",
  "D2-直属上级能推": "D-37 组长把 P1 从潜客培育推到线索验证",
  "D2-记谁推的": "D-37 节点记录 userId = 组长",
  "D2-不能跳": "D-37 组长把 P2 从潜客培育直接推到线索推进：拦下",
  "D2-能退": "D-37 组长把 P10 推到线索验证再退回潜客培育：都成",
  "D2-销售本人不能推": "D-37 内销2 推自己的 P2：拦下（只有直属上级能推）",
  "D2-隔级经理不能推": "D-37 内贸经理（不是内销2 的直属上级）推 P2：拦下",
  "D2-虚线上级不能推": "D-39 外贸经理推虚线下属内销4 的 P8：拦下",
  "D2-原市场人员只读看转化": "D-38 线索分出去并转化后，市渠1 在「我分出去的」里看到它已转化",
  "D2-原市场人员改不了": "D-38 市渠1 改不了已分出去的线索",
  "D3-沟通没下一步拒": "D-34 内销1 给 P1 记沟通不填下一步时间：存不了",
  "D3-按下一步收回": "D-34 P2 下一步 1/27 → 1/28 08:00 回到公海",
  "D3-原负责人收提醒": "D-34 P2 收回后内销2 名下有一条提醒任务",
  "D3-进公海记历史负责人": "D-35 P2 的 pool-release 记录 fromOwner = 内销2",
  "D3-原负责人领不回": "D-35（10-26 定稿：非原负责人才能领）外销2 放回 P4 再自己领：拒「原负责人不能领回」，外销3 领：成",
  "D3-领取到上限拦": "D-35 外销6 上限 2、已持 2：去公海领 P5 被拦，提示「已到上限」",
  "D3-指派到上限拦": "D-35 老板建档指派给外销6：被上限拦",
  "D3-转让到上限拦": "D-35 老板把 P4 转给外销6：被上限拦",
  "D3-同日二扫为零": "D-34 同一天第二次扫描收回 0 个",
  "D4-下一步没到不收": "D-34 P3 下一步 2/5、按时长 1/30：1/29 还不收",
  "D4-改时长先预览": "D-34 改时长前先给「按新设置会回收几个」，预览不动数据",
  "D4-原负责人领不回P2": "D-35（10-26 定稿）内销2 去公海领回 P2：拒；内销1 领：成",
  "D4-历任负责人": "D-35 P2 记录里能看出每一任负责人和进出公海时间（内销2 → 公海 → 内销1）",
  "D5-按沟通时间起算": "D-34 P3 D2 23:59 记过沟通 → 1/30 08:00 收回",
  "D5-先列会转走的项目": "D-36 离职先列「会一起转走的 N 个项目」（内销3：1 个）",
  "D5-上级能办离职": "D-36 离职由上级指派：组长给内销3 办离职转内销1",
  "D5-转交一起转": "D-36 内销3 离职转内销1：P10 和它的客户一起到内销1",
  "D5-转移留记录": "D-36 P10 留一条转移记录（谁、从内销3 到内销1、时间）",
  "D5-离职登不进来": "D-36 内销3 停用",
  "D5-创建人照旧": "D-36 P10 的创建人仍是内销3",
  "D5-订单不进公海": "D-36 外销5 公海方式离职：订单阶段的 P9 不进公海、指派给接手人",
  "D5-批量离职": "D-36 离职能批量（200 条一次做完）",
  "D5-当晚还没收": "D-34 P6 23:59:59 建、潜客培育 3 天 → 1/30 23:59 还在手",
  "D6-按时长收回": "D-34 P6 → 1/31 08:00 回到公海",
  "D6-周末照收": "D-34（A6 默认：按日历天）P6 的回收日 1/31 是周六，照收、不顺延到周一",
  "D6-跨月前不收P1": "D-34 P1 回收日 2/1：1/31 还在手",
  "D6-月底仍满额": "D-38 1/31 23:59 再给内销1 分：仍分满了",
  "D7-月初清零": "D-38 2/1 00:01 配额清零：给内销1 分成功",
  "D7-持有数不清": "D-38 月初清零不动持有数（内销1 跨月前后一样）",
  "D7-跨月收回P1": "D-34 P1 2/1 00:05 扫描回到公海",
  "D7-自动分配": "D-38 自动分配：在职 + 允许参与 + 未满额 → 本月已分最少 → 并列给最早进池",
  "D7-两人同时领只一个": "D-35 外销2、外销3 同时领 P3：只一个领到，另一个看到「已被领走」",
  "D7-收回都有提醒": "D-34 收回的 P1 P2 P3 P5 P6 原负责人各有一条提醒任务",
  "D7-订单一个没进公海": "D-34/35 订单阶段的项目一个都不在公海",
  // —— 补：一周剧本以外多查的（剧本走完 2/1 起接着跑，不碰开关关那组和金样）——
  "补-必填字段谁能改": "D-34/35 + B2 第 6 条默认：节点必填字段组长（销售管理）改被拒，总管理员、老板能改",
  "补-自己建项目不算上限": "D-35 外销6 已到上限 2，自己建给自己照样能建",
  "补-必填节点销售推不动": "D-37 配了必填的节点，销售本人往前推被拒（找直属上级）",
  "补-必填填齐自动推": "D-37 销售填齐「需求」保存，项目自动推到下一节点并记一行",
  "补-直属上级缺必填也能推": "D-37 直属上级推过缺「国家」的节点",
  "补-总管理员能推": "D-37/39 总管理员推不是自己下属的项目，和老板一样",
  "补-直属又是虚线取并集": "D-39（默认：权限取并集）外贸经理同时是内销4 的直属和虚线上级：看得到、能推 P8，节点记录记外贸经理",
  "补-扫描留痕带项目": "D-34 自动收回的操作日志里带着收回的项目",
  "补-停用的人领不了": "D-35/36 已离职的人领公海项目被拒",
  "补-公海离职三分": "D-36 离职进公海：有订单的客户连项目给接手人；其余客户进客户公海、项目留在客户上；别人客户上的线索项目进项目公海",
  "补-扫描不动客户公海里的项目": "D-34 客户在客户公海里，项目过了时长也不收",
  "补-领客户带走项目": "D-35/36 谁从客户公海领了客户，客户上的项目归谁，留转移记录",
  "补-周末全库一致": "D-34~36 收尾：公海里没有订单项目、没有在职项目挂在离职人名下、进公海的都有记录",
};

const 未定: string[] = [
  "D-40 字段权限（Q-08 未定）",
  "D-37 签订合同、首款支付、生产备货、物流运输四个节点的必填（缺字段，等客户 B1；其余节点按建议清单，机制已查：补-必填*）",
  "D-38 企划线索算不算配额（Q-09 未定）",
  "D-38 都满额时线索留在池里并提醒管理员（提醒给谁、怎么提醒未定）",
  "D-38 自动分配的「允许参与」开关放在哪、谁能改（未定）",
  "D-39 三类管理员各自只看自己那几项后台设置（默认值待确认）",
  "D-34 节假日表（A6 默认按日历天已查：D6-周末照收；对方要工作日时再加，等客户 B 段）",
];

// ———————————————————— 工具 ————————————————————

let 公: 公司;
const 项目id: Record<string, string> = {};
const 客户id: Record<string, string> = {};
const 线索id: Record<string, string> = {};
let 号 = 0;

type 回 = { ok?: boolean; error?: string } & Record<string, unknown>;
const 话 = (r: unknown) => { const x = r as 回; return x?.ok ? "成" : `拒：${x?.error ?? JSON.stringify(x)}`; };
function 得<T>(r: T, 做什么: string): T {
  const x = r as 回;
  if (!x?.ok) throw new Error(`${做什么} 没成：${x?.error ?? JSON.stringify(x)}`);
  return r;
}
function 拒(r: unknown, 话里有?: RegExp) {
  const x = r as 回;
  expect(x?.ok, `应该拒，实际成了`).toBe(false);
  if (话里有) expect(x.error).toMatch(话里有);
}

const 会话 = (key: string): 会话人 => {
  const p = 公.人[key];
  return { id: 公.id[key], name: key, email: `${key}@sim.test`, role: p.role, title: p.bizRole, avatar: null };
};

/** 以某人身份调：requireUser 认他、企业版范围按他算 */
async function 作为<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const s = 会话(key);
  mocks.user = s;
  (await 可有("lib/enterprise/visibility", "忘掉企业版范围"))?.();
  const 以谁的身份 = await 可有<(id: string, f: () => Promise<T>) => Promise<T>>("lib/enterprise/visibility", "以谁的身份");
  return 当前人.run(s, () => (以谁的身份 ? 以谁的身份(s.id, fn) : fn()));
}

const 两位 = (n: number) => String(n).padStart(2, "0");
const 现在文本 = () => {
  const d = new Date();
  return `${d.getFullYear()}-${两位(d.getMonth() + 1)}-${两位(d.getDate())} ${两位(d.getHours())}:${两位(d.getMinutes())}`;
};

function 向导输入(负责人: string, 名: string, 下一步: string | null, 指派给?: string) {
  号 += 1;
  const 尾 = String(号).padStart(4, "0");
  return {
    客户: {
      name: `客户${名}`, phone: `1390000${尾}`, school: null, grade: null, major: null,
      followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null,
      salesOwnerId: 公.id[指派给 ?? 负责人], channelId: null, referrerCustomerId: null,
    },
    联系人: { name: `联系人${名}`, position: "采购", phone: `1380000${尾}` },
    项目: { name: 名, amount: 10000, currency: "CNY", ...(指派给 ? { ownerId: 公.id[指派给] } : {}) },
    跟进: { type: "PHONE", content: `${名} 首次沟通`, occurredAt: 现在文本(), ...(下一步 ? { 下一步时间: 下一步 } : {}) },
  } as unknown as Parameters<typeof 建档向导>[0];
}

async function 建项目(谁: string, 名: string, 下一步: string | null, 指派给?: string) {
  const r = await 作为(谁, () => 建档向导(向导输入(谁, 名, 下一步, 指派给)));
  if (r.ok) { 项目id[名] = r.projectId; 客户id[名] = r.customerId; }
  return r;
}

const 项目 = (名: string) => 作为("老板", () => prisma.project.findFirstOrThrow({ where: { name: 名 } }));
const 在公海 = async (名: string) => (await 项目(名)).pooledAt !== null;
const 看到的项目 = (谁: string) =>
  作为(谁, async () => (await prisma.project.findMany({ where: { name: { startsWith: "P" } }, select: { name: true } }))
    .map((p) => p.name).sort());

async function 建线索(谁: string, 名: string, source = "市场活动") {
  const r = await 作为(谁, () => saveLead({ name: 名, phone: `1370000${String(++号).padStart(4, "0")}`, source, status: "待跟进", ownerId: 公.id[谁] }));
  得(r, `建线索 ${名}`);
  线索id[名] = (await 作为("老板", () => prisma.lead.findFirstOrThrow({ where: { name: 名 } }))).id;
}

// deactivateUser 没权限时直接抛（FORBIDDEN），这里统一成 {ok:false,error}
const 停用 = async (id: string, to: string, 方式?: string): Promise<回> => {
  try {
    return ((await (deactivateUser as unknown as (a: string, b: string, c?: string) => Promise<unknown>)(id, to, 方式)) ?? { ok: true }) as 回;
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
};

// ———————————————————— 检查点记录 ————————————————————

const 结果 = new Map<string, string | null>();
async function 查(id: string, fn: () => Promise<void> | void) {
  if (!(id in 检查点)) throw new Error(`没登记的检查点：${id}`);
  try { await fn(); 结果.set(id, null); } catch (e) {
    const x = e as { message?: string; actual?: unknown };
    const 实际 = x?.actual !== undefined && typeof x.actual === "object" ? `；实际 ${抹(JSON.stringify(x.actual))}` : "";
    结果.set(id, (String(x?.message ?? e) + 实际).slice(0, 600));
  }
}

// ———————————————————— 观测（开关关那组写金样） ————————————————————

const 观测: string[] = [];
let P3领到的人: string | null = null;
function 抹(s: string) {
  const 表: Record<string, string> = { ...公.名 };
  for (const [n, id] of Object.entries(项目id)) 表[id] = n;
  for (const [n, id] of Object.entries(客户id)) 表[id] = `客户${n}`;
  for (const [n, id] of Object.entries(线索id)) 表[id] = n;
  const t = s.replace(/\bc[a-z0-9]{20,}\b/g, (m) => 表[m] ?? "<id>");
  // 两人同时领 P3 谁赢不定：P3 那几行里赢的人记成「领到的人」，金样才稳
  if (!P3领到的人) return t;
  const 赢 = P3领到的人;
  return t.split("\n").map((l) => (/^\s*(P3 负责人|记录 P3 )/.test(l) ? l.replaceAll(赢, "领到的人") : l)).join("\n");
}
const 记 = (s: string) => 观测.push(抹(s));
const 日 = (d?: Date | null) => (d ? d.toISOString() : "-");

async function 日终(标: string) {
  记(`—— ${标} ——`);
  await 作为("老板", async () => {
    for (const p of await prisma.project.findMany({ orderBy: { name: "asc" } })) {
      记(`${p.name} 负责人=${公.名[p.ownerId] ?? p.ownerId} 创建=${公.名[p.creatorId ?? ""] ?? "-"} ${p.phase}/${p.node}${p.result ? "/" + p.result : ""} ${p.pooledAt ? "公海@" + 日(p.pooledAt) : "在手"}`);
    }
    for (const l of await prisma.projectNodeLog.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] })) {
      记(`  记录 ${项目名(l.projectId)} ${l.kind} ${l.fromNode ?? "-"}→${l.toNode ?? "-"} 人=${公.名[l.userId ?? ""] ?? "-"} 负责人 ${公.名[l.fromOwnerId ?? ""] ?? "-"}→${公.名[l.toOwnerId ?? ""] ?? "-"} @${日(l.at)}`);
    }
    for (const t of await prisma.task.findMany({ orderBy: [{ title: "asc" }] })) 记(`  任务 ${公.名[t.ownerId]} ${t.title}`);
    for (const c of await prisma.customer.findMany({ orderBy: { name: "asc" } })) 记(`  客户 ${c.name} 归属=${公.名[c.salesOwnerId ?? ""] ?? "-"}`);
    for (const l of await prisma.lead.findMany({ orderBy: { name: "asc" } })) 记(`  线索 ${l.name} 负责人=${公.名[l.ownerId ?? ""] ?? "-"} ${l.status}`);
    记(`  停用：${(await prisma.user.findMany({ where: { active: false }, orderBy: { email: "asc" } })).map((u) => u.name).join(" ") || "无"}`);
  });
  for (const 谁 of ["内销1", "组长", "内贸经理", "外贸经理", "市渠1", "内运1"]) {
    记(`  ${谁} 看到项目：${(await 看到的项目(谁)).join(" ") || "无"}`);
  }
}
const 项目名 = (id: string) => Object.entries(项目id).find(([, v]) => v === id)?.[0] ?? id;

// ———————————————————— 剧本 ————————————————————

async function 开局(企业: boolean) {
  await resetDb();
  invalidateSettingsCache();
  for (const k of Object.keys(项目id)) delete 项目id[k];
  for (const k of Object.keys(客户id)) delete 客户id[k];
  for (const k of Object.keys(线索id)) delete 线索id[k];
  号 = 0; 观测.length = 0; 结果.clear();
  if (企业) vi.stubEnv("CRM_ENTERPRISE", "1");
  开始假时间("2026-01-26 07:00");
  公 = await 建公司();
  // 规则开关和组织规则两组都写：开关关时存着也不能生效
  for (const key of ["enterprise.rule.org_scope", "enterprise.rule.lead_assign"]) await setSetting(key, true);
  await setSetting("orgRules", {
    公海: { 持有上限开: true, 默认上限: 30, 每人上限: { [公.id["外销6"]]: 2 } },
    超时回收: { 开: true, 节点天数: { 潜客培育: 3, 线索验证: 5, 明确需求: 7 } },
  });
  invalidateSettingsCache();
}

async function 扫(时刻: string): Promise<number> {
  拨到(时刻);
  const 收 = await 要<(me: { id: string; name: string }, 今?: Date) => Promise<number>>("lib/project/db", "公海超时收回", "D-34");
  return 作为("老板", () => 收(会话("老板"), new Date()));
}

/** 开关开：每条第四节规则一个检查点 */
async function 剧本开() {
  P3领到的人 = null;
  await 开局(true);
  const 分配 = await 要("app/(app)/leads/assign-actions", "分配线索", "D-38");
  const 设配额 = await 要("app/(app)/leads/assign-actions", "设配额", "D-38");
  const 本月分配情况 = await 要("app/(app)/leads/assign-actions", "本月分配情况", "D-38");
  const 我分出去的线索 = await 要("app/(app)/leads/assign-actions", "我分出去的线索", "D-38");
  const 记沟通 = await 要("app/(app)/projects/actions", "记项目沟通Action", "D-34");
  const 预览 = await 要("app/(app)/projects/actions", "预览超时回收", "D-34");
  const 持有数 = await 要("lib/project/db", "持有数", "D-35");
  const 停用清点 = await 要("app/(app)/settings/actions", "停用清点", "D-36");
  const 分给 = (谁: string, 线索: string, 给: string, line: "内贸" | "外贸" | null) =>
    作为(谁, () => 分配({ leadId: 线索id[线索], toUserId: 公.id[给], line }));

  // ——— D1 周一 1/26 ———
  拨到("2026-01-26 08:00");
  await 查("D1-配额-直属上级能设", async () => { 得(await 作为("组长", () => 设配额(公.id["内销1"], 2)), "组长设配额"); });
  await 查("D1-配额-虚线上级能设", async () => { 得(await 作为("外贸经理", () => 设配额(公.id["内销4"], 1)), "虚线上级设配额"); });
  await 作为("外贸经理", () => 设配额(公.id["外销1"], 1));
  for (const n of ["L1", "L2", "L3", "L4", "L5"]) await 建线索("市渠1", n);
  await 查("D1-营销线索分内贸", async () => {
    得(await 分给("市场经理", "L1", "内销1", "内贸"), "分 L1");
    得(await 分给("市场经理", "L2", "内销1", "内贸"), "分 L2");
  });
  await 查("D1-分满了分不进", async () => 拒(await 分给("市场经理", "L3", "内销1", "内贸"), /分满/));
  await 查("D1-营销线索分外贸", async () => { 得(await 分给("市场经理", "L3", "外销1", "外贸"), "分 L3 给外销"); });
  await 查("D1-非销售不能接", async () => 拒(await 分给("市场经理", "L4", "内运1", "内贸")));
  await 查("D1-渠道不能分", async () => 拒(await 分给("内渠1", "L4", "外销2", "外贸"), /只有老板、总管理员、市场管理/));
  await 建线索("内销1", "L自拓", "自拓");
  await 查("D1-自拓不计数", async () => {
    const 情况 = (await 作为("组长", () => 本月分配情况())) as { userId: string; 已分: number }[];
    expect(情况.find((x) => x.userId === 公.id["内销1"])?.已分).toBe(2);
  });

  得(await 建项目("内销1", "P1", "2026-01-30"), "建 P1");
  得(await 建项目("内销2", "P2", "2026-01-27"), "建 P2");
  得(await 建项目("外销1", "P3", "2026-02-05"), "建 P3");
  得(await 建项目("外销2", "P4", "2026-02-20"), "建 P4");
  await 查("D1-没下一步不能存", async () => 拒(await 建项目("内销6", "P5", null), /下一步/));
  if (!项目id["P5"]) 得(await 建项目("内销6", "P5", "2026-01-26"), "建 P5（下一步当天）");
  得(await 建项目("内销4", "P8", "2026-02-20"), "建 P8");
  得(await 建项目("外销5", "P9", "2026-02-20"), "建 P9");
  await 作为("老板", () => prisma.project.update({ where: { id: 项目id["P9"] }, data: { phase: "订单", node: "生产备货" } }));
  得(await 建项目("内销3", "P10", "2026-02-20"), "建 P10");

  await 查("D1-销售只看自己", async () => expect(await 看到的项目("内销1")).toEqual(["P1"]));
  await 查("D1-组长看下属链", async () => expect(await 看到的项目("组长")).toEqual(["P1", "P10", "P2"]));
  await 查("D1-虚线上级能看", async () => expect(await 看到的项目("外贸经理")).toContain("P8"));
  await 查("D1-虚线不能转客户", async () => {
    await 作为("外贸经理", () => assignSalesOwner([客户id["P8"]], 公.id["外销1"]));
    const c = await 作为("老板", () => prisma.customer.findUniqueOrThrow({ where: { id: 客户id["P8"] } }));
    expect(公.名[c.salesOwnerId ?? ""]).toBe("内销4");
  });

  // ——— D2 周二 1/27 ———
  await 扫("2026-01-27 08:00");
  await 查("D2-当天下一步次日收回", async () => expect(await 在公海("P5")).toBe(true));
  拨到("2026-01-27 09:00");
  await 查("D2-直属上级能推", async () => { 得(await 作为("组长", () => 改项目节点(项目id["P1"], { phase: "线索", node: "线索验证" })), "组长推 P1"); });
  await 查("D2-记谁推的", async () => {
    const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P1"], toNode: "线索验证" } }));
    expect(公.名[l.userId ?? ""]).toBe("组长");
  });
  await 查("D2-不能跳", async () => 拒(await 作为("组长", () => 改项目节点(项目id["P2"], { phase: "线索", node: "线索推进" })), /跳/));
  await 查("D2-能退", async () => {
    得(await 作为("组长", () => 改项目节点(项目id["P10"], { phase: "线索", node: "线索验证" })), "推 P10");
    得(await 作为("组长", () => 改项目节点(项目id["P10"], { phase: "线索", node: "潜客培育" })), "退 P10");
  });
  await 查("D2-销售本人不能推", async () => 拒(await 作为("内销2", () => 改项目节点(项目id["P2"], { phase: "线索", node: "线索验证" }))));
  await 查("D2-隔级经理不能推", async () => 拒(await 作为("内贸经理", () => 改项目节点(项目id["P2"], { phase: "线索", node: "线索验证" }))));
  await 查("D2-虚线上级不能推", async () => 拒(await 作为("外贸经理", () => 改项目节点(项目id["P8"], { phase: "线索", node: "线索验证" }))));
  // 上面三条现在可能把节点推动了：撤回原样，不影响后面的回收日
  await 作为("老板", async () => {
    for (const n of ["P2", "P8"]) {
      await prisma.project.update({ where: { id: 项目id[n] }, data: { node: "潜客培育" } });
      await prisma.projectNodeLog.deleteMany({ where: { projectId: 项目id[n], toNode: "线索验证" } });
    }
  });
  得(await 作为("内销1", () => convertLead(线索id["L1"])), "内销1 转化 L1");
  await 查("D2-原市场人员只读看转化", async () => {
    const 列 = (await 作为("市渠1", () => 我分出去的线索())) as { name: string; status: string }[];
    expect(列.find((x) => x.name === "L1")?.status).toBe("已转化");
  });
  await 查("D2-原市场人员改不了", async () =>
    拒(await 作为("市渠1", () => saveLead({ id: 线索id["L2"], name: "L2 改名", source: "市场活动", status: "跟进中" }))));
  拨到("2026-01-27 23:59");
  得(await 作为("外销1", () => 记沟通(项目id["P3"], { type: "PHONE", content: "P3 晚上又聊了", occurredAt: 现在文本(), 下一步时间: "2026-02-05" })), "外销1 记 P3 沟通");

  // ——— D3 周三 1/28 ———
  await 扫("2026-01-28 08:00");
  await 查("D3-按下一步收回", async () => expect(await 在公海("P2")).toBe(true));
  await 查("D3-原负责人收提醒", async () => {
    const t = await 作为("老板", () => prisma.task.findMany({ where: { ownerId: 公.id["内销2"], title: { contains: "P2" } } }));
    expect(t.length).toBe(1);
  });
  await 查("D3-进公海记历史负责人", async () => {
    const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P2"], kind: "pool-release" } }));
    expect(公.名[l.fromOwnerId ?? ""]).toBe("内销2");
  });
  拨到("2026-01-28 09:00");
  await 查("D3-沟通没下一步拒", async () =>
    拒(await 作为("内销1", () => 记沟通(项目id["P1"], { type: "PHONE", content: "P1 跟进", occurredAt: 现在文本() })), /下一步/));
  得(await 作为("内销1", () => 记沟通(项目id["P1"], { type: "PHONE", content: "P1 跟进", occurredAt: 现在文本(), 下一步时间: "2026-01-31" })), "内销1 记 P1 沟通");
  得(await 作为("内销3", () => 记沟通(项目id["P10"], { type: "PHONE", content: "P10 跟进", occurredAt: 现在文本(), 下一步时间: "2026-01-30" })), "内销3 记 P10 沟通");
  await 查("D3-原负责人领不回", async () => {
    得(await 作为("外销2", () => 放回项目公海(项目id["P4"])), "外销2 放回 P4");
    拒(await 作为("外销2", () => 领取项目(项目id["P4"])), /原负责人不能领回/);
    得(await 作为("外销3", () => 领取项目(项目id["P4"])), "外销3 领 P4");
  });
  得(await 建项目("外销6", "P11", "2026-02-20"), "建 P11");
  得(await 建项目("外销6", "P12", "2026-02-20"), "建 P12");
  await 查("D3-领取到上限拦", async () => 拒(await 作为("外销6", () => 领取项目(项目id["P5"])), /上限/));
  await 查("D3-指派到上限拦", async () => 拒(await 建项目("老板", "P13", "2026-02-20", "外销6"), /上限/));
  await 查("D3-转让到上限拦", async () =>
    拒(await 作为("老板", () => 编辑项目(项目id["P4"], { name: "P4", amount: 10000, currency: "CNY", ownerId: 公.id["外销6"] } as Parameters<typeof 编辑项目>[1])), /上限/));
  await 查("D3-同日二扫为零", async () => expect(await 扫("2026-01-28 18:00")).toBe(0));
  拨到("2026-01-28 23:59:59");
  得(await 建项目("内销2", "P6", "2026-02-20"), "建 P6");

  // ——— D4 周四 1/29 ———
  await 扫("2026-01-29 08:00");
  await 查("D4-下一步没到不收", async () => expect(await 在公海("P3")).toBe(false));
  拨到("2026-01-29 09:00");
  await 查("D4-改时长先预览", async () => {
    const 前 = await 作为("老板", () => prisma.project.count({ where: { pooledAt: { not: null } } }));
    const r = 得(await 作为("老板", () => 预览({ 超时回收: { 开: true, 节点天数: { 潜客培育: 1, 线索验证: 5, 明确需求: 7 } } })), "预览") as { 个数: number };
    expect(r.个数).toBeGreaterThan(0);
    expect(await 作为("老板", () => prisma.project.count({ where: { pooledAt: { not: null } } }))).toBe(前);
  });
  await 查("D4-原负责人领不回P2", async () => {
    拒(await 作为("内销2", () => 领取项目(项目id["P2"])), /原负责人不能领回/);
    得(await 作为("内销1", () => 领取项目(项目id["P2"])), "内销1 领 P2");
  });
  await 查("D4-历任负责人", async () => {
    const ls = await 作为("老板", () => prisma.projectNodeLog.findMany({ where: { projectId: 项目id["P2"], kind: { not: "node" } }, orderBy: { at: "asc" } }));
    expect(ls.map((l) => [l.kind, 公.名[l.fromOwnerId ?? ""] ?? null, 公.名[l.toOwnerId ?? ""] ?? null, l.at.toISOString().slice(0, 10)]))
      .toEqual([["pool-release", "内销2", null, "2026-01-28"], ["pool-claim", "内销2", "内销1", "2026-01-29"]]);
  });

  // ——— D5 周五 1/30 ———
  await 扫("2026-01-30 08:00");
  await 查("D5-按沟通时间起算", async () => expect(await 在公海("P3")).toBe(true));
  拨到("2026-01-30 10:00");
  await 查("D5-先列会转走的项目", async () => {
    const r = 得(await 作为("老板", () => 停用清点(公.id["内销3"])), "停用清点") as { 转交: { 项目: number } };
    expect(r.转交.项目).toBe(1);
  });
  await 查("D5-上级能办离职", async () => { 得(await 作为("组长", () => 停用(公.id["内销3"], 公.id["内销1"], "转交")), "组长办离职"); });
  // 组长办不了（现在只有老板能办）就由老板办，后面的检查点照常走
  if ((await 作为("老板", () => prisma.user.findUniqueOrThrow({ where: { id: 公.id["内销3"] } }))).active) {
    得(await 作为("老板", () => 停用(公.id["内销3"], 公.id["内销1"], "转交")), "老板办离职");
  }
  await 查("D5-转交一起转", async () => {
    expect(公.名[(await 项目("P10")).ownerId]).toBe("内销1");
    const c = await 作为("老板", () => prisma.customer.findUniqueOrThrow({ where: { id: 客户id["P10"] } }));
    expect(公.名[c.salesOwnerId ?? ""]).toBe("内销1");
  });
  await 查("D5-转移留记录", async () => {
    const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P10"], kind: "transfer" } }));
    expect([公.名[l.fromOwnerId ?? ""], 公.名[l.toOwnerId ?? ""], l.userId ? "有人" : "没人"]).toEqual(["内销3", "内销1", "有人"]);
  });
  await 查("D5-离职登不进来", async () =>
    expect((await 作为("老板", () => prisma.user.findUniqueOrThrow({ where: { id: 公.id["内销3"] } }))).active).toBe(false));
  await 查("D5-创建人照旧", async () => expect(公.名[(await 项目("P10")).creatorId ?? ""]).toBe("内销3"));
  await 查("D5-订单不进公海", async () => {
    得(await 作为("老板", () => 停用(公.id["外销5"], 公.id["外销4"], "公海")), "外销5 公海方式离职");
    const p = await 项目("P9");
    expect([p.pooledAt, 公.名[p.ownerId]]).toEqual([null, "外销4"]);
  });
  await 查("D5-批量离职", async () => {
    await 要("app/(app)/settings/actions", "批量停用", "D-36");
  });
  拨到("2026-01-30 23:59");
  await 查("D5-当晚还没收", async () => expect(await 在公海("P6")).toBe(false));

  // ——— D6 周六 1/31 ———
  await 扫("2026-01-31 08:00");
  await 查("D6-按时长收回", async () => expect(await 在公海("P6")).toBe(true));
  await 查("D6-周末照收", async () => expect((await 项目("P6")).pooledAt?.getDay()).toBe(6));
  await 查("D6-跨月前不收P1", async () => expect(await 在公海("P1")).toBe(false));
  拨到("2026-01-31 23:59");
  await 查("D6-月底仍满额", async () => 拒(await 分给("市场经理", "L5", "内销1", "内贸"), /分满/));
  const 月底持有 = (await 作为("老板", () => 持有数(prisma, 公.id["内销1"]))) as number;

  // ——— D7 周日 2/1 ———
  拨到("2026-02-01 00:01");
  await 查("D7-月初清零", async () => { 得(await 分给("市场经理", "L5", "内销1", "内贸"), "月初分 L5"); });
  await 查("D7-持有数不清", async () => expect(await 作为("老板", () => 持有数(prisma, 公.id["内销1"]))).toBe(月底持有));
  await 扫("2026-02-01 00:05");
  await 查("D7-跨月收回P1", async () => expect(await 在公海("P1")).toBe(true));
  拨到("2026-02-01 09:00");
  await 查("D7-自动分配", async () => {
    const 自动 = await 要("app/(app)/leads/assign-actions", "自动分配线索", "D-38");
    const r = 得(await 作为("市场经理", () => 自动(线索id["L4"])), "自动分配 L4") as { toUserId: string };
    // 没填配额的不参与自动分配（10-25）：D1 只给内销1（2）、内销4（1）、外销1（1）填了配额。
    // 2 月刚清零，内销1 手动分了 L5 已是 1 条；内销4、外销1 都是 0 条，并列给进池早的那个
    expect(["内销4", "外销1"]).toContain(公.名[r.toUserId]);
  });
  await 查("D7-两人同时领只一个", async () => {
    const 两人 = ["外销2", "外销3"] as const;
    const rs = await Promise.all(两人.map((k) => 作为(k, () => 领取项目(项目id["P3"]))));
    P3领到的人 = 两人[rs.findIndex((r) => r.ok)] ?? null;
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect((rs.find((r) => !r.ok) as 回).error).toMatch(/领走/);
  });
  await 查("D7-收回都有提醒", async () => {
    // P2 收回两次：1/28 一次（提醒内销2）；内销1 1/29 领走后潜客培育 3 天，2/1 00:05 又一次（提醒内销1）
    for (const [n, 谁, 次] of [["P1", "内销1", 1], ["P2", "内销2", 1], ["P2", "内销1", 1], ["P3", "外销1", 1], ["P5", "内销6", 1], ["P6", "内销2", 1]] as const) {
      const t = await 作为("老板", () => prisma.task.count({ where: { ownerId: 公.id[谁], title: { contains: `「${n}」` } } }));
      expect(t, `${n} → ${谁}`).toBe(次);
    }
  });
  await 查("D7-订单一个没进公海", async () =>
    expect(await 作为("老板", () => prisma.project.count({ where: { phase: "订单", pooledAt: { not: null } } }))).toBe(0));

  await 补查();
}

/** 补：剧本走完接着查第四节里剧本没碰到的几条（2/1 起；只在开关开那组跑） */
async function 补查() {
  const 改规则 = await 要("app/(app)/projects/actions", "改组织规则", "D-34");
  const 领客户 = await 要("app/(app)/customers/pool-actions", "领取", "D-36");
  拨到("2026-02-01 09:30");
  await 查("补-必填字段谁能改", async () => {
    const 改 = { 节点推进: { 开: true, 必填: { 潜客培育: ["需求"], 线索验证: ["国家"] } } };
    拒(await 作为("组长", () => 改规则(改)), /节点必填字段只有老板、总管理员能改/);
    得(await 作为("总管理", () => 改规则({ 节点推进: { 开: false } })), "总管理改必填");
    得(await 作为("老板", () => 改规则(改)), "老板开必填");
  });
  await 查("补-自己建项目不算上限", async () => { 得(await 建项目("外销6", "P21", "2026-02-20"), "外销6 自己建 P21"); });

  得(await 建项目("内销2", "P20", "2026-02-20"), "建 P20");
  await 查("补-必填节点销售推不动", async () =>
    拒(await 作为("内销2", () => 改项目节点(项目id["P20"], { phase: "线索", node: "线索验证" })), /直属上级/));
  await 查("补-必填填齐自动推", async () => {
    const r = 得(await 作为("内销2", () => 编辑项目(项目id["P20"], { name: "P20", amount: 10000, currency: "CNY", remark: "要 200 套" } as Parameters<typeof 编辑项目>[1])), "内销2 填需求") as { 自动推到?: string[] };
    expect(r.自动推到).toEqual(["线索验证"]);
    expect((await 项目("P20")).node).toBe("线索验证");
    const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P20"], kind: "node", toNode: "线索验证" } }));
    expect(公.名[l.userId ?? ""]).toBe("内销2");
  });
  await 查("补-直属上级缺必填也能推", async () => {
    得(await 作为("组长", () => 改项目节点(项目id["P20"], { phase: "线索", node: "线索推进" })), "组长推 P20");
    expect((await 项目("P20")).node).toBe("线索推进");
  });
  await 查("补-总管理员能推", async () => {
    得(await 作为("总管理", () => 改项目节点(项目id["P8"], { phase: "线索", node: "线索验证" })), "总管理推 P8");
    expect((await 项目("P8")).node).toBe("线索验证");
  });
  await 查("补-直属又是虚线取并集", async () => {
    const 设直属 = (谁: string) => 作为("老板", () => prisma.entMember.update({ where: { userId: 公.id["内销4"] }, data: { managerId: 公.id[谁] } }));
    await 设直属("外贸经理");
    try {
      expect(await 看到的项目("外贸经理")).toContain("P8");
      得(await 作为("外贸经理", () => 改项目节点(项目id["P8"], { phase: "线索", node: "线索推进" })), "外贸经理推 P8");
      const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P8"], kind: "node", toNode: "线索推进" } }));
      expect(公.名[l.userId ?? ""]).toBe("外贸经理");
    } finally { await 设直属("内贸经理"); }
  });
  await 查("补-扫描留痕带项目", async () => {
    const 们 = await 作为("老板", () => prisma.auditLog.findMany({ where: { action: "pool", entity: "Project" }, orderBy: { at: "asc" } }));
    const 带着 = 们.flatMap((a) => ((a.detail ? JSON.parse(a.detail) : {}) as { ids?: string[] }).ids ?? []);
    expect(带着).toEqual(expect.arrayContaining([项目id["P1"], 项目id["P2"], 项目id["P5"], 项目id["P6"]]));
  });
  await 查("补-停用的人领不了", async () => 拒(await 作为("内销3", () => 领取项目(项目id["P5"])), /停用/));

  // 内销5 离职进公海：P30 有订单、P31 普通客户、P32 是他负责但客户是内销6 的
  拨到("2026-02-01 10:00");
  得(await 建项目("内销5", "P30", "2026-02-20"), "建 P30");
  得(await 建项目("内销5", "P31", "2026-02-02"), "建 P31");
  得(await 建项目("内销6", "P32", "2026-02-20"), "建 P32");
  await 作为("老板", async () => {
    await prisma.project.update({ where: { id: 项目id["P30"] }, data: { phase: "订单", node: "生产备货" } });
    await prisma.project.update({ where: { id: 项目id["P32"] }, data: { ownerId: 公.id["内销5"] } });
  });
  await 查("补-公海离职三分", async () => {
    得(await 作为("老板", () => 停用(公.id["内销5"], 公.id["内销4"], "公海")), "内销5 公海方式离职");
    const [p30, p31, p32] = [await 项目("P30"), await 项目("P31"), await 项目("P32")];
    const 客 = (n: string) => 作为("老板", () => prisma.customer.findUniqueOrThrow({ where: { id: 客户id[n] }, include: { pool: true } }));
    const [c30, c31] = [await 客("P30"), await 客("P31")];
    expect({
      P30: [公.名[p30.ownerId], p30.pooledAt, 公.名[c30.salesOwnerId ?? ""], !!c30.pool],
      P31: [公.名[p31.ownerId], p31.pooledAt, !!c31.pool],
      P32: [p32.pooledAt !== null],
    }).toEqual({ P30: ["内销4", null, "内销4", false], P31: ["内销5", null, true], P32: [true] });
  });
  await 扫("2026-02-05 08:00");
  await 查("补-扫描不动客户公海里的项目", async () => expect(await 在公海("P31")).toBe(false));
  拨到("2026-02-05 09:00");
  await 查("补-领客户带走项目", async () => {
    得(await 作为("内销6", () => 领客户([客户id["P31"]])), "内销6 领客户P31");
    expect(公.名[(await 项目("P31")).ownerId]).toBe("内销6");
    const l = await 作为("老板", () => prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: 项目id["P31"], kind: "transfer" }, orderBy: { at: "desc" } }));
    expect([公.名[l.fromOwnerId ?? ""], 公.名[l.toOwnerId ?? ""]]).toEqual(["内销5", "内销6"]);
  });
  await 查("补-周末全库一致", async () => {
    await 作为("老板", async () => {
      expect(await prisma.project.count({ where: { phase: "订单", pooledAt: { not: null } } }), "公海里的订单项目").toBe(0);
      const 离职 = (await prisma.user.findMany({ where: { active: false }, select: { id: true } })).map((u) => u.id);
      const 挂着 = await prisma.project.findMany({ where: { pooledAt: null, result: null, ownerId: { in: 离职 }, customer: { pool: { is: null } } }, select: { name: true } });
      expect(挂着.map((p) => p.name), "在职项目挂在离职人名下").toEqual([]);
      const 公海里 = await prisma.project.findMany({ where: { pooledAt: { not: null } }, select: { id: true, name: true } });
      for (const p of 公海里) {
        const 有 = await prisma.projectNodeLog.count({ where: { projectId: p.id, kind: "pool-release" } });
        expect(有, `${p.name} 进公海没记录`).toBeGreaterThan(0);
      }
    });
  });
}

/** 开关关：只调 main 上就有的接口，观测写进金样 */
async function 剧本关() {
  P3领到的人 = null;
  await 开局(false);
  拨到("2026-01-26 08:00");
  for (const n of ["L1", "L2", "L3"]) await 建线索("市渠1", n);
  for (const [谁, 名, 下一步] of [
    ["内销1", "P1", "2026-01-30"], ["内销2", "P2", "2026-01-27"], ["外销1", "P3", "2026-02-05"], ["外销2", "P4", "2026-02-20"],
    ["内销6", "P5", null], ["内销4", "P8", "2026-02-20"], ["外销5", "P9", "2026-02-20"], ["内销3", "P10", "2026-02-20"],
  ] as const) 记(`D1 ${谁} 建 ${名}（下一步 ${下一步 ?? "不填"}）→ ${话(await 建项目(谁, 名, 下一步))}`);
  await 作为("老板", () => prisma.project.update({ where: { id: 项目id["P9"] }, data: { phase: "订单", node: "生产备货" } }));
  记(`D1 外贸经理 转 客户P8 给外销1 → ${话(await 作为("外贸经理", () => assignSalesOwner([客户id["P8"]], 公.id["外销1"])))}`);
  await 日终("D1 1/26");

  拨到("2026-01-27 09:00");
  for (const [谁, 名, 到] of [
    ["组长", "P1", "线索验证"], ["组长", "P2", "线索推进"], ["内销2", "P2", "线索验证"], ["内贸经理", "P2", "线索验证"],
    ["外贸经理", "P8", "线索验证"], ["组长", "P10", "线索验证"], ["组长", "P10", "潜客培育"], ["外销1", "P1", "线索推进"],
  ] as const) 记(`D2 ${谁} 推 ${名} → ${到}：${话(await 作为(谁, () => 改项目节点(项目id[名], { phase: "线索", node: 到 })))}`);
  记(`D2 内销1 转化 L1 → ${话(await 作为("内销1", () => convertLead(线索id["L1"])))}`);
  记(`D2 市渠1 改 L2 → ${话(await 作为("市渠1", () => saveLead({ id: 线索id["L2"], name: "L2 改名", source: "市场活动", status: "跟进中" })))}`);
  await 日终("D2 1/27");

  拨到("2026-01-28 09:00");
  记(`D3 外销2 放回 P4 → ${话(await 作为("外销2", () => 放回项目公海(项目id["P4"])))}`);
  记(`D3 外销2 领回 P4 → ${话(await 作为("外销2", () => 领取项目(项目id["P4"])))}`);
  记(`D3 外销6 建 P11 → ${话(await 建项目("外销6", "P11", "2026-02-20"))}`);
  记(`D3 外销6 建 P12 → ${话(await 建项目("外销6", "P12", "2026-02-20"))}`);
  记(`D3 老板 指派 P13 给外销6 → ${话(await 建项目("老板", "P13", "2026-02-20", "外销6"))}`);
  拨到("2026-01-28 23:59:59");
  记(`D3 内销2 建 P6 → ${话(await 建项目("内销2", "P6", "2026-02-20"))}`);
  await 日终("D3 1/28");

  拨到("2026-01-29 09:00");
  记(`D4 外销6 领 P4 → ${话(await 作为("外销6", () => 领取项目(项目id["P4"])))}`);
  记(`D4 老板 转 P2 给外销6 → ${话(await 作为("老板", () => 编辑项目(项目id["P2"], { name: "P2", amount: 10000, currency: "CNY", ownerId: 公.id["外销6"] } as Parameters<typeof 编辑项目>[1])))}`);
  await 日终("D4 1/29");

  拨到("2026-01-30 10:00");
  记(`D5 组长 办内销3 离职 → ${话(await 作为("组长", () => 停用(公.id["内销3"], 公.id["内销1"])))}`);
  记(`D5 老板 办内销3 离职转内销1 → ${话(await 作为("老板", () => 停用(公.id["内销3"], 公.id["内销1"])))}`);
  记(`D5 老板 办外销5 离职转外销4 → ${话(await 作为("老板", () => 停用(公.id["外销5"], 公.id["外销4"])))}`);
  await 日终("D5 1/30");

  拨到("2026-02-01 09:00");
  记(`D7 外销1 放回 P3 → ${话(await 作为("外销1", () => 放回项目公海(项目id["P3"])))}`);
  const 两人 = ["外销2", "外销3"] as const;
  const rs = await Promise.all(两人.map((k) => 作为(k, () => 领取项目(项目id["P3"]))));
  P3领到的人 = 两人[rs.findIndex((r) => r.ok)] ?? null;
  记(`D7 外销2、外销3 同时领 P3 → 领到 ${rs.filter((r) => r.ok).length} 个；没领到的：${rs.filter((r) => !r.ok).map(话).join(" / ") || "无"}`);
  await 日终("D7 2/1");
}

// ———————————————————— 两组 ————————————————————

describe.skipIf(!开关开能跑)("一周模拟 · 开关开（第四节规则）", () => {
  beforeAll(async () => { await 剧本开(); }, 120_000);
  afterAll(() => { 停掉假时间(); vi.unstubAllEnvs(); });

  for (const [id, 说] of Object.entries(检查点)) {
    const 红 = 红清单[id];
    (红 ? it.fails : it)(`${id}：${说}${红 ? `（现在红：${红}）` : ""}`, () => {
      const r = 结果.get(id);
      if (r === undefined) throw new Error("剧本没走到这一步");
      if (r) throw new Error(r);
    });
  }
  it("红清单里没有已删掉的检查点", () => {
    expect(Object.keys(红清单).filter((id) => !(id in 检查点))).toEqual([]);
  });
  for (const t of 未定) it.todo(t);
});

describe("一周模拟 · 开关关（和 main 一致）", () => {
  beforeAll(async () => { await 剧本关(); }, 120_000);
  afterAll(() => { 停掉假时间(); });

  it("七天的观测和 main 上的金样一字不差", async () => {
    await expect(观测.join("\n") + "\n").toMatchFileSnapshot("./sim/__金样__/开关关.txt");
  });
});
