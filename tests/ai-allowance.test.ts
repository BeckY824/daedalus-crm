/**
 * 试用期的 AI 免费次数：赠送账本。
 *
 * 和 lib/ai-quota.ts 是两回事，混了就都不对：
 *   ai-quota   五分钟 30 次、内存态、重启清零 —— 防脚本刷爆，人正常用碰不到
 *   这里       注册送 30、余额不足 30 时每天送 3、落库 —— 这是定价的一部分
 *
 * 最要紧的两条：并发不会多放行（每多放行一次就是一次真金白银的上游调用），
 * 每日赠送在并发下不会送两遍（唯一键替我们判）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-allow-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

const 天 = 86_400_000;
let 序号 = 0;

async function 建工作区(opts: { 付费?: boolean; 过期?: boolean; 停用?: boolean } = {}) {
  const { control } = await import("@/lib/tenant/control");
  const id = `ws${序号++}`;
  await control.workspace.create({
    data: {
      id, slug: id, name: id, dbFile: `${id}.db`,
      status: opts.停用 ? "SUSPENDED" : opts.付费 ? "ACTIVE" : "TRIAL",
      trialEndsAt: new Date(Date.now() + (opts.过期 ? -天 : 3 * 天)),
      paidUntil: opts.付费 ? new Date(Date.now() + 300 * 天) : null,
    },
  });
  return id;
}

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.aiUsage.deleteMany({});
  await control.aiGrant.deleteMany({});
});

describe("试用工作区", () => {
  it("新工作区第一次看额度就有注册赠送，老工作区也一样——不需要数据迁移", async () => {
    const { 查额度, 注册赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    const q = await 查额度(ws);
    expect(q.上限).toBe(注册赠送);
    expect(q.还剩).toBe(注册赠送);
    expect(q.受限).toBe(true);
  });

  it("第一天能用的 = 注册赠送 + 当天那份每日赠送，多一次都不行", async () => {
    const { 扣一次额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    let 放行 = 0;
    for (let i = 0; i < 100; i++) {
      const r = await 扣一次额度(ws);
      if (!r.ok) {
        expect(r.error).toContain("用完");
        break;
      }
      放行++;
    }
    expect(放行).toBe(注册赠送 + 每日赠送);
  });

  it("并发提问不会多放行——先读再写会让 33 次被用掉 34 次", async () => {
    const { 扣一次额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    // 先串行用两次，让当天的每日赠送落定，剩下的一起冲
    await 扣一次额度(ws);
    await 扣一次额度(ws);
    const 结果 = await Promise.all(Array.from({ length: 注册赠送 + 20 }, () => 扣一次额度(ws)));
    expect(结果.filter((r) => r.ok).length).toBe(注册赠送 + 每日赠送 - 2);
  });

  it("拦下的那次会减回去：计数停在上限，不会把之后补的次数吃掉", async () => {
    const { 扣一次额度, 查额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    for (let i = 0; i < 注册赠送 + 20; i++) await 扣一次额度(ws);
    const q = await 查额度(ws);
    expect(q.用掉).toBe(注册赠送 + 每日赠送);
    expect(q.还剩).toBe(0);
    expect((await control.aiUsage.findUnique({ where: { workspaceId: ws } }))!.calls).toBe(注册赠送 + 每日赠送);
  });

  it("额度按工作区算，不按人头——否则拉五个同事进来就有五份", async () => {
    const { 扣一次额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    // 同一个工作区里不管谁问，扣的都是同一个池子（函数签名里根本没有 userId）
    for (let i = 0; i < 注册赠送 + 每日赠送; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);
  });

  it("试用到期后连第一次都不给——那是花钱的动作；额度和天数是两条线", async () => {
    const { 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区({ 过期: true });
    const r = await 扣一次额度(ws);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("试用已结束");
  });

  it("被停用的工作区同样不给", async () => {
    const { 扣一次额度 } = await import("@/lib/tenant/ai-allowance");
    expect((await 扣一次额度(await 建工作区({ 停用: true }))).ok).toBe(false);
  });
});

describe("每日赠送", () => {
  it("余额够 30 不送；用掉一些之后当天再看就送 3", async () => {
    const { 扣一次额度, 查额度, 注册赠送, 每日赠送, 每日赠送门槛 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    // 刚注册：30 送出、余额 30 = 门槛，今天不送
    await 查额度(ws);
    expect(await control.aiGrant.count({ where: { workspaceId: ws, reason: "daily" } })).toBe(0);

    // 用掉 1 次，余额 29 < 门槛：今天送 3
    await 扣一次额度(ws);
    const q = await 查额度(ws);
    expect(q.上限).toBe(注册赠送 + 每日赠送);
    expect(q.还剩).toBe(注册赠送 + 每日赠送 - 1);
    expect(每日赠送门槛).toBe(30);
  });

  it("同一天只送一次，并发也不会送两遍——唯一键替我们判", async () => {
    const { 扣一次额度, 查额度 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    for (let i = 0; i < 10; i++) await 扣一次额度(ws);
    await Promise.all(Array.from({ length: 8 }, () => 查额度(ws)));
    const 今日 = await control.aiGrant.findMany({ where: { workspaceId: ws, reason: "daily" } });
    expect(今日).toHaveLength(1);
    expect(今日[0].amount).toBe(3);
  });

  it("换一天再来又有 3 次——用完的人第二天登录能接着用", async () => {
    const { 扣一次额度, 查额度, 注册赠送, 每日赠送, 今天 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    for (let i = 0; i < 注册赠送 + 每日赠送; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);
    // 把今天的那条改成昨天的键，等于「过了一天」
    await control.aiGrant.updateMany({ where: { workspaceId: ws, reason: "daily" }, data: { key: `${ws}:daily:1999-01-01` } });
    const q = await 查额度(ws);
    expect(q.还剩).toBe(每日赠送);
    expect(await control.aiGrant.findFirst({ where: { key: `${ws}:daily:${今天()}` } })).not.toBeNull();
  });

  it("「天」按北京时间算", async () => {
    const { 今天 } = await import("@/lib/tenant/ai-allowance");
    // UTC 2026-09-14 20:00 = 北京 2026-09-15 04:00
    expect(今天(new Date("2026-09-14T20:00:00Z"))).toBe("2026-09-15");
    expect(今天(new Date("2026-09-14T10:00:00Z"))).toBe("2026-09-14");
  });

  it("过期或付费的工作区不结算赠送——送了也用不上，账本别乱", async () => {
    const { 查额度 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    await 查额度(await 建工作区({ 过期: true }));
    await 查额度(await 建工作区({ 付费: true }));
    expect(await control.aiGrant.count()).toBe(0);
  });
});

describe("付费工作区", () => {
  it("不限次数，也不计数——付了钱还数次数就成了另一种产品", async () => {
    const { 扣一次额度, 查额度 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区({ 付费: true });
    for (let i = 0; i < 40; i++) {
      expect((await 扣一次额度(ws)).ok).toBe(true);
    }
    expect(await control.aiUsage.findUnique({ where: { workspaceId: ws } })).toBeNull();
    expect((await 查额度(ws)).受限).toBe(false);
  });

  it("试用期间用完了，开通订阅之后立刻恢复", async () => {
    const { 扣一次额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    for (let i = 0; i < 注册赠送 + 每日赠送 + 2; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);

    await control.workspace.update({ where: { id: ws }, data: { status: "ACTIVE", paidUntil: new Date(Date.now() + 300 * 天) } });
    // 不需要清计数：付费分支根本不看它
    expect((await 扣一次额度(ws)).ok).toBe(true);
  });
});

describe("赠送账本", () => {
  it("运营台加次数：用完之后加 10 就又有 10", async () => {
    const { 扣一次额度, 加次数, 查额度, 注册赠送, 每日赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    for (let i = 0; i < 注册赠送 + 每日赠送 + 5; i++) await 扣一次额度(ws);
    expect((await 扣一次额度(ws)).ok).toBe(false);

    await 加次数(ws, 10, "谈单");
    // 被拦的 5 次没吃掉补的次数；今天的每日赠送已经领过，不会再送
    expect((await 查额度(ws)).还剩).toBe(10);
    expect((await 扣一次额度(ws)).ok).toBe(true);
  });

  it("带幂等键的赠送重复调用只记一次，不带键的每次都记", async () => {
    const { 赠送 } = await import("@/lib/tenant/ai-allowance");
    const { control } = await import("@/lib/tenant/control");
    const ws = await 建工作区();
    expect(await 赠送({ workspaceId: ws, amount: 50, reason: "invite", key: `${ws}:invite` })).toBe(true);
    expect(await 赠送({ workspaceId: ws, amount: 50, reason: "invite", key: `${ws}:invite` })).toBe(false);
    await 赠送({ workspaceId: ws, amount: 5, reason: "admin" });
    await 赠送({ workspaceId: ws, amount: 5, reason: "admin" });
    const sum = await control.aiGrant.aggregate({ where: { workspaceId: ws }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(60);
  });

  it("0 或负数不入账", async () => {
    const { 赠送 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区();
    expect(await 赠送({ workspaceId: ws, amount: 0, reason: "admin" })).toBe(false);
    expect(await 赠送({ workspaceId: ws, amount: -3, reason: "admin" })).toBe(false);
  });
});

describe("退一次额度：我们这边出错时把那一次还回去", () => {
  /*
    2026-09-21 加的。价格页卖的是「一次提问」，而模型超时、上游报错的时候
    用户什么都没拿到——那一次不该算在他头上。
    路由那边还会再判一道「用户自己中断的不退」（api/ai/stream 的 catch）。
  */
  it("扣了一次再退，账本回到原样", async () => {
    const { 扣一次额度, 查额度 } = await import("@/lib/tenant/ai-allowance");
    const { 退一次额度 } = await import("@/lib/tenant/ai-allowance");
    const 账本 = await import("@/lib/tenant/credits");
    const ws = await 建工作区();
    await 扣一次额度(ws);
    expect((await 查额度(ws)).用掉).toBe(1);
    // 退一次额度() 走的是「当前工作区」那条路，这里直接验它底下那一下：账本的回退
    await 账本.回退一次({ kind: "workspace", id: ws });
    expect((await 查额度(ws)).用掉).toBe(0);
    expect(typeof 退一次额度).toBe("function");
  });

  it("付费工作区当初就没扣，也就没得退", async () => {
    const { 扣一次额度, 查额度 } = await import("@/lib/tenant/ai-allowance");
    const ws = await 建工作区({ 付费: true });
    await 扣一次额度(ws);
    expect((await 查额度(ws)).用掉).toBe(0);
  });
});

describe("自部署版", () => {
  it("没开 MULTI_TENANT 时闸门直接放行，一次都不限", async () => {
    const { 试用额度闸门 } = await import("@/lib/tenant/ai-allowance");
    delete process.env.MULTI_TENANT;
    for (let i = 0; i < 20; i++) expect(await 试用额度闸门()).toBeNull();
    process.env.MULTI_TENANT = "1";
  });
});
