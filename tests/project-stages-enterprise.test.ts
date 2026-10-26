/**
 * 企业版三大阶段节点状态机（10-26，lib/project/stage-dict.ts + nodes.ts + timeout.ts + db.ts 改节点 / 公海超时收回）。
 *   - 种子：对方三组阶段值，线索 5 / 商机 8 / 订单 7（含出口）；流程代码们 10-26 删了
 *   - 改名：丢单→商机丢单、赢单→商机赢单（只改叫法，库里结局值不动）；验收交付→交付验收（库里旧名照认）
 *   - 跨阶段单向：商机回不了线索、订单回不了商机（服务端拦）；同阶段里往后退随便、往前一步一步
 *   - 结局：线索只能流失或转商机，商机只能流失或赢单；订单的成功交付 / 异常状态照旧
 *   - 超时回收：没填天数的节点默认 7 天；改了天数新的回收日按新天数
 *   - 不是企业版（CRM_ENTERPRISE 不设）：全部照旧（团队版字典）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 公海超时收回, 超时预览 } from "@/lib/project/db";
import { 改节点问题, 下一步, 节点序号, 节点总数, 节点总数of } from "@/lib/project/nodes";
import { 企业版字典, 团队版字典, 字典of, 阶段值们, 结局叫法, 本套节点名 } from "@/lib/project/stage-dict";
import { 超时回收日, 节点超时天数 } from "@/lib/project/timeout";
import { 能配必填的节点 } from "@/lib/project/required";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { dayjs } from "@/lib/utils";
import { 记有效沟通 } from "./helpers/ent-valid-followup";

const 企 = 企业版字典;
const 在 = (phase: string, node: string, result: string | null = null) => ({ phase, node, result, balanceSettled: false, acceptancePassed: false });
const 开着 = (节点天数: Record<string, number>): 组织规则 => ({ ...默认组织规则, 超时回收: { 开: true, 节点天数 } });

describe("企业版字典：按对方阶段值做种子", () => {
  it("线索 5 / 商机 8 / 订单 7，含出口，值和对方表一致", () => {
    expect(阶段值们(企, "线索")).toEqual(["潜客培育", "线索验证", "线索推进", "已转商机", "线索流失"]);
    expect(阶段值们(企, "商机")).toEqual(["明确需求", "共识方案", "成交推进", "签约审批", "签订合同", "首款支付", "商机赢单", "商机丢单"]);
    expect(阶段值们(企, "订单")).toEqual(["生产备货", "物流运输", "安装实施", "交付验收", "尾款结算", "成功交付", "异常状态"]);
    expect([阶段值们(企, "线索").length, 阶段值们(企, "商机").length, 阶段值们(企, "订单").length]).toEqual([5, 8, 7]);
  });

  it("出口叫法：线索 已转商机 / 线索流失，商机 商机赢单 / 商机丢单；库里的结局值还是 丢单；流程代码们没了", () => {
    expect("流程代码们" in 企).toBe(false);
    expect(企.出口们.线索.map((o) => o.叫法)).toEqual(["已转商机", "线索流失"]);
    expect(企.出口们.商机.map((o) => o.叫法)).toEqual(["商机赢单", "商机丢单"]);
    expect(企.出口们.商机.map((o) => o.结局)).toEqual([null, "丢单"]);
    expect(企.出口们.订单.map((o) => o.叫法)).toEqual(["成功交付", "异常状态"]);
    expect(结局叫法("线索流失", 企)).toBe("线索流失");
    expect(结局叫法("丢单", 企)).toBe("商机丢单");
    expect(结局叫法("成功交付", 企)).toBe("成功交付");
  });

  it("后台改出口叫法（挡改设置）：只换叫法、不换结局值；没改的用字典里的", () => {
    const 改 = 字典of(true, { 商机: ["赢了", null], 线索: [null, "没戏"] });
    expect(改.出口们.商机.map((o) => [o.叫法, o.结局])).toEqual([["赢了", null], ["商机丢单", "丢单"]]);
    expect(改.出口们.线索.map((o) => [o.叫法, o.结局])).toEqual([["已转商机", null], ["没戏", "线索流失"]]);
    expect(结局叫法("线索流失", 改)).toBe("没戏");
    expect(改.节点们).toBe(企.节点们);
    expect(字典of(true, {})).toEqual(企);
    expect(字典of(false, { 商机: ["赢了", null] })).toBe(团队版字典);
  });

  it("团队版字典没动：验收交付、线索流失 / 丢单、跨阶段能退、没填天数不回收", () => {
    expect(团队版字典.节点们.订单).toContain("验收交付");
    expect(结局叫法("线索流失")).toBe("线索流失");
    expect(结局叫法("丢单")).toBe("丢单");
    expect(团队版字典.跨阶段能退).toBe(true);
    expect(团队版字典.默认超时天数).toBeNull();
    expect(字典of(false)).toBe(团队版字典);
    expect(字典of(true)).toBe(企);
    expect(节点总数of(企)).toBe(节点总数);
  });

  it("交付验收：节点序号、下一步按企业版字典；能配必填两套都认；建议清单的 验收交付 对到 交付验收", () => {
    expect(下一步({ phase: "订单", node: "安装实施" }, 企)).toEqual({ phase: "订单", node: "交付验收" });
    expect(下一步({ phase: "订单", node: "交付验收" }, 企)).toEqual({ phase: "订单", node: "尾款结算" });
    expect(节点序号({ phase: "订单", node: "交付验收" }, 企)).toBe(节点序号({ phase: "订单", node: "验收交付" }));
    expect(能配必填的节点).toEqual(expect.arrayContaining(["验收交付", "交付验收"]));
    expect(能配必填的节点).not.toContain("尾款结算");
    expect(本套节点名("验收交付", 企)).toBe("交付验收");
    expect(本套节点名("验收交付", 团队版字典)).toBe("验收交付");
  });
});

describe("跨阶段单向（改节点问题，企业版字典）", () => {
  it("商机回不了线索；团队版照旧能回", () => {
    expect(改节点问题({ phase: "线索", node: "线索推进" }, 在("商机", "明确需求"), undefined, true, 企)).toBe("项目已经进了商机阶段，不能退回线索阶段");
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 在("商机", "首款支付"), undefined, true, 企)).toMatch("不能退回线索阶段");
    // 商机流失后恢复也不能回线索
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 在("商机", "共识方案", "丢单"), undefined, true, 企)).toMatch("不能退回线索阶段");
    expect(改节点问题({ phase: "线索", node: "线索推进" }, 在("商机", "明确需求"))).toBeNull();
  });

  it("订单回不了商机、也回不了线索；异常状态恢复也一样", () => {
    expect(改节点问题({ phase: "商机", node: "首款支付" }, 在("订单", "生产备货"), undefined, true, 企)).toBe("项目已经进了订单阶段，不能退回商机阶段");
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 在("订单", "安装实施"), undefined, true, 企)).toMatch("不能退回线索阶段");
    expect(改节点问题({ phase: "商机", node: "签约审批" }, 在("订单", "物流运输", "异常状态"), undefined, true, 企)).toMatch("不能退回商机阶段");
    expect(改节点问题({ phase: "商机", node: "首款支付" }, 在("订单", "生产备货"))).toBeNull();
  });

  it("同阶段里往后退随便、往前一步可以、往前跳不行；跨到下一阶段第一个节点算一步", () => {
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 在("订单", "尾款结算"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "商机", node: "明确需求" }, 在("商机", "签订合同"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "线索", node: "潜客培育" }, 在("线索", "线索推进"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "商机", node: "签约审批" }, 在("商机", "明确需求"), undefined, true, 企)).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "订单", node: "交付验收" }, 在("订单", "安装实施"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "商机", node: "明确需求" }, 在("线索", "线索推进"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 在("商机", "首款支付"), undefined, true, 企)).toBeNull();
    // 团队版的 验收交付（库里的旧名）在企业版里按 交付验收 认
    expect(改节点问题({ phase: "订单", node: "验收交付" }, 在("订单", "安装实施"), undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "尾款结算" }, 在("订单", "验收交付"), undefined, true, 企)).toBeNull();
  });

  it("订单只能从商机进：线索直接跳订单、商机中间节点跳订单都不行", () => {
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 在("线索", "线索推进"), undefined, true, 企)).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 在("线索", "潜客培育"), undefined, true, 企)).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 在("商机", "签订合同"), undefined, true, 企)).toMatch("节点不能往前跳");
    expect(改节点问题({ phase: "订单", node: "物流运输" }, 在("商机", "首款支付"), undefined, true, 企)).toMatch("节点不能往前跳");
  });
});

describe("结局只有两条（企业版字典）", () => {
  const 原因 = { 备注: "联系不上" };

  it("线索：只能流失（线索流失）或转商机（进商机第一个节点）；丢单、成功交付、异常状态都不行", () => {
    const 线索推进 = 在("线索", "线索推进");
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "线索流失" }, 线索推进, 原因, true, 企)).toBeNull();
    expect(改节点问题({ phase: "商机", node: "明确需求" }, 线索推进, undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "丢单" }, 线索推进, 原因, true, 企)).toBe("「商机丢单」只能在商机阶段点");
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "成功交付" }, 线索推进, undefined, true, 企)).toMatch("只能在订单阶段点");
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "异常状态" }, 线索推进, { categoryId: "x" }, true, 企)).toMatch("只能在订单阶段点");
  });

  it("商机：只能流失（丢单）或赢单（进订单第一个节点）；线索流失、成功交付不行", () => {
    const 首款支付 = 在("商机", "首款支付");
    expect(改节点问题({ phase: "商机", node: "首款支付", result: "丢单" }, 首款支付, 原因, true, 企)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "生产备货" }, 首款支付, undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "线索", node: "线索推进", result: "线索流失" }, 首款支付, 原因, true, 企)).toMatch("不能退回线索阶段");
    expect(改节点问题({ phase: "商机", node: "首款支付", result: "线索流失" }, 首款支付, 原因, true, 企)).toBe("「线索流失」只能在线索阶段点");
    expect(改节点问题({ phase: "商机", node: "首款支付", result: "成功交付" }, 首款支付, undefined, true, 企)).toMatch("只能在订单阶段点");
  });

  it("订单的成功交付（两个勾）、异常状态（要类别）照旧", () => {
    expect(改节点问题({ phase: "订单", node: "尾款结算", result: "成功交付" }, 在("订单", "尾款结算"), undefined, true, 企)).toMatch("尾款结清");
    expect(改节点问题({ phase: "订单", node: "尾款结算", result: "成功交付" }, { ...在("订单", "尾款结算"), balanceSettled: true, acceptancePassed: true }, undefined, true, 企)).toBeNull();
    expect(改节点问题({ phase: "订单", node: "物流运输", result: "异常状态" }, 在("订单", "物流运输"), {}, true, 企)).toMatch("异常类别");
  });
});

describe("超时回收日：没填天数默认 7 天（企业版字典）", () => {
  const 起 = "2026-10-01T10:00:00";

  it("没填的节点按 7 天；团队版字典没填不回收", () => {
    expect(节点超时天数(开着({}), "线索验证", 企)).toBe(7);
    expect(超时回收日(开着({}), { phase: "线索", node: "线索验证" }, 起, 企)).toBe("2026-10-08");
    expect(超时回收日(开着({}), { phase: "商机", node: "签约审批" }, 起, 企)).toBe("2026-10-08");
    expect(超时回收日(开着({}), { phase: "线索", node: "线索验证" }, 起)).toBeNull();
    expect(节点超时天数(开着({}), "线索验证")).toBeNull();
  });

  it("设了按设的；改了天数，新的回收日按新天数", () => {
    expect(超时回收日(开着({ 线索验证: 3 }), { phase: "线索", node: "线索验证" }, 起, 企)).toBe("2026-10-04");
    expect(超时回收日(开着({ 线索验证: 10 }), { phase: "线索", node: "线索验证" }, 起, 企)).toBe("2026-10-11");
    // 只改了别的节点：这个节点还是默认 7 天
    expect(超时回收日(开着({ 潜客培育: 2 }), { phase: "线索", node: "线索验证" }, 起, 企)).toBe("2026-10-08");
  });

  it("超时回收没开、订单阶段、有结局、在公海：默认 7 天也不收", () => {
    expect(超时回收日(默认组织规则, { phase: "线索", node: "线索验证" }, 起, 企)).toBeNull();
    expect(超时回收日(开着({}), { phase: "订单", node: "生产备货" }, 起, 企)).toBeNull();
    expect(超时回收日(开着({}), { phase: "线索", node: "线索验证", result: "线索流失" }, 起, 企)).toBeNull();
    expect(超时回收日(开着({}), { phase: "线索", node: "线索验证", pooledAt: new Date() }, 起, 企)).toBeNull();
  });
});

describe("读写库（CRM_ENTERPRISE 开 / 关）", () => {
  let 老板: { id: string; name: string; role: string };
  let 乙: { id: string; name: string; role: string };
  let 客户: string;

  async function 人(email: string, role: string) {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, name: u.name, role };
  }
  async function 项目(补: Record<string, unknown> = {}) {
    return prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙.id, creatorId: 乙.id, ...补 } });
  }
  const 天后 = (n: number) => dayjs().add(n, "day").toDate();
  const 现 = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    老板 = await 人("boss", "ADMIN");
    乙 = await 人("yi", "SALES");
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "13800000001", salesOwnerId: 乙.id } })).id;
    vi.stubEnv("CRM_ENTERPRISE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("企业版：商机改回线索被拦、不记节点变更；同阶段往后退能改", async () => {
    const p = await 项目({ phase: "商机", node: "共识方案" });
    expect(await 改节点(老板, p.id, { phase: "线索", node: "线索推进" })).toEqual({ ok: false, error: "项目已经进了商机阶段，不能退回线索阶段" });
    expect(await prisma.projectNodeLog.count()).toBe(0);
    expect(await 改节点(乙, p.id, { phase: "商机", node: "明确需求" })).toMatchObject({ ok: true, 变了: true });
    expect(await 改节点(乙, p.id, { phase: "商机", node: "共识方案" })).toMatchObject({ ok: true, 变了: true });
    expect(await 现(p.id)).toMatchObject({ phase: "商机", node: "共识方案" });
  });

  it("企业版：订单改回商机被拦（老板也不行）；线索走到商机、商机走到订单照常", async () => {
    const q = await 项目({ phase: "订单", node: "物流运输" });
    expect(await 改节点(老板, q.id, { phase: "商机", node: "首款支付" })).toMatchObject({ ok: false, error: expect.stringContaining("不能退回商机阶段") });
    expect(await 现(q.id)).toMatchObject({ phase: "订单", node: "物流运输" });

    const p = await 项目({ node: "线索推进" });
    await 记有效沟通(p.id);
    expect(await 改节点(乙, p.id, { phase: "商机", node: "明确需求" })).toMatchObject({ ok: true });
    const r = await 项目({ phase: "商机", node: "首款支付" });
    expect(await 改节点(乙, r.id, { phase: "订单", node: "生产备货" })).toMatchObject({ ok: true });
  });

  it("企业版：线索阶段点丢单被拦，点线索流失（写原因）能点", async () => {
    const p = await 项目({ node: "线索验证" });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证", result: "丢单" }, { 备注: "不要了" })).toMatchObject({ ok: false, error: "「商机丢单」只能在商机阶段点" });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索验证", result: "线索流失" }, { 备注: "不要了" })).toMatchObject({ ok: true });
    expect(await 现(p.id)).toMatchObject({ result: "线索流失" });
  });

  it("开关关着：商机能改回线索、订单能改回商机（和原来一样）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    const p = await 项目({ phase: "商机", node: "共识方案" });
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true, 变了: true });
    const q = await 项目({ phase: "订单", node: "验收交付" });
    expect(await 改节点(乙, q.id, { phase: "商机", node: "首款支付" })).toMatchObject({ ok: true, 变了: true });
  });

  it("企业版超时回收：一个节点都没填天数，过了 7 天就收、没到 7 天不收", async () => {
    await setSetting("orgRules", 开着({}));
    const 超 = await 项目({ node: "线索验证", createdAt: 天后(-8) });
    const 没到 = await 项目({ phase: "商机", node: "签约审批", createdAt: 天后(-6) });
    const 订单 = await 项目({ phase: "订单", node: "生产备货", createdAt: 天后(-30) });
    expect(await 超时预览(开着({}), new Date())).toBe(1);
    expect(await 公海超时收回(老板, new Date())).toBe(1);
    expect((await 现(超.id)).pooledAt).not.toBeNull();
    expect((await 现(没到.id)).pooledAt).toBeNull();
    expect((await 现(订单.id)).pooledAt).toBeNull();
  });

  it("企业版超时回收：设置里把天数改长了，按新天数，原来 7 天会收的不收", async () => {
    await setSetting("orgRules", 开着({ 线索验证: 10 }));
    const p = await 项目({ node: "线索验证", createdAt: 天后(-8) });
    expect(await 超时预览(开着({ 线索验证: 10 }), new Date())).toBe(0);
    expect(await 超时预览(开着({}), new Date())).toBe(1);
    expect(await 公海超时收回(老板, new Date())).toBe(0);
    expect((await 现(p.id)).pooledAt).toBeNull();
    expect(await 公海超时收回(老板, 天后(3))).toBe(1);
  });

  it("开关关着：Setting 里超时回收开着、没填天数，也不收（团队版没有默认天数）", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    await setSetting("orgRules", 开着({}));
    await 项目({ node: "线索验证", createdAt: 天后(-30) });
    expect(await 公海超时收回(老板, new Date())).toBe(0);
    expect(await prisma.project.count({ where: { pooledAt: { not: null } } })).toBe(0);
  });
});
