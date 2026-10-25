/**
 * 企业版节点必填 + 自动推进（D-37，lib/project/required.ts + lib/project/db.ts 按必填推进）。
 *   - 填齐了自动往前推一步、留一行节点变更（理由写自动推进）；下一个节点也齐了接着推
 *   - 没齐照样能保存，只是不推；退回来的节点不自动推
 *   - 配了必填的节点，销售手动往前推被拦（列还差）；老板、主管能推；往后退照旧
 *   - 客户那边补了资料：客户名下停在配了节点上的项目跟着推
 *   - 不是企业版 / 没开：和原来一样
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 改节点, 改项目, 记项目沟通, 勾交付, 客户项目按必填推进, 自动推进理由 } from "@/lib/project/db";
import { 默认组织规则, type 组织规则 } from "@/lib/project/org-rules";
import { setSetting, invalidateSettingsCache } from "@/lib/settings";
import { dayjs } from "@/lib/utils";

const 开着 = (必填: Record<string, string[]>): 组织规则 => ({ ...默认组织规则, 节点推进: { 开: true, 必填 } });
const 现在 = () => dayjs().format("YYYY-MM-DD HH:mm");


/** 存成了、没自动推进：返回里不带 自动推到（和原来一模一样） */
function 没推(r: object) {
  expect(r).toMatchObject({ ok: true });
  expect(r).not.toHaveProperty("自动推到");
}

describe("节点必填自动推进", () => {
  let 老板: { id: string; role: string };
  let 乙: { id: string; role: string };
  let 客户: string;

  async function 人(email: string, role: string) {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, role };
  }
  async function 项目(补: Record<string, unknown> = {}) {
    return prisma.project.create({ data: { name: "一号项目", customerId: 客户, ownerId: 乙.id, creatorId: 乙.id, ...补 } });
  }
  const 现 = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    老板 = await 人("boss", "ADMIN");
    乙 = await 人("yi", "SALES");
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "", salesOwnerId: 乙.id } })).id;
    vi.stubEnv("CRM_ENTERPRISE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("改项目填齐了：自动推一步，留一行节点变更，操作人是保存的人", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: ["金额", "需求"] }));
    const p = await 项目();
    const 半 = await 改项目(乙, p.id, { name: "一号项目", amount: 100 });
    没推(半);
    expect((await 现(p.id)).node).toBe("潜客培育");

    const r = await 改项目(乙, p.id, { name: "一号项目", amount: 100, remark: "要 200 台" });
    expect(r).toMatchObject({ ok: true, 自动推到: ["线索验证"] });
    expect(await 现(p.id)).toMatchObject({ phase: "线索", node: "线索验证" });
    const log = await prisma.projectNodeLog.findFirstOrThrow({ where: { projectId: p.id, reason: 自动推进理由 } });
    expect(log).toMatchObject({ kind: "node", userId: 乙.id, fromNode: "潜客培育", toNode: "线索验证", toResult: null });
  });

  it("下一个节点也配了、也齐了：接着推，跨阶段也一步一步走", async () => {
    await setSetting("orgRules", 开着({ 线索验证: ["金额"], 线索推进: ["金额"], 明确需求: ["主联系人"] }));
    const p = await 项目({ node: "线索验证" });
    const r = await 改项目(乙, p.id, { name: "一号项目", amount: 5 });
    expect(r).toMatchObject({ ok: true, 自动推到: ["线索推进", "明确需求"] });
    expect(await 现(p.id)).toMatchObject({ phase: "商机", node: "明确需求" });
    expect(await prisma.projectNodeLog.count({ where: { projectId: p.id, reason: 自动推进理由 } })).toBe(2);
  });

  it("记沟通：本节点沟通 + 下一步时间齐了就推；勾交付：验收通过", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: ["本节点沟通", "下一步时间"], 验收交付: ["验收通过"] }));
    const p = await 项目();
    const r = await 记项目沟通(乙, p.id, { type: "PHONE", content: "聊了", occurredAt: 现在(), 下一步时间: dayjs().add(2, "day").format("YYYY-MM-DD") });
    expect(r).toMatchObject({ ok: true, 自动推到: ["线索验证"] });

    const q = await 项目({ phase: "订单", node: "验收交付" });
    expect(await 勾交付(乙, q.id, "acceptancePassed", true)).toMatchObject({ ok: true, 自动推到: ["尾款结算"] });
  });

  it("联系方式：客户的电话、外贸字段、联系人上的任一都算", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: ["联系方式"] }));
    const p = await 项目();
    expect(await 客户项目按必填推进(乙, 客户)).toEqual([]);
    await prisma.contact.create({ data: { name: "张三", customerId: 客户, wechat: "zs" } });
    expect(await 客户项目按必填推进(乙, 客户)).toEqual([{ id: p.id, name: "一号项目", 到: ["线索验证"] }]);
  });

  it("客户资料齐了：客户名下停在配了节点上的项目推；在公海的、有结局的、没配节点的不动", async () => {
    await setSetting("orgRules", 开着({ 潜客培育: ["国家", "来源"] }));
    const 推 = await 项目();
    const 公海 = await 项目({ pooledAt: new Date() });
    const 结局 = await 项目({ result: "线索流失" });
    const 没配 = await 项目({ node: "线索验证" });
    await prisma.customerExtra.create({ data: { customerId: 客户, country: "德国", source: "展会" } });
    const r = await 客户项目按必填推进(乙, 客户);
    expect(r.map((x) => x.id)).toEqual([推.id]);
    expect((await 现(推.id)).node).toBe("线索验证");
    for (const q of [公海, 结局]) expect((await 现(q.id)).node).toBe("潜客培育");
    expect((await 现(没配.id)).node).toBe("线索验证");
  });

  it("退回来的节点不自动推；老板再往前推过去之后照常", async () => {
    await setSetting("orgRules", 开着({ 线索验证: ["金额"] }));
    const p = await 项目({ node: "线索推进", amount: 0 });
    没推(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" }));
    没推(await 改项目(乙, p.id, { name: "一号项目", amount: 9 }));
    expect((await 现(p.id)).node).toBe("线索验证");

    // 老板手动往前推进来的节点齐了：接着推
    const q = await 项目({ amount: 9 });
    expect(await 改节点(老板, q.id, { phase: "线索", node: "线索验证" })).toMatchObject({ ok: true, 自动推到: ["线索推进"] });
  });

  it("配了必填的节点：销售手动往前推被拦并列还差；老板、主管能推；往后退照旧", async () => {
    await setSetting("orgRules", 开着({ 线索验证: ["金额", "国家"] }));
    const p = await 项目({ node: "线索验证" });
    const r = await 改节点(乙, p.id, { phase: "线索", node: "线索推进" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("还差：金额、国家");
    expect(await 改节点(乙, p.id, { phase: "线索", node: "潜客培育" })).toMatchObject({ ok: true });
    没推(await 改节点(老板, p.id, { phase: "线索", node: "线索验证" }));
    const 主管 = await 人("mgr", "MANAGER");
    expect(await 改节点(主管, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
    // 结局不算往前，照旧能点
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进", result: "线索流失" }, { 备注: "联系不上" })).toMatchObject({ ok: true });
  });

  it("没配的节点：销售照样手动推，不自动推", async () => {
    await setSetting("orgRules", 开着({ 明确需求: ["金额"] }));
    const p = await 项目({ amount: 9 });
    没推(await 改项目(乙, p.id, { name: "一号项目", amount: 10 }));
    没推(await 改节点(乙, p.id, { phase: "线索", node: "线索验证" }));
  });

  it("没开 / 不是企业版：和原来一样，Setting 里配着也不推、不拦", async () => {
    await setSetting("orgRules", { ...开着({ 线索验证: ["金额"] }), 节点推进: { 开: false, 必填: { 线索验证: ["金额"] } } });
    const p = await 项目({ node: "线索验证" });
    没推(await 改项目(乙, p.id, { name: "一号项目", amount: 10 }));

    invalidateSettingsCache();
    vi.stubEnv("CRM_ENTERPRISE", "");
    await setSetting("orgRules", 开着({ 线索验证: ["金额"] }));
    没推(await 改项目(乙, p.id, { name: "一号项目", amount: 11 }));
    expect(await 客户项目按必填推进(乙, 客户)).toEqual([]);
    expect(await 改节点(乙, p.id, { phase: "线索", node: "线索推进" })).toMatchObject({ ok: true });
  });
});
