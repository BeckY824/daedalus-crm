/**
 * R2 · 桌面端提醒的异常场景：壳（desktop/reminders.js 开始()）+ 服务端口径（lib/reminders.ts 算提醒）串起来跑。
 *
 * 壳每分钟问一次本地服务；这里不等定时器，直接调 刷新()、把「现在」拨到想要的时刻。
 * 本地服务那头用 算提醒(项, now) 现算——和 /api/desktop/reminders 一样的口径。
 * 后半段用真库（prisma/test.db）跑 saveFollowUp / savePlan / deletePlan，看到点还叫不叫。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { 算提醒, type 提醒项 } from "@/lib/reminders";
import { prisma } from "@/lib/prisma";
import { 取提醒项 } from "@/lib/reminders-db";
import { resetDb } from "./reset";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "tester-id", name: "测试员", email: "t", role: "ADMIN", title: "" }),
}));

const require_ = createRequire(import.meta.url);
const 提醒 = require_("../desktop/reminders.js");

const 原TZ = process.env.TZ;
let 目录: string;
beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-remind-"));
});
afterEach(() => {
  process.env.TZ = 原TZ;
  fs.rmSync(目录, { recursive: true, force: true });
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** 一个壳 + 一个假的本地服务。服务那头的数据是 项，口径是 算提醒 */
function 起壳(项: () => 提醒项[], opts: { 文件?: string | (() => string); 服务在?: () => boolean; 早报?: boolean } = {}) {
  let now = new Date();
  const 发了: { 标题: string; 正文: string; 去: string; 时: string }[] = [];
  const 角标: number[] = [];
  const 壳 = 提醒.开始({
    文件: opts.文件 ?? path.join(目录, "reminders.json"),
    取端口: () => 1,
    取令牌: () => "tok",
    通知: (标题: string, 正文: string, 去: string) => 发了.push({ 标题, 正文, 去, 时: now.toISOString() }),
    设角标: (n: number) => 角标.push(n),
    现在: () => now,
    fetch: async () => {
      if (opts.服务在 && !opts.服务在()) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify(算提醒(项(), now)), { status: 200 });
    },
  });
  // 到点那几条不想被早报搅进来：默认关掉早报，测早报的那几条自己打开
  if (opts.早报 !== true) 壳.改设置({ 早报: false });
  角标.length = 0;
  return {
    发了,
    角标,
    async 到(t: Date) {
      now = t;
      await 壳.刷新();
    },
    停: () => 壳.停(),
    改设置: (s: object) => 壳.改设置(s),
  };
}

const 项 = (id: string, 时间: Date, 标题 = "回电话", kind: "plan" | "task" = "plan"): 提醒项 => ({ id, kind, 标题, 时间, customerId: "c1", 客户: "王总" });
const 北京 = (s: string) => new Date(`${s}+08:00`);

describe("到点提醒：睡眠 / 改时间 / 删除", () => {
  it("一分钟一问、到点叫一次；之后每一轮都不再叫", async () => {
    const 列表 = [项("p1", 北京("2026-10-02T15:00:00"))];
    const 壳 = 起壳(() => 列表);
    await 壳.到(北京("2026-10-02T14:59:00"));
    await 壳.到(北京("2026-10-02T15:00:00"));
    await 壳.到(北京("2026-10-02T15:01:00"));
    await 壳.到(北京("2026-10-02T15:05:00"));
    壳.停();
    expect(壳.发了.filter((x) => x.标题.startsWith("到点了")).map((x) => x.时)).toEqual([北京("2026-10-02T15:00:00").toISOString()]);
    expect(壳.发了[0].去).toBe("/customers/c1?focus=plan%3Ap1");
  });

  it("电脑睡了 8 分钟才醒（还在 10 分钟回看里）：醒来补叫一次", async () => {
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T15:00:00"))]);
    await 壳.到(北京("2026-10-02T14:58:00"));
    await 壳.到(北京("2026-10-02T15:08:00"));
    壳.停();
    expect(壳.发了.filter((x) => x.标题.startsWith("到点了")).length).toBe(1);
  });

  /*
    D-049（2026-10-04 工作室试用前）：睡过 10 分钟才醒，原来那条「3 点给王总回电话」**永远不会再叫**，也不说错过了——
    人合上电脑开会、4 点打开，只会觉得提醒坏了。回看窗口照旧（单条的「到点了」过了 10 分钟就是马后炮），
    但醒来把错过的**合成一条**：「你有 N 条提醒在合盖时到点了」。只算壳睡前就看见要来的（应用刚打开不算合盖）。
  */
  it("电脑睡了 20 分钟（D-049）：醒来合成一条「你有 1 条提醒在合盖时到点了」，点开去那位客户；之后不再叫", async () => {
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T15:00:00"), "回电话")]);
    await 壳.到(北京("2026-10-02T14:58:00"));
    await 壳.到(北京("2026-10-02T15:20:00"));
    await 壳.到(北京("2026-10-02T15:21:00"));
    壳.停();
    expect(壳.发了.filter((x) => x.标题.startsWith("到点了"))).toEqual([]);
    const 错过 = 壳.发了.filter((x) => x.标题.includes("合盖时到点了"));
    expect(错过.map((x) => x.标题)).toEqual(["你有 1 条提醒在合盖时到点了"]);
    expect(错过[0].正文).toContain("回电话");
    expect(错过[0].去).toBe("/customers/c1?focus=plan%3Ap1");
    expect(错过[0].时).toBe(北京("2026-10-02T15:20:00").toISOString());
  });

  it("睡过了两条（D-049）：只发一条「你有 2 条…」，点开去跟进计划", async () => {
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T15:00:00"), "回电话"), 项("p2", 北京("2026-10-02T15:10:00"), "发报价")]);
    await 壳.到(北京("2026-10-02T14:50:00"));
    await 壳.到(北京("2026-10-02T15:40:00"));
    await 壳.到(北京("2026-10-02T15:41:00"));
    壳.停();
    expect(壳.发了.map((x) => x.标题)).toEqual(["你有 2 条提醒在合盖时到点了"]);
    expect(壳.发了[0].正文).toContain("回电话");
    expect(壳.发了[0].正文).toContain("发报价");
    expect(壳.发了[0].去).toBe("/follow-ups/plans");
  });

  it("睡着时那条已经做完 / 删了（D-049）：醒来不说错过", async () => {
    let 列表 = [项("p1", 北京("2026-10-02T15:00:00"))];
    const 壳 = 起壳(() => 列表);
    await 壳.到(北京("2026-10-02T14:58:00"));
    列表 = [];
    await 壳.到(北京("2026-10-02T15:20:00"));
    壳.停();
    expect(壳.发了).toEqual([]);
  });

  it("应用刚打开（壳之前没在跑）：早过了的那条不当成合盖错过（D-049）", async () => {
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T15:00:00"))]);
    await 壳.到(北京("2026-10-02T15:20:00"));
    壳.停();
    expect(壳.发了).toEqual([]);
  });

  it("到点前把计划从 3 点改到 4 点：3 点不叫，4 点叫一次", async () => {
    let 列表 = [项("p1", 北京("2026-10-02T15:00:00"))];
    const 壳 = 起壳(() => 列表);
    await 壳.到(北京("2026-10-02T14:50:00"));
    列表 = [项("p1", 北京("2026-10-02T16:00:00"))];
    await 壳.到(北京("2026-10-02T15:00:00"));
    await 壳.到(北京("2026-10-02T16:00:00"));
    await 壳.到(北京("2026-10-02T16:01:00"));
    壳.停();
    expect(壳.发了.map((x) => x.时)).toEqual([北京("2026-10-02T16:00:00").toISOString()]);
  });

  it("叫过之后改到半小时后：算新的一条，到点再叫一次", async () => {
    let 列表 = [项("p1", 北京("2026-10-02T15:00:00"))];
    const 壳 = 起壳(() => 列表);
    await 壳.到(北京("2026-10-02T15:00:00"));
    列表 = [项("p1", 北京("2026-10-02T15:30:00"))];
    await 壳.到(北京("2026-10-02T15:30:00"));
    壳.停();
    expect(壳.发了.length).toBe(2);
  });

  it("到点前删了（deletePlan）：不叫；角标跟着少一个", async () => {
    let 列表 = [项("p1", 北京("2026-10-02T15:00:00")), 项("p2", 北京("2026-10-02T17:00:00"))];
    const 壳 = 起壳(() => 列表);
    await 壳.到(北京("2026-10-02T14:59:00"));
    列表 = 列表.filter((x) => x.id !== "p1");
    await 壳.到(北京("2026-10-02T15:00:00"));
    expect(壳.角标).toEqual([2, 1]);
    壳.停();
    expect(壳.发了.filter((x) => x.标题.startsWith("到点了"))).toEqual([]);
  });

  it("重启应用：叫过的不重叫（记在 reminders.json），没叫过的照叫", async () => {
    const 列表 = [项("p1", 北京("2026-10-02T15:00:00")), 项("p2", 北京("2026-10-02T15:03:00"))];
    const 一 = 起壳(() => 列表);
    await 一.到(北京("2026-10-02T15:00:00"));
    一.停();
    const 二 = 起壳(() => 列表);
    await 二.到(北京("2026-10-02T15:03:00"));
    二.停();
    expect([...一.发了, ...二.发了].map((x) => x.标题)).toEqual(["到点了：回电话", "到点了：回电话"]);
    expect(二.发了.length).toBe(1);
  });

  it("reminders.json 坏了：不抛，照常提醒（最多重叫一次）", async () => {
    const f = path.join(目录, "reminders.json");
    fs.writeFileSync(f, "{坏的");
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T15:00:00"))], { 文件: f });
    await 壳.到(北京("2026-10-02T15:00:00"));
    壳.停();
    expect(壳.发了.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).已提醒.length).toBe(1);
  });
});

describe("早报：跨天 / 时区", () => {
  it("今天 9 点发过，晚上不再发；跨过零点不发，到第二天 9 点再发一次", async () => {
    const 列表 = [项("p1", 北京("2026-10-01T00:00:00"))]; // 逾期的
    const 壳 = 起壳(() => 列表, { 早报: true });
    await 壳.到(北京("2026-10-02T09:00:00"));
    await 壳.到(北京("2026-10-02T23:59:00"));
    await 壳.到(北京("2026-10-03T00:01:00"));
    await 壳.到(北京("2026-10-03T08:59:00"));
    await 壳.到(北京("2026-10-03T09:00:00"));
    壳.停();
    expect(壳.发了.map((x) => x.时)).toEqual([北京("2026-10-02T09:00:00"), 北京("2026-10-03T09:00:00")].map((d) => d.toISOString()));
  });

  it("9 点时应用没开，下午第一次打开补发一次", async () => {
    const 壳 = 起壳(() => [项("p1", 北京("2026-10-02T00:00:00"))], { 早报: true });
    await 壳.到(北京("2026-10-02T14:00:00"));
    await 壳.到(北京("2026-10-02T14:01:00"));
    壳.停();
    expect(壳.发了.length).toBe(1);
    expect(壳.发了[0].标题).toBe("今天有 1 个要跟进");
  });

  it("本机时区是纽约：早报按纽约的 9 点、「今天 / 逾期」按纽约的日历", async () => {
    process.env.TZ = "America/New_York";
    // 纽约 10-02 10:00 的计划（= 北京 10-02 22:00）
    const 列表 = [项("p1", new Date("2026-10-02T10:00:00-04:00"))];
    const 壳 = 起壳(() => 列表, { 早报: true });
    await 壳.到(new Date("2026-10-02T08:59:00-04:00"));
    expect(壳.发了).toEqual([]);
    await 壳.到(new Date("2026-10-02T09:00:00-04:00"));
    壳.停();
    expect(壳.发了.map((x) => x.标题)).toEqual(["今天有 1 个要跟进"]);
    expect(算提醒(列表, new Date("2026-10-03T00:30:00-04:00"))).toMatchObject({ 逾期: 1, 今天: 0 });
  });

  /*
    【C】只选了日期的计划存成「当时本机时区的零点」。人在北京排的「10 月 3 日回访」，出差到纽约打开应用，
    它就成了纽约 10 月 2 日中午 12 点、「定了时刻」——中午会弹一条「到点了」，计划页也显示 12:00。
    现状钉在这里，改要动存储口径（只存日期），不在壳里。
  */
  it("【C-2 现状】北京排的「只选日期」计划，到纽约变成中午 12 点的到点提醒", async () => {
    const 只选日期 = 北京("2026-10-03T00:00:00");
    process.env.TZ = "America/New_York";
    const 壳 = 起壳(() => [项("p1", 只选日期)]);
    await 壳.到(new Date("2026-10-02T12:00:00-04:00"));
    壳.停();
    expect(壳.发了.some((x) => x.标题 === "到点了：回电话")).toBe(true);
  });
});

describe("换账号 / 服务在重启", () => {
  it("D-050：同一个壳换账号，两人各收早报；切回不重复且设置各自保存", async () => {
    const a = path.join(目录, "a-reminders.json");
    const b = path.join(目录, "b-reminders.json");
    let f = a;
    const 壳 = 起壳(() => [项("a1", 北京("2026-10-01T00:00:00"))], { 文件: () => f, 早报: true });
    await 壳.到(北京("2026-10-02T09:00:00"));
    壳.改设置({ 早报时间: "08:30" });
    f = b;
    await 壳.到(北京("2026-10-02T09:30:00"));
    f = a;
    await 壳.到(北京("2026-10-02T09:40:00"));
    壳.停();
    expect(壳.发了.length).toBe(2);
    expect(JSON.parse(fs.readFileSync(a, "utf8")).设置.早报时间).toBe("08:30");
    expect(JSON.parse(fs.readFileSync(b, "utf8")).设置.早报时间).toBe("09:00");
  });

  it("切账号期间返回的旧请求、停止后的请求，都不能再通知或写文件", async () => {
    let f = path.join(目录, "a.json");
    let resolve!: (response: Response) => void;
    const 通知 = vi.fn();
    const 设角标 = vi.fn();
    const 壳 = 提醒.开始({ 文件: () => f, 取端口: () => 1, 取令牌: () => "token",
      通知, 设角标, 现在: () => 北京("2026-10-02T10:00:00"),
      fetch: () => new Promise<Response>((r) => { resolve = r; }),
    });
    const run = 壳.刷新();
    f = path.join(目录, "b.json");
    resolve(new Response(JSON.stringify({ 逾期: 1, 今天: 1, 定时: [] })));
    await run;
    expect(通知).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(false);
    const late = 壳.刷新();
    壳.停();
    resolve(new Response(JSON.stringify({ 逾期: 1, 今天: 1, 定时: [] })));
    await late;
    expect(通知).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(false);
  });

  it("本地服务在重启（换账号中）：角标保持上一次的数，不闪成 0；服务回来马上更新", async () => {
    let 在 = true;
    let 列表 = [项("a1", 北京("2026-10-01T00:00:00")), 项("a2", 北京("2026-10-01T00:00:00"))];
    const 壳 = 起壳(() => 列表, { 服务在: () => 在 });
    await 壳.到(北京("2026-10-02T10:00:00"));
    在 = false;
    await 壳.到(北京("2026-10-02T10:01:00"));
    在 = true;
    列表 = [];
    await 壳.到(北京("2026-10-02T10:02:00"));
    expect(壳.角标).toEqual([2, 2, 0]);
    壳.停();
  });
});

describe("真库：计划改删、跟进提醒顺带建的待办", () => {
  let customerId: string;
  beforeEach(async () => {
    await resetDb();
    await prisma.user.create({ data: { id: "tester-id", email: "t", name: "测试员", title: "", role: "ADMIN", password: "x" } });
    customerId = (await prisma.customer.create({ data: { name: "王总", phone: "13800000001", salesOwnerId: "tester-id" } })).id;
  });
  const 摘要 = async (now: Date) => 算提醒(await 取提醒项("tester-id"), now);
  const 一小时后 = () => {
    const t = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000 + 7 * 60_000);
    // 落在本机零点整就不算「定了时刻」，挪一分钟
    return t.getHours() === 0 && t.getMinutes() === 0 ? new Date(t.getTime() + 60_000) : t;
  };

  it("savePlan 改时间：定时里换成新时刻；deletePlan 之后定时里没了、数也少了", async () => {
    const { savePlan, deletePlan } = await import("@/app/(app)/customers/[id]/actions");
    const t = 一小时后();
    const r = await savePlan({ customerId, subject: "回电话", plannedAt: t.toISOString(), method: "电话" });
    if (!r.ok) throw new Error(r.error);
    expect((await 摘要(t)).定时.map((x) => x.at)).toEqual([t.toISOString()]);
    const t2 = new Date(t.getTime() + 30 * 60_000);
    await savePlan({ id: r.id, customerId, subject: "回电话", plannedAt: t2.toISOString(), method: "电话" });
    expect((await 摘要(t)).定时.map((x) => x.at)).toEqual([t2.toISOString()]);
    await deletePlan(r.id);
    const 后 = await 摘要(t2);
    expect(后.定时).toEqual([]);
    expect(后.今天 + 后.逾期).toBe(0);
  });

  it("新建「跟进提醒」带时间：顺带的待办到点会叫", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const t = 一小时后();
    await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t.toISOString() });
    expect((await 摘要(t)).定时.map((x) => [x.标题, x.at])).toEqual([["回电话", t.toISOString()]]);
  });

  /*
    【B · 真坏】「跟进提醒→待办」只在新建时建、之后两头不再联动（customers/[id]/actions.ts:127）：
      - 改了那条跟进的提醒时间 → 待办还是旧时间，到点按旧时间叫，新时间不叫
      - 把那条跟进标成「已完成」 → 待办没完成，照样叫、照样占 Dock 上的数
      - 删了那条跟进 → 待办还在，照样叫
    人改的是「跟进提醒」那一格，不知道背后还有一条待办。
  */
  it("【B-5 真坏】改了跟进提醒的时间：应当按新时间叫，旧时间不叫", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const t = 一小时后();
    const r = await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t.toISOString() });
    const t2 = new Date(t.getTime() + 2 * 3_600_000);
    await saveFollowUp({ id: r.ok ? r.id : "", customerId, type: "REMIND", title: "回电话", content: "回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t2.toISOString() });
    expect((await 摘要(t)).定时.map((x) => x.at)).toEqual([t2.toISOString()]);
  });

  it("【B-5 真坏】跟进提醒标成「已完成」：顺带的待办不该再叫", async () => {
    const { saveFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const t = 一小时后();
    const r = await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t.toISOString() });
    await saveFollowUp({ id: r.ok ? r.id : "", customerId, type: "REMIND", title: "回电话", content: "回电话", status: "已完成", occurredAt: new Date().toISOString(), dueAt: t.toISOString() });
    expect((await 摘要(t)).定时).toEqual([]);
  });

  it("【B-5 真坏】删了那条跟进提醒：顺带的待办不该再叫", async () => {
    const { saveFollowUp, deleteFollowUp } = await import("@/app/(app)/customers/[id]/actions");
    const t = 一小时后();
    const r = await saveFollowUp({ customerId, type: "REMIND", title: "回电话", content: "回电话", status: "待处理", occurredAt: new Date().toISOString(), dueAt: t.toISOString() });
    await deleteFollowUp(r.ok ? r.id : "", customerId);
    expect((await 摘要(t)).定时).toEqual([]);
  });
});
