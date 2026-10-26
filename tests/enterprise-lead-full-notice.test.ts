/**
 * 企业版自动分配「都已满额」提醒（A8，重走 7.6 / Y22）。
 * 钉的是：自动分配因都满额没分出去，给市场管理、总管理员（含没建组织行的老板）各发一条站内提醒；
 * 一次点击（单条或批量）只发一条、列出没分出去的线索；有人接、或者是别的原因没分出去不发；
 * 各人关各人的，关了别人的照样在；不是企业版不读。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "", email: "a@x", role: "ADMIN", title: "", avatar: null },
  企业版: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));
vi.mock("@/lib/enterprise/switch", () => ({ 企业版: () => mocks.企业版 }));
vi.mock("@/lib/shared-ws/current", () => ({ 当前是共享区: async () => false }));

import { prisma } from "@/lib/prisma";
import { setSetting } from "@/lib/settings";
import { resetDb } from "./reset";
import { 自动分配线索, 批量自动分配, 我的满额提醒, 关满额提醒 } from "@/app/(app)/leads/assign-actions";
import { 读满额提醒, 发满额提醒 } from "@/lib/enterprise/lead-full-notice";
import { 读组织 } from "@/lib/enterprise/org";
import { 规则 } from "@/lib/enterprise/rules";

let 老板: string, 总管: string, 市场: string, 销售经理: string, 甲: string, 乙: string;

const 名字 = new Map<string, string>();
const 当 = (id: string, role = "SALES") => { mocks.user = { ...mocks.user, id, role, name: 名字.get(id) ?? "" }; };
const 建线索 = async (name: string) => (await prisma.lead.create({ data: { name, ownerId: 市场 } })).id;
const 配 = (userId: string, quota: number) => prisma.entLeadQuota.upsert({ where: { userId }, create: { userId, quota, setById: 老板 }, update: { quota } });

beforeEach(async () => {
  await resetDb();
  mocks.企业版 = true;
  const 人 = async (email: string, name: string, role = "SALES") => {
    const id = (await prisma.user.create({ data: { email, name, title: "", role, password: "x" } })).id;
    名字.set(id, name);
    return id;
  };
  老板 = await 人("boss", "老板", "ADMIN");
  总管 = await 人("dir", "总管");
  市场 = await 人("mkt", "市场小李");
  销售经理 = await 人("smgr", "销售经理");
  甲 = await 人("a", "销售甲");
  乙 = await 人("b", "销售乙");
  await prisma.entMember.createMany({
    data: [
      { userId: 总管, bizRole: "director" },
      { userId: 市场, bizRole: "marketing_mgr" },
      { userId: 销售经理, bizRole: "sales_mgr" },
      { userId: 甲, bizRole: "sales", managerId: 销售经理 },
      { userId: 乙, bizRole: "sales", managerId: 销售经理 },
    ],
  });
  await setSetting(规则.线索分配.key, true);
  // 销售经理也能接线索：给他 0 配额，算「填了配额」，满额那条路才走得到
  await 配(销售经理, 0);
  当(市场);
});

describe("都已满额 → 提醒市场管理、总管理员", () => {
  it("单条：市场管理、总管理员、老板各一条，写清哪条线索、谁点的；销售、销售管理没有", async () => {
    await 配(甲, 0);
    await 配(乙, 0);
    const L = await 建线索("L6");
    expect(await 自动分配线索(L)).toMatchObject({ ok: false, error: expect.stringMatching(/^都已满额/) });

    for (const id of [市场, 总管, 老板]) {
      const 们 = await 读满额提醒(id);
      expect(们).toHaveLength(1);
      expect(们[0]).toMatchObject({ 线索: ["L6"], 条数: 1, 谁点的: "市场小李" });
    }
    for (const id of [销售经理, 甲, 乙]) expect(await 读满额提醒(id)).toEqual([]);
  });

  it("批量：一次点击只发一条，列出所有没分出去的；分出去的不列", async () => {
    await 配(甲, 1);
    await 配(乙, 0);
    const ids = [await 建线索("L6"), await 建线索("L7"), await 建线索("L8")];
    const r = await 批量自动分配(ids);
    expect(r.ok && r.结果.filter((x) => x.ok)).toHaveLength(1);

    const 们 = await 读满额提醒(总管);
    expect(们).toHaveLength(1);
    expect(们[0].条数).toBe(2);
    expect(们[0].线索).toEqual(["L7", "L8"]);
    expect(await 读满额提醒(市场)).toHaveLength(1);
  });

  it("再点一次再发一条，新的在前", async () => {
    await 配(甲, 0);
    await 配(乙, 0);
    await 自动分配线索(await 建线索("L6"));
    await 批量自动分配([await 建线索("L7"), await 建线索("L8")]);
    const 们 = await 读满额提醒(总管);
    expect(们.map((x) => x.线索)).toEqual([["L7", "L8"], ["L6"]]);
  });

  it("有人接、或者不是满额（没人填配额）都不发", async () => {
    await 配(甲, 5);
    expect(await 自动分配线索(await 建线索("L6"))).toMatchObject({ ok: true });
    expect(await 读满额提醒(总管)).toEqual([]);

    await prisma.entLeadQuota.deleteMany({});
    expect(await 自动分配线索(await 建线索("L7"))).toMatchObject({ ok: false, error: expect.stringContaining("没填配额") });
    expect(await 批量自动分配([await 建线索("L8")])).toMatchObject({ ok: true, 结果: [{ ok: false }] });
    expect(await 读满额提醒(总管)).toEqual([]);
  });

  it("各人关各人的：总管关了，市场的还在；关别人的、关不存在的不报错也不动", async () => {
    await 配(甲, 0);
    await 配(乙, 0);
    await 自动分配线索(await 建线索("L6"));
    当(总管);
    const [条] = await 我的满额提醒();
    expect(await 关满额提醒(条.id)).toEqual({ ok: true });
    expect(await 我的满额提醒()).toEqual([]);
    expect(await 关满额提醒("不存在")).toEqual({ ok: true });
    当(市场);
    expect(await 我的满额提醒()).toHaveLength(1);
  });

  it("不是企业版：读不到", async () => {
    await 配(甲, 0);
    await 配(乙, 0);
    await 自动分配线索(await 建线索("L6"));
    mocks.企业版 = false;
    expect(await 我的满额提醒()).toEqual([]);
  });

  it("开关关闭时不变：自动分配照旧拒、不发提醒，直接调发提醒也不写库", async () => {
    await 配(甲, 0);
    await 配(乙, 0);
    mocks.企业版 = false;
    const L = await 建线索("L6");
    expect(await 自动分配线索(L)).toMatchObject({ ok: false });
    expect(await 批量自动分配([L])).toMatchObject({ ok: false });
    await 发满额提醒(await 读组织(), ["L6"], "市场小李");
    expect(await prisma.setting.count({ where: { key: { startsWith: "entLeadFullNotice:" } } })).toBe(0);
  });
});
