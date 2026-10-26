/**
 * 企业版卡点（2026-10-26）：
 *   - 从一条项目沟通发布 → 指认 → 接受 → 转让（必须选人）→ 返回（必须写理由）→ 认领 → 解决，每步一行流转：谁、从谁到谁、理由
 *   - 沟通记录编号 FUL+日期+6 位、卡点编号 BLK+日期+3 位，当天顺着往下排（组员发的也不撞号）
 *   - E11：无关的人（销售、别组的主管）拿不到、按 id 直接点也是「不在了」；虚线上级、隔级上级只能看；直属上级能管
 *   - 离职交接：手上的卡点给接手人待接受；项目进公海的回看板
 *   - 不是企业版：发不了、一行不写，沟通也不记编号
 *   - 时限提醒：没到 → 步步为营；过了 3 天以内 → 卡点大师；再久 → 超出时限
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/sync/client", () => ({ 读团队: () => null }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 记项目沟通 } from "@/lib/project/db";
import {
  发布卡点, 指认卡点, 认领卡点, 接受卡点, 转让卡点, 返回卡点, 改卡点进度, 解决卡点, 交接卡点, 项目的卡点, 我的卡点, 卡点可选的人,
  存卡点默认, 读卡点默认, 离职交接理由, 能发卡点,
} from "@/lib/project/blocker";
import { 沟通编号们 } from "@/lib/project/followup-meta";
import { 时限提醒of, 编号日, 规整发布, 默认卡点默认 } from "@/lib/project/blocker-rules";
import { invalidateSettingsCache, setSetting } from "@/lib/settings";

type 人 = { id: string; role: string };
const 天 = 24 * 3600_000;

describe("企业版卡点", () => {
  let 老板: 人, 经理: 人, 组长: 人, 虚: 人, 销售: 人, 组员: 人, 散: 人, 散主管: 人;
  let 客户: string, 项目: string;
  const now = new Date();
  const 今天 = now.toISOString().slice(0, 10);

  async function 建(email: string, role: string): Promise<人> {
    const u = await prisma.user.create({ data: { email, name: email, title: "", role, password: "x" } });
    return { id: u.id, role };
  }
  async function 沟通(me: 人 = 销售, pid = 项目) {
    const r = await 记项目沟通(me, pid, { type: "PHONE", content: "客户说预算要等下月", occurredAt: 今天, 下一步时间: 今天 }, now);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.followUpId!;
  }
  const 卡 = { obstacle: "价格", description: "报价比竞品高一成" };
  async function 发(me: 人 = 销售, assignee?: string | null) {
    const r = await 发布卡点(me, await 沟通(), 卡, assignee ?? null, now);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r as { ok: true; id: string; code: string; projectId: string };
  }
  const 流转 = (blockerId: string) => prisma.entBlockerLog.findMany({ where: { blockerId }, orderBy: { at: "asc" } });

  beforeEach(async () => {
    await resetDb();
    invalidateSettingsCache();
    老板 = await 建("boss", "ADMIN");
    经理 = await 建("mgr", "MANAGER");
    组长 = await 建("lead", "MANAGER");
    虚 = await 建("dotted", "MANAGER");
    销售 = await 建("sales", "SALES");
    组员 = await 建("member", "SALES");
    散 = await 建("loose", "SALES");
    散主管 = await 建("loose-mgr", "MANAGER");
    await prisma.entMember.createMany({
      data: [
        { userId: 经理.id, bizRole: "sales_mgr" },
        { userId: 组长.id, bizRole: "sales_mgr", managerId: 经理.id },
        { userId: 虚.id, bizRole: "sales_mgr" },
        { userId: 销售.id, managerId: 组长.id, dottedManagerId: 虚.id },
        { userId: 组员.id, managerId: 组长.id },
        { userId: 散主管.id, bizRole: "sales_mgr" },
        { userId: 散.id, managerId: 散主管.id },
      ],
    });
    客户 = (await prisma.customer.create({ data: { name: "客户甲", phone: "", salesOwnerId: 销售.id } })).id;
    项目 = (await prisma.project.create({ data: { name: "项目", customerId: 客户, ownerId: 销售.id, creatorId: 销售.id } })).id;
    await prisma.projectMember.create({ data: { projectId: 项目, userId: 组员.id, inviteStatus: "JOINED" } });
    vi.stubEnv("CRM_ENTERPRISE", "1");
    await setSetting("enterprise.rule.org_scope", true);
    invalidateSettingsCache();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("整条链：发布 → 指认 → 接受 → 转让 → 返回 → 认领 → 解决，每步记谁、从谁到谁", async () => {
    const b = await 发();
    let row = await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ status: "看板", assigneeId: null, creatorId: 销售.id, type: "中度卡点", impact: "短期不影响", dueDays: 3, projectId: 项目 });
    expect(row.dueAt.getTime() - now.getTime()).toBe(3 * 天);

    expect(await 指认卡点(销售, b.id, 组员.id)).toMatchObject({ ok: true, code: b.code });
    expect((await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("待接受");
    // 不是经手人不能替他接受
    expect(await 接受卡点(销售, b.id)).toMatchObject({ ok: false });
    expect(await 接受卡点(组员, b.id)).toMatchObject({ ok: true });

    // 转让必须选人、不能给自己、只能给项目上的人
    expect(await 转让卡点(组员, b.id, "")).toMatchObject({ ok: false, error: "转让要选一位接手的人" });
    expect(await 转让卡点(组员, b.id, 组员.id)).toMatchObject({ ok: false, error: "不能转让给自己" });
    expect(await 转让卡点(组员, b.id, 散.id)).toMatchObject({ ok: false });
    expect(await 转让卡点(组员, b.id, 销售.id, "价格得负责人去谈")).toMatchObject({ ok: true });
    row = await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ status: "待接受", assigneeId: 销售.id });

    // 返回必须写理由
    expect(await 返回卡点(销售, b.id, "  ")).toMatchObject({ ok: false, error: "返回看板要写一句理由" });
    expect(await 返回卡点(销售, b.id, "x".repeat(201))).toMatchObject({ ok: false });
    expect(await 返回卡点(销售, b.id, "先放看板，谁有空谁接")).toMatchObject({ ok: true });
    row = await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ status: "看板", assigneeId: null });

    expect(await 认领卡点(组员, b.id)).toMatchObject({ ok: true });
    expect(await 认领卡点(销售, b.id)).toMatchObject({ ok: false, error: "这个卡点已经有人接了，刷新看看" });
    expect(await 改卡点进度(组员, b.id, { progress: "约了周三再谈" })).toMatchObject({ ok: true });
    expect(await 解决卡点(组员, b.id, { solution: "给了九五折" })).toMatchObject({ ok: false, error: "解决结果要填" });
    expect(await 解决卡点(组员, b.id, { solution: "给了九五折", result: "客户同意签" }, now)).toMatchObject({ ok: true });
    row = await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ status: "已解决", solution: "给了九五折", result: "客户同意签" });
    expect(row.resolvedAt?.getTime()).toBe(now.getTime());
    expect(await 改卡点进度(组员, b.id, { progress: "再改" })).toMatchObject({ ok: false, error: "这个卡点已经解决了" });

    const logs = await 流转(b.id);
    expect(logs.map((l) => [l.action, l.userId, l.fromUserId, l.toUserId, l.note])).toEqual([
      ["publish", 销售.id, null, null, null],
      ["assign", 销售.id, null, 组员.id, null],
      ["accept", 组员.id, null, null, null],
      ["transfer", 组员.id, 组员.id, 销售.id, "价格得负责人去谈"],
      ["return", 销售.id, 销售.id, null, "先放看板，谁有空谁接"],
      ["claim", 组员.id, null, 组员.id, null],
      ["progress", 组员.id, null, null, "约了周三再谈"],
      ["resolve", 组员.id, null, null, null],
    ]);

    // 界面拿到的流转带名字
    const [视图] = await 项目的卡点(销售, 项目);
    expect(视图.流转.find((l) => l.action === "transfer")).toMatchObject({ 谁: "member", 从: "member", 到: "sales" });
  });

  it("发布时指认：给别人 → 待接受，给自己 → 处理中；只能指认项目上的人", async () => {
    const 给组员 = await 发(销售, 组员.id);
    expect((await prisma.entBlocker.findUniqueOrThrow({ where: { id: 给组员.id } })).status).toBe("待接受");
    const 给自己 = await 发(销售, 销售.id);
    expect((await prisma.entBlocker.findUniqueOrThrow({ where: { id: 给自己.id } })).status).toBe("处理中");
    const r = await 发布卡点(销售, await 沟通(), 卡, 散.id, now);
    expect(r).toMatchObject({ ok: false });
    // 组员也能发
    expect((await 发布卡点(组员, await 沟通(), 卡, null, now)).ok).toBe(true);
  });

  it("发布要从项目沟通来、阻碍主体和描述必填", async () => {
    const fu = await 沟通();
    expect(await 发布卡点(销售, "没有这条", 卡, null, now)).toMatchObject({ ok: false });
    expect(await 发布卡点(销售, fu, { description: "x" }, null, now)).toMatchObject({ ok: false, error: "选一个阻碍主体" });
    expect(await 发布卡点(销售, fu, { obstacle: "天气", description: "x" }, null, now)).toMatchObject({ ok: false });
    expect(await 发布卡点(销售, fu, { obstacle: "价格" }, null, now)).toMatchObject({ ok: false, error: "写一句卡在哪" });
    expect(await 发布卡点(销售, fu, { ...卡, type: "重要卡点" }, null, now)).toMatchObject({ ok: true });
    expect((await prisma.entBlocker.findFirstOrThrow()).dueDays).toBe(1);
  });

  it("编号：FUL+日期+6 位、BLK+日期+3 位，当天往下排", async () => {
    const 日 = 编号日(now);
    const a = await 发();
    const b = await 发(组员);
    expect(a.code).toBe(`BLK${日}001`);
    expect(b.code).toBe(`BLK${日}002`);
    const metas = await prisma.entFollowUpMeta.findMany({ orderBy: { code: "asc" } });
    expect(metas.map((m) => m.code)).toEqual([`FUL${日}000001`, `FUL${日}000002`]);
    expect(metas.every((m) => m.projectId === 项目 && m.nextAt !== null)).toBe(true);
  });

  describe("E11 谁看得到", () => {
    it("无关的销售、别组的主管：项目卡点拿空、按 id 直接点都是「不在了」", async () => {
      const b = await 发();
      for (const 外人 of [散, 散主管]) {
        expect(await 项目的卡点(外人, 项目)).toEqual([]);
        expect(await 我的卡点(外人)).toEqual([]);
        expect(await 卡点可选的人(外人, 项目)).toEqual([]);
        expect(await 能发卡点(外人, 项目)).toBe(false);
        for (const r of [
          await 指认卡点(外人, b.id, 组员.id), await 认领卡点(外人, b.id), await 接受卡点(外人, b.id),
          await 转让卡点(外人, b.id, 组员.id), await 返回卡点(外人, b.id, "理由"), await 改卡点进度(外人, b.id, { progress: "x" }),
          await 解决卡点(外人, b.id, { solution: "x", result: "y" }),
        ]) expect(r).toMatchObject({ ok: false, error: "这个卡点已经不在了，刷新看看" });
        expect(await 发布卡点(外人, (await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } })).followUpId, 卡, null, now)).toMatchObject({ ok: false });
      }
      expect(await prisma.entBlocker.count()).toBe(1);
      expect(await 流转(b.id)).toHaveLength(1);
      // 「发卡点」按钮和发布同一个口径
      expect(await 能发卡点(销售, 项目)).toBe(true);
    });

    it("虚线上级、隔级上级：看得到、不能指认也不能改进度", async () => {
      const b = await 发();
      for (const 上级 of [虚, 经理]) {
        const 们 = await 项目的卡点(上级, 项目);
        expect(们.map((x) => x.id)).toEqual([b.id]);
        expect(们[0].能).toMatchObject({ 指认: false, 认领: false, 改进度: false });
        expect(await 能发卡点(上级, 项目)).toBe(false);
        expect(await 指认卡点(上级, b.id, 组员.id)).toMatchObject({ ok: false, error: "只有项目负责人、发布人、上级或老板能指认" });
        expect(await 改卡点进度(上级, b.id, { progress: "x" })).toMatchObject({ ok: false });
        expect(await 发布卡点(上级, (await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } })).followUpId, 卡, null, now)).toMatchObject({ ok: false });
      }
    });

    it("直属上级、老板能管：指认、改进度", async () => {
      const b1 = await 发();
      const b2 = await 发();
      expect(await 指认卡点(组长, b1.id, 组员.id)).toMatchObject({ ok: true });
      expect(await 改卡点进度(组长, b1.id, { resourceRequest: "要一位售前" })).toMatchObject({ ok: true });
      expect(await 指认卡点(老板, b2.id, 销售.id)).toMatchObject({ ok: true });
      expect((await 项目的卡点(组长, 项目))[0].能.改进度).toBe(true);
    });

    it("只是经手人（后来退出了项目组）：只拿自己那条", async () => {
      const b = await 发(销售, 组员.id);
      await 发();
      await prisma.projectMember.deleteMany({ where: { userId: 组员.id } });
      expect((await 项目的卡点(组员, 项目)).map((x) => x.id)).toEqual([b.id]);
    });

    it("我的卡点：指给我的 + 我项目上看板里没人接的", async () => {
      const 给组员 = await 发(销售, 组员.id);
      const 看板 = await 发();
      await 发(销售, 销售.id);
      expect((await 我的卡点(组员)).map((x) => x.id).sort()).toEqual([给组员.id, 看板.id].sort());
    });
  });

  it("离职交接：没进公海的给接手人待接受，进公海的回看板，都记一行", async () => {
    const 项目乙 = (await prisma.project.create({ data: { name: "项目乙", customerId: 客户, ownerId: 销售.id, creatorId: 销售.id } })).id;
    await prisma.projectMember.create({ data: { projectId: 项目乙, userId: 组员.id, inviteStatus: "JOINED" } });
    const 甲 = await 发(销售, 组员.id);
    const 乙 = await 发布卡点(销售, await 沟通(销售, 项目乙), 卡, 组员.id, now);
    expect(乙.ok).toBe(true);
    const 乙id = (乙 as { id: string }).id;
    const n = await prisma.$transaction((tx) => 交接卡点(tx, 组员.id, 组长.id, 老板.id, [项目乙]));
    expect(n).toBe(2);
    expect(await prisma.entBlocker.findUniqueOrThrow({ where: { id: 甲.id } })).toMatchObject({ status: "待接受", assigneeId: 组长.id });
    expect(await prisma.entBlocker.findUniqueOrThrow({ where: { id: 乙id } })).toMatchObject({ status: "看板", assigneeId: null });
    const 甲log = (await 流转(甲.id)).at(-1)!;
    expect(甲log).toMatchObject({ action: "handover", userId: 老板.id, fromUserId: 组员.id, toUserId: 组长.id, note: 离职交接理由 });
    expect((await 流转(乙id)).at(-1)).toMatchObject({ action: "handover", fromUserId: 组员.id, toUserId: null });
  });

  it("卡点默认：管理员能改，坏值报错；发布按新默认", async () => {
    expect(await 存卡点默认(老板, { 时限天数: { 中度卡点: 0 } })).toMatchObject({ ok: false });
    expect(await 存卡点默认(老板, { 阻碍主体们: [] })).toMatchObject({ ok: false });
    expect(await 存卡点默认(老板, { 时限天数: { 中度卡点: 5 }, 阻碍主体们: ["价格", "资质"] })).toMatchObject({ ok: true });
    invalidateSettingsCache();
    expect((await 读卡点默认()).阻碍主体们).toEqual(["价格", "资质"]);
    const b = await 发();
    expect((await prisma.entBlocker.findUniqueOrThrow({ where: { id: b.id } })).dueDays).toBe(5);
    expect(await 存卡点默认(散, { 默认类型: "轻度卡点" })).toMatchObject({ ok: false });
  });

  it("不是企业版：发不了、一行不写，沟通不记编号", async () => {
    vi.stubEnv("CRM_ENTERPRISE", "");
    invalidateSettingsCache();
    const fu = await 沟通();
    expect(await 发布卡点(销售, fu, 卡, null, now)).toMatchObject({ ok: false, error: "卡点是企业版的功能" });
    expect(await prisma.entBlocker.count()).toBe(0);
    expect(await prisma.entFollowUpMeta.count()).toBe(0);
    expect(await 项目的卡点(老板, 项目)).toEqual([]);
    expect(await 我的卡点(销售)).toEqual([]);
    // 页面上的入口全空：项目详情不出「发卡点」、没有编号，列表页没有「我的卡点」
    expect(await 能发卡点(老板, 项目)).toBe(false);
    expect(await 卡点可选的人(老板, 项目)).toEqual([]);
    expect((await 沟通编号们([fu])).size).toBe(0);
    expect(await 存卡点默认(老板, { 默认类型: "轻度卡点" })).toMatchObject({ ok: false });
    expect(await prisma.$transaction((tx) => 交接卡点(tx, 销售.id, 组长.id, 老板.id, []))).toBe(0);
  });
});

describe("卡点规矩", () => {
  it("时限提醒按下一步时间：没填 / 没到 → 步步为营；过了 3 天内 → 卡点大师；再久 → 超出时限", () => {
    const t = new Date("2026-10-26T10:00:00Z");
    expect(时限提醒of(null, t).文字).toBe("步步为营 指定能赢");
    expect(时限提醒of(new Date(t.getTime() + 天), t).级别).toBe("稳");
    expect(时限提醒of(new Date(t.getTime() - 天), t)).toEqual({ 级别: "拿捏", 文字: "卡点大师 节奏拿捏" });
    expect(时限提醒of(new Date(t.getTime() - 3 * 天), t).级别).toBe("拿捏");
    expect(时限提醒of(new Date(t.getTime() - 3 * 天 - 1), t)).toEqual({ 级别: "超时", 文字: "超出时限 必须调整" });
  });

  it("规整发布：没填类型按默认、时限按类型", () => {
    expect(规整发布({ obstacle: "客户", description: "x" }, 默认卡点默认)).toMatchObject({ type: "中度卡点", dueDays: 3 });
    expect(规整发布({ obstacle: "客户", description: "x", type: "轻度卡点", dueDays: "10" }, 默认卡点默认)).toMatchObject({ dueDays: 10 });
    expect(规整发布({ obstacle: "客户", description: "x", dueDays: 366 }, 默认卡点默认)).toHaveProperty("error");
  });
});
