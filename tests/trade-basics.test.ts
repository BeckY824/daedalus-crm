/**
 * 外贸基础五件（2026-10-16，进 0.46.19；总控转达用户「表 1 里再想想，做必做的」）：
 *   1. 跟进方式加 WhatsApp（外贸模版里排最前，老数据不动）
 *   2. 完成一条计划时弹小框：方式 + 一句话 + 下次时间（默认 7 天后），保留「跳过，直接完成」
 *   3. 客户等级 A/B/C/D：可选字段，列表能筛能排，导入导出认这一列
 *   4. 对方当地时间：按国家（多时区取首都），和本机同一钟点不显示
 *   5. 客户官网字段，可点开
 * 团队同步（新列跨版本）见 tests/trade-basics-sync.test.ts；界面走一遍见 e2e/trade-basics.spec.ts。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", async (原) => ({ ...(await 原<object>()), requireUser: async () => mocks.user, requireAdmin: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";
import { BUSINESS_PRESETS, DEFAULT_BUSINESS } from "@/lib/business-config";
import { saveCustomer, patchCustomer } from "@/app/(app)/customers/actions";
import { saveFollowUp, savePlan, 撤销记一笔 } from "@/app/(app)/customers/[id]/actions";
import { 取客户近况 } from "@/app/(app)/customers/[id]/pick";
import { 执行导入 } from "@/app/(app)/customers/import-actions";
import { 导出客户 } from "@/app/(app)/customers/export-action";
import { 客户导出表 } from "@/app/(app)/customers/export-table";
import { 客户筛选条件 } from "@/app/(app)/customers/query";
import { 未分级 } from "@/app/(app)/customers/query-shared";
import { 字段表, 猜列 } from "@/lib/import/fields";
import { 认等级, 规整官网, 官网网址, 官网短写, 规整外贸格, 等级序, 改过的档案, 外贸键 } from "@/lib/customer-extra";
import { 对方当地, 国家时区 } from "@/lib/country-time";
import { 国家候选 } from "@/lib/customer-extra";
import { FOLLOW_TYPES, FOLLOW_TYPE_MAP, FOLLOW_METHODS, 跟进类型们 } from "@/lib/constants";
import { 手机跟进类型 } from "@/lib/mobile/sync";
import { 方式到类型, 下次主题, 默认完成类型 } from "@/app/(app)/customers/[id]/CompletePlanModal";
import { 客户关键词条件, 网址域名 } from "@/lib/search-keyword";

const 关键词 = async (k: string) => (await prisma.customer.findMany({ where: await 客户关键词条件(k), select: { id: true } })).map((x) => x.id);

let jia: { id: string };

async function 外贸() {
  await setSetting("business", BUSINESS_PRESETS["外贸出口"]);
  invalidateSettingsCache();
}

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  jia = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  mocks.user = { id: jia.id, name: "甲", email: "jia", role: "ADMIN", title: "管理员", avatar: null };
});

const base = { phone: "", school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: null, channelId: null, referrerCustomerId: null };
async function 建客户(name: string, extra: Record<string, string | null>) {
  const r = await saveCustomer({ ...base, name, phone: "", extra: { whatsapp: `+971 50 ${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, ...extra } });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

describe("规则（不碰库）", () => {
  it("客户等级：只收 A–D，大小写、「A级」「B 类」都认；别的说法不收；空就是没分级", () => {
    expect(认等级("a")).toBe("A");
    expect(认等级(" B 级 ")).toBe("B");
    expect(认等级("C类")).toBe("C");
    expect(认等级("")).toBeNull();
    expect(认等级(null)).toBeNull();
    expect(认等级("E")).toBeUndefined();
    expect(认等级("重点")).toBeUndefined();
    expect(规整外贸格("level", "d")).toEqual({ ok: true, v: "D" });
    expect(规整外贸格("level", "AA")).toMatchObject({ ok: false, error: expect.stringContaining("A / B / C / D") });
    // 排序：A 在前，没分级的最后
    expect(["C", null, "A", "D", "B"].sort((x, y) => 等级序(x) - 等级序(y))).toEqual(["A", "B", "C", "D", null]);
  });

  it("官网：存人填的样子（去末尾斜杠），点开补 https；一句话、javascript:、没有点的不收", () => {
    expect(规整官网(" www.acme.com/ ")).toEqual({ ok: true, v: "www.acme.com" });
    expect(规整官网("https://acme.co.uk/en")).toEqual({ ok: true, v: "https://acme.co.uk/en" });
    expect(规整官网("")).toEqual({ ok: true, v: null });
    expect(规整官网("acme company")).toMatchObject({ ok: false });
    expect(规整官网("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(规整官网("localhost")).toMatchObject({ ok: false });
    expect(规整外贸格("website", "ftp://acme.com")).toMatchObject({ ok: false });
    expect(官网网址("www.acme.com")).toBe("https://www.acme.com");
    expect(官网网址("http://acme.com")).toBe("http://acme.com");
    expect(官网网址("不是网址")).toBeNull();
    expect(官网网址(null)).toBeNull();
    expect(官网短写("https://www.acme.com/")).toBe("acme.com");
  });

  it("编辑框只交改过的格：等级、官网和原来的五格一样", () => {
    expect(外贸键).toEqual(["country", "whatsapp", "wechat", "email", "source", "level", "website", "alibabaId"]);
    const 原 = { country: "美国", whatsapp: null, wechat: null, email: null, source: null, level: "B", website: null, alibabaId: null };
    expect(改过的档案({ country: "美国", level: "A", website: "acme.com" }, 原)).toEqual({ level: "A", website: "acme.com" });
    expect(改过的档案({ country: "美国", level: undefined }, 原)).toEqual({ level: null });
  });

  it("对方当地时间：按首都时区，夏令时交给 Intl；和本机同一钟点、认不出的国家不显示", () => {
    // 2026-10-16 06:05 UTC：北京 14:05、纽约（夏令时）02:05、伦敦（夏令时）07:05、迪拜 10:05、悉尼（夏令时）17:05
    const 那一刻 = new Date("2026-10-16T06:05:00Z");
    expect(对方当地("美国", 那一刻, "Asia/Shanghai")).toMatchObject({ 时分: "02:05", 日差: "", 夜里: true, 说法: "对方当地 02:05", 时区: "America/New_York" });
    expect(对方当地("英国", 那一刻, "Asia/Shanghai")).toMatchObject({ 时分: "07:05", 夜里: false });
    expect(对方当地("UAE", 那一刻, "Asia/Shanghai")).toMatchObject({ 时分: "10:05", 时区: "Asia/Dubai" });
    expect(对方当地("澳大利亚", 那一刻, "Asia/Shanghai")).toMatchObject({ 时分: "17:05" });
    // 跨日：北京 10-16 01:30 时纽约还是 10-15 13:30
    expect(对方当地("美国", new Date("2026-10-15T17:30:00Z"), "Asia/Shanghai")).toMatchObject({ 时分: "13:30", 日差: "前一天", 说法: "对方当地 前一天 13:30" });
    // 伦敦人看悉尼：已经是第二天
    expect(对方当地("澳大利亚", new Date("2026-10-16T20:00:00Z"), "Europe/London")).toMatchObject({ 日差: "次日" });
    // 冬令时：纽约 12 月比北京慢 13 小时
    expect(对方当地("美国", new Date("2026-12-01T06:05:00Z"), "Asia/Shanghai")).toMatchObject({ 时分: "01:05" });
    // 和本机一样的钟点：不说
    expect(对方当地("中国", 那一刻, "Asia/Shanghai")).toBeNull();
    expect(对方当地("新加坡", 那一刻, "Asia/Shanghai")).toBeNull();
    expect(对方当地("火星", 那一刻, "Asia/Shanghai")).toBeNull();
    expect(对方当地(null, 那一刻, "Asia/Shanghai")).toBeNull();
  });

  it("国家候选里的每个国家都有时区，而且这台机器的 Intl 认得", () => {
    for (const 国 of 国家候选.flatMap((g) => g.国家)) {
      expect(国家时区[国], 国).toBeTruthy();
      // 认不得的话 对方当地 会返回 null；拿一个和北京差得开的时刻试（中国、中国台湾等同钟点的跳过）
      const r = 对方当地(国, new Date("2026-10-16T06:05:00Z"), "Pacific/Honolulu");
      expect(r, 国).not.toBeNull();
    }
  });

  it("跟进类型：有 WhatsApp；外贸模版排最前，通用照原来的顺序；存的值不变", () => {
    expect(FOLLOW_TYPE_MAP.WHATSAPP).toMatchObject({ label: "WhatsApp" });
    expect(跟进类型们(true)[0].value).toBe("WHATSAPP");
    expect(跟进类型们(true)).toHaveLength(FOLLOW_TYPES.length);
    expect(跟进类型们(false)).toBe(FOLLOW_TYPES);
    expect(跟进类型们(false)[0].value).toBe("PHONE");
    expect(FOLLOW_METHODS).toContain("WhatsApp");
    expect(手机跟进类型).toContain("WHATSAPP");
  });

  it("完成计划小框：计划上的方式认成跟进类型；下次的主题取这句话的第一句", () => {
    expect(方式到类型("电话沟通", true)).toBe("PHONE");
    expect(方式到类型("WhatsApp", false)).toBe("WHATSAPP");
    expect(方式到类型("whatsapp 语音", false)).toBe("WHATSAPP");
    expect(方式到类型("微信沟通", true)).toBe("WECHAT"); // 2026-10-19 加了微信沟通，原来归到短信
    expect(方式到类型("邮件沟通", true)).toBe("EMAIL");
    expect(方式到类型("线上会议", true)).toBe("MEETING");
    expect(方式到类型("去展会见面", true)).toBe("VISIT");
    expect(方式到类型("随便写的", true)).toBe("WHATSAPP");
    expect(方式到类型("随便写的", false)).toBe("PHONE");
    expect(方式到类型("跟进任务", true)).toBe("WHATSAPP"); // 任务 / 提醒不是一次沟通
    expect(下次主题("客户要新报价，下周回")).toBe("接着跟进：客户要新报价");
    expect(下次主题("   ")).toBe("接着跟进");
  });

  it("小框的方式（2026-10-17）：有 WhatsApp 号、计划写的是空或老默认「电话沟通」→ WhatsApp；写了别的照它的；没号照旧", () => {
    expect(默认完成类型("电话沟通", true, true)).toBe("WHATSAPP");
    expect(默认完成类型("", false, true)).toBe("WHATSAPP");
    expect(默认完成类型("邮件沟通", true, true)).toBe("EMAIL");
    expect(默认完成类型("上门拜访", false, true)).toBe("VISIT");
    expect(默认完成类型("电话沟通", true, false)).toBe("PHONE");
    expect(默认完成类型("电话沟通", true)).toBe("PHONE");
  });

  it("搜索里的网址规整成域名（2026-10-17）：去协议、www.、端口、路径、末尾斜杠，小写；不像网址的不动", () => {
    expect(网址域名("https://www.acme.com/")).toBe("acme.com");
    expect(网址域名("www.acme.com/contact")).toBe("acme.com");
    expect(网址域名(" WWW.ACME.COM ")).toBe("acme.com");
    expect(网址域名("http://acme.co.uk:8080/en?x=1#top")).toBe("acme.co.uk");
    expect(网址域名("acme.com")).toBe("acme.com");
    expect(网址域名("sales@acme.com")).toBeNull();
    expect(网址域名("张三")).toBeNull();
    expect(网址域名("acme company")).toBeNull();
  });
});

describe("客户等级 / 官网落库、筛选、排序", () => {
  it("新建、行内改、清空都走同一套规整；坏值拦下不写；留痕叫「客户等级」「官网」", async () => {
    await 外贸();
    const id = await 建客户("Acme", { country: "USA", level: "a", website: "www.acme.com/" });
    expect(await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: id } })).toMatchObject({ country: "美国", level: "A", website: "www.acme.com" });
    expect(await patchCustomer(id, "level", "c 级")).toMatchObject({ ok: true });
    expect(await patchCustomer(id, "level", "VIP")).toMatchObject({ ok: false });
    expect(await patchCustomer(id, "website", "acme company")).toMatchObject({ ok: false });
    expect(await patchCustomer(id, "website", "https://acme.com")).toMatchObject({ ok: true });
    expect(await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: id } })).toMatchObject({ level: "C", website: "https://acme.com" });
    expect(await patchCustomer(id, "level", null)).toMatchObject({ ok: true });
    expect((await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: id } })).level).toBeNull();
    const 痕 = (await prisma.auditLog.findMany({ select: { summary: true } })).map((x) => x.summary).join("\n");
    expect(痕).toContain("客户等级");
    expect(痕).toContain("官网");
  });

  it("老数据零影响：没填等级、官网的客户（含没有档案行的）照常读写", async () => {
    await 外贸();
    const 老 = await prisma.customer.create({ data: { name: "Old", phone: "13800000000", salesOwnerId: jia.id } });
    const 有档 = await prisma.customer.create({ data: { name: "Old2", phone: "13800000001", salesOwnerId: jia.id, extra: { create: { country: "日本" } } } });
    expect(await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: 有档.id } })).toMatchObject({ country: "日本", level: null, website: null });
    expect(await patchCustomer(老.id, "country", "日本")).toMatchObject({ ok: true });
    expect(await prisma.customerExtra.findUniqueOrThrow({ where: { customerId: 老.id } })).toMatchObject({ level: null, website: null });
  });

  it("按等级筛：A 只出 A；「未分级」出没填的（含没有档案行的）；乱写的不筛；和国家一起筛也对", async () => {
    await 外贸();
    const a = await 建客户("A1", { level: "A", country: "美国" });
    const a2 = await 建客户("A2", { level: "A", country: "日本" });
    await 建客户("B1", { level: "B" });
    const 空 = await 建客户("N1", { country: "美国" });
    const 没行 = (await prisma.customer.create({ data: { name: "N2", phone: "13900000000", salesOwnerId: jia.id } })).id;
    const 找 = async (sp: Parameters<typeof 客户筛选条件>[0]) => (await prisma.customer.findMany({ where: await 客户筛选条件(sp), select: { id: true } })).map((x) => x.id).sort();
    expect(await 找({ level: "A" })).toEqual([a, a2].sort());
    expect(await 找({ level: "A", country: "美国" })).toEqual([a]);
    expect(await 找({ level: 未分级 })).toEqual([空, 没行].sort());
    expect((await 找({ level: "Z" })).length).toBe(5);
  });

  it("按等级排：A→D，没分级的总在最后（和列表页同一个 orderBy）", async () => {
    await 外贸();
    for (const [n, l] of [["c", "C"], ["none", null], ["a", "A"], ["d", "D"], ["b", "B"]] as const) await 建客户(n, l ? { level: l } : {});
    await prisma.customer.create({ data: { name: "没行", phone: "13900000001", salesOwnerId: jia.id } });
    const 排 = async (dir: "asc" | "desc") => (await prisma.customer.findMany({
      orderBy: [{ extra: { level: { sort: dir, nulls: "last" } } }, { createdAt: "desc" }, { id: "desc" }],
      select: { name: true },
    })).map((x) => x.name);
    expect((await 排("asc")).slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    expect((await 排("asc")).slice(4).sort()).toEqual(["none", "没行"]);
    expect((await 排("desc")).slice(0, 4)).toEqual(["d", "c", "b", "a"]);
  });

  it("搜官网的域名搜得到这位", async () => {
    await 外贸();
    const id = await 建客户("Globex", { website: "www.globex-industrial.com" });
    expect(await 关键词("globex-industrial")).toEqual([id]);
  });

  it("粘完整网址也搜得到（2026-10-17 PR26 手测：从「官网 ↗」打开再从地址栏复制回来的）", async () => {
    await 外贸();
    const id = await 建客户("Globex", { website: "www.globex-industrial.com" });
    const 另一位 = await 建客户("Initech", { website: "https://initech.co.uk/en" });
    expect(await 关键词("https://www.globex-industrial.com/")).toEqual([id]);
    expect(await 关键词("www.globex-industrial.com/contact")).toEqual([id]);
    expect(await 关键词("HTTPS://GLOBEX-INDUSTRIAL.COM")).toEqual([id]);
    expect(await 关键词("http://www.initech.co.uk/about/")).toEqual([另一位]);
    expect(await 关键词("https://www.nobody.com/")).toEqual([]);
  });
});

describe("导入导出认这两列", () => {
  it("导入：「客户等级」「官网」各落各的格；等级坏值并进备注不丢字；导出原样导回", async () => {
    await 外贸();
    const 表头 = ["客户名称", "WhatsApp", "国家", "客户等级", "官网"];
    const 映射 = 猜列(表头, 字段表(BUSINESS_PRESETS["外贸出口"]));
    expect(映射[3]).toBe("level");
    expect(映射[4]).toBe("website");
    const w = await 执行导入({ 表头, 数据: [["Timur", "+998 90 123 4567", "Uzbekistan", "b级", "tb.uz"], ["Bad", "+998 90 765 4321", "", "VIP", "not a site"]], 映射, 重复行: "跳过" }, "lv.xlsx");
    if (!w.ok) throw new Error(w.error);
    const timur = await prisma.customer.findFirstOrThrow({ where: { name: "Timur" }, include: { extra: true } });
    expect(timur.extra).toMatchObject({ level: "B", website: "tb.uz", country: "乌兹别克斯坦" });
    const bad = await prisma.customer.findFirstOrThrow({ where: { name: "Bad" }, include: { extra: true } });
    expect(bad.extra?.level ?? null).toBeNull();
    expect(bad.remark).toContain("VIP");
    expect(bad.remark).toContain("not a site");

    const 出 = await 导出客户({});
    if (!出.ok) throw new Error(出.error);
    const t = 客户导出表(出.rows, BUSINESS_PRESETS["外贸出口"]);
    expect(t.head).toContain("客户等级");
    expect(t.head).toContain("官网");
    expect(t.body.find((r) => r[0] === "Timur")?.[t.head.indexOf("客户等级")]).toBe("B");
    await prisma.customer.deleteMany();
    const w2 = await 执行导入({ 表头: t.head, 数据: t.body, 映射: 猜列(t.head, 字段表(BUSINESS_PRESETS["外贸出口"])), 重复行: "跳过" }, "回.xlsx");
    if (!w2.ok) throw new Error(w2.error);
    const 回 = await prisma.customer.findFirstOrThrow({ where: { name: "Timur" }, include: { extra: true } });
    expect(回.extra).toMatchObject({ level: "B", website: "tb.uz" });
    expect(回.remark ?? "").not.toContain("tb.uz");
  });

  it("通用模版不认这两列（和国家那几列一样只在外贸下开），导出也不写", async () => {
    await setSetting("business", DEFAULT_BUSINESS);
    invalidateSettingsCache();
    expect(字段表(DEFAULT_BUSINESS).some((f) => f.名 === "level" || f.名 === "website")).toBe(false);
    expect(客户导出表([], DEFAULT_BUSINESS).head).not.toContain("客户等级");
  });
});

describe("跟进方式 WhatsApp + 完成计划时记一笔", () => {
  it("记一条 WhatsApp 跟进；老类型的记录不动", async () => {
    await 外贸();
    const id = await 建客户("Wa", {});
    const 老 = await prisma.followUp.create({ data: { customerId: id, ownerId: jia.id, type: "SMS", title: "", content: "老的" } });
    const r = await saveFollowUp({ customerId: id, type: "WHATSAPP", content: "客户在 WhatsApp 上要了目录", status: "已完成", occurredAt: new Date().toISOString() });
    expect(r.ok).toBe(true);
    expect(await prisma.followUp.count({ where: { type: "WHATSAPP" } })).toBe(1);
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: 老.id } })).type).toBe("SMS");
    const 痕 = await prisma.auditLog.findFirstOrThrow({ where: { entity: "FollowUp", entityId: (r as { id: string }).id } });
    expect(痕.summary).toContain("WhatsApp");
  });

  it("小框「保存并完成」= 一条已完成的跟进 + 计划勾掉 + 7 天后（日期，不定钟点）的下一条计划，一个事务", async () => {
    await 外贸();
    const id = await 建客户("Plan", {});
    const p = await savePlan({ customerId: id, subject: "发报价", plannedAt: new Date().toISOString(), method: "WhatsApp" });
    if (!p.ok) throw new Error("建计划失败");
    const 下次 = "2026-10-23";
    // 和 CompletePlanModal 保存() 交的一模一样
    const r = await saveFollowUp({
      customerId: id, type: 方式到类型("WhatsApp", true), title: "", content: "报价发了，客户说下周回", status: "已完成", occurredAt: new Date().toISOString(),
      附带: { tasks: [], plan: { subject: 下次主题("报价发了，客户说下周回"), plannedAt: 下次, method: FOLLOW_TYPE_MAP.WHATSAPP.label }, 完成计划: p.id },
    });
    expect(r.ok).toBe(true);
    expect(await prisma.followUp.findFirstOrThrow({ where: { customerId: id } })).toMatchObject({ type: "WHATSAPP", status: "已完成", content: "报价发了，客户说下周回" });
    expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ done: true });
    const 新 = await prisma.followPlan.findFirstOrThrow({ where: { customerId: id, done: false } });
    expect(新).toMatchObject({ subject: "接着跟进：报价发了", method: "WhatsApp", plannedOn: 下次, plannedHasTime: false });
    // 最近跟进跟着动
    expect((await prisma.customer.findUniqueOrThrow({ where: { id } })).lastFollowAt).not.toBeNull();
  });

  it("小框选「不排」：只记一笔 + 勾掉计划，不多出计划；内容空着交不上去（框里的保存按钮也是灰的）", async () => {
    await 外贸();
    const id = await 建客户("Plan2", {});
    const p = await savePlan({ customerId: id, subject: "回访", plannedAt: new Date().toISOString(), method: "电话沟通" });
    if (!p.ok) throw new Error("建计划失败");
    expect(await saveFollowUp({ customerId: id, type: "PHONE", content: "  ", status: "已完成", occurredAt: new Date().toISOString(), 附带: { tasks: [], 完成计划: p.id } })).toMatchObject({ ok: false });
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(false);
    expect(await saveFollowUp({ customerId: id, type: "PHONE", content: "打过了", status: "已完成", occurredAt: new Date().toISOString(), 附带: { tasks: [], 完成计划: p.id } })).toMatchObject({ ok: true });
    expect(await prisma.followPlan.count({ where: { customerId: id } })).toBe(1);
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(true);
  });

  it("挑人时带回这位有没有 WhatsApp 号（记录跟进、新建计划的方式跟着它走）", async () => {
    await 外贸();
    const 有 = await 建客户("HasWa", {});
    const 没 = await 建客户("NoWa", { whatsapp: null, email: "buyer@nowa.example" });
    expect((await 取客户近况(有))?.有WhatsApp).toBe(true);
    expect((await 取客户近况(没))?.有WhatsApp).toBe(false);
  });

  it("「保存并完成」的撤销（2026-10-17）：删掉刚记的那笔和刚排的下一条，原计划回到待办，最近跟进跟着退回", async () => {
    await 外贸();
    const id = await 建客户("Undo", {});
    const p = await savePlan({ customerId: id, subject: "催定金", plannedAt: new Date().toISOString(), method: "WhatsApp" });
    if (!p.ok) throw new Error("建计划失败");
    const 别的 = await savePlan({ customerId: id, subject: "原来就有的另一条", plannedAt: new Date().toISOString(), method: "WhatsApp" });
    if (!别的.ok) throw new Error("建计划失败");
    const r = await saveFollowUp({
      customerId: id, type: "WHATSAPP", title: "", content: "催了，说下周付", status: "已完成", occurredAt: new Date().toISOString(),
      附带: { tasks: [], plan: { subject: 下次主题("催了，说下周付"), plannedAt: "2026-10-24", method: "WhatsApp" }, 完成计划: p.id },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.下次计划id).toBeTruthy();
    expect(await 撤销记一笔({ customerId: id, 跟进id: r.id, 计划id: p.id, 下次计划id: r.下次计划id })).toEqual({ ok: true });
    expect(await prisma.followUp.count({ where: { customerId: id } })).toBe(0);
    expect(await prisma.followPlan.findUnique({ where: { id: r.下次计划id! } })).toBeNull();
    expect(await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ done: false, doneAt: null });
    expect(await prisma.followPlan.findUnique({ where: { id: 别的.id } })).not.toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id } })).lastFollowAt).toBeNull();
    const 痕 = await prisma.auditLog.findMany({ where: { summary: { startsWith: "撤销" } }, select: { summary: true } });
    expect(痕.map((x) => x.summary)).toEqual(expect.arrayContaining([expect.stringContaining("撤销：删掉Undo刚记的一条WhatsApp跟进")]));
  });

  it("撤销：没排下一条的也行；下一条已经做完了（人在用它）就不删；别的客户名下的 id 不认", async () => {
    await 外贸();
    const id = await 建客户("Undo2", {});
    const 别人 = await 建客户("Other", {});
    const p = await savePlan({ customerId: id, subject: "回访", plannedAt: new Date().toISOString(), method: "电话沟通" });
    if (!p.ok) throw new Error("建计划失败");
    const r = await saveFollowUp({ customerId: id, type: "PHONE", content: "打过了", status: "已完成", occurredAt: new Date().toISOString(),
      附带: { tasks: [], plan: { subject: "接着跟进：打过了", plannedAt: "2026-10-24", method: "电话沟通" }, 完成计划: p.id } });
    if (!r.ok) throw new Error(r.error);
    // 别的客户名下：一条都不动
    expect(await 撤销记一笔({ customerId: 别人, 跟进id: r.id, 计划id: p.id, 下次计划id: r.下次计划id })).toMatchObject({ ok: false });
    expect(await prisma.followUp.count({ where: { customerId: id } })).toBe(1);
    // 下一条已经做完了：留着它，其余照撤
    await prisma.followPlan.update({ where: { id: r.下次计划id! }, data: { done: true, doneAt: new Date() } });
    expect(await 撤销记一笔({ customerId: id, 跟进id: r.id, 计划id: p.id, 下次计划id: r.下次计划id })).toEqual({ ok: true });
    expect(await prisma.followPlan.findUnique({ where: { id: r.下次计划id! } })).not.toBeNull();
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: p.id } })).done).toBe(false);
    expect(await prisma.followUp.count({ where: { customerId: id } })).toBe(0);
    // 没排下一条
    const q = await savePlan({ customerId: id, subject: "再回访", plannedAt: new Date().toISOString(), method: "电话沟通" });
    if (!q.ok) throw new Error("建计划失败");
    const r2 = await saveFollowUp({ customerId: id, type: "PHONE", content: "又打了", status: "已完成", occurredAt: new Date().toISOString(), 附带: { tasks: [], 完成计划: q.id } });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.下次计划id).toBeUndefined();
    expect(await 撤销记一笔({ customerId: id, 跟进id: r2.id, 计划id: q.id, 下次计划id: null })).toEqual({ ok: true });
    expect((await prisma.followPlan.findUniqueOrThrow({ where: { id: q.id } })).done).toBe(false);
  });
});
