/**
 * 首页「全部商机」不限定时改成一句 LEFT JOIN（lib/dashboard-sql.ts 全部商机，2026-10-25），和原来 Prisma 带关联整表取对拍。
 *
 * 两边吃同一个库，结果必须逐行 deepEqual（含顺序：金额是浮点，合计先后要一样）：
 *   - 随机数据：几种状态 / 阶段、多位小数的金额、有 / 没有赢单时刻、有 / 没有币种行（大小写、认不得的币种）
 *   - 日期：整数毫秒、ISO 文本（Z / +08:00）、「YYYY-MM-DD HH:MM:SS」老数据，三个日期列都有
 *   - 行的先后：编号打乱插入、删掉一部分再插，rowid 和编号顺序对不上
 *   - 空库
 * 另钉：限定（业务员）时不走裸 SQL；首页接的是这一个函数。
 * 库拷自测试库到临时目录，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma";
import { 全部商机, _内部 } from "@/lib/dashboard-sql";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 我 = "cmdashopps000000000000001";
const 客户 = "cmdashoppscust00000000001";
let 目录: string;
let db: PrismaClient;

beforeAll(async () => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-dash-opps-"));
  const f = path.join(目录, "t.db");
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  for (const t of ["CustomerMerge", "CustomerNotDupe", "AiConversation", "AiProject", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerExtra", "CustomerPool", "CustomerClaim"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  await db.$executeRawUnsafe('DELETE FROM "Customer"');
  await db.user.create({ data: { id: 我, email: "dash-opps", name: "老板", role: "ADMIN", password: "x" } });
  await db.customer.create({ data: { id: 客户, name: "客户", phone: "13800000000", salesOwnerId: 我 } });
});

afterAll(async () => {
  await db?.$disconnect();
  if (目录) fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** 固定种子的伪随机数：失败时能原样复现 */
function 随机(种子: number) {
  let s = 种子 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const 原来 = () => db.opportunity.findMany({ select: _内部.商机列 });

/** 文本日期的几种写法（同步 / 老数据里见过的） */
function 文本日期(ms: number, k: number): string {
  const iso = new Date(ms).toISOString();
  if (k === 0) return iso;
  if (k === 1) return new Date(ms + 8 * 3_600_000).toISOString().replace("Z", "+08:00");
  return iso.slice(0, 19).replace("T", " ");
}

async function 灌(种子: number, 个数: number) {
  await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
  const r = 随机(种子);
  const 挑 = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const 时刻 = () => new Date(Date.UTC(2026, 9, 25) + Math.floor((r() * 2 - 1.5) * 200 * 86_400_000));
  // 编号打乱：rowid（插入先后）和编号的字典序对不上
  const 编号 = Array.from({ length: 个数 }, (_, i) => `o${种子}x${String(Math.floor(r() * 1e9)).padStart(9, "0")}${i}`);
  for (let 批 = 0; 批 < 2; 批++) {
    const 这批 = 编号.slice(批 * (个数 >> 1), 批 ? 个数 : 个数 >> 1);
    for (const id of 这批) {
      await db.opportunity.create({
        data: {
          id,
          name: id,
          customerId: 客户,
          ownerId: 我,
          amount: r() < 0.1 ? 0 : Math.round(r() * 1e9) / 100 + r() / 7,
          stage: 挑(["初步沟通", "需求确认", "方案报价", "谈判审核", "赢单成交"]),
          status: 挑(["OPEN", "OPEN", "WON", "LOST"]),
          createdAt: 时刻(),
        },
      });
      await db.$executeRawUnsafe(`UPDATE "Opportunity" SET updatedAt = ? WHERE id = ?`, 时刻().valueOf(), id);
      if (r() < 0.5) await db.opportunityClose.create({ data: { opportunityId: id, closedAt: 时刻() } });
      if (r() < 0.6) await db.opportunityMoney.create({ data: { opportunityId: id, currency: 挑(["CNY", "USD", "usd", "EUR", "XYZ", ""]) } });
      // 三成的行改成文本日期
      for (const 列 of ["createdAt", "updatedAt"]) {
        if (r() < 0.3) await db.$executeRawUnsafe(`UPDATE "Opportunity" SET ${列} = ? WHERE id = ?`, 文本日期(时刻().valueOf(), Math.floor(r() * 3)), id);
      }
      if (r() < 0.3) await db.$executeRawUnsafe(`UPDATE "OpportunityClose" SET closedAt = ? WHERE opportunityId = ?`, 文本日期(时刻().valueOf(), Math.floor(r() * 3)), id);
    }
    // 删掉第一批的一部分再插第二批：rowid 有空洞
    if (!批) for (const id of 这批.filter(() => r() < 0.2)) await db.opportunity.delete({ where: { id } });
  }
}

describe("首页全部商机：不限定时一句 LEFT JOIN，和原来 Prisma 带关联取的一模一样", () => {
  it("随机数据 × 3 个种子：逐行、逐个值、顺序都一样", async () => {
    for (const 种子 of [11, 22, 33]) {
      await 灌(种子, 160);
      const 基准 = await 原来();
      expect(基准.length).toBeGreaterThan(100);
      // 各种情形都真的灌进去了，不然对拍的是空气
      expect(基准.some((o) => o.closed === null) && 基准.some((o) => o.closed !== null)).toBe(true);
      expect(基准.some((o) => o.money === null) && 基准.some((o) => o.money?.currency === "usd")).toBe(true);
      const 文本 = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM "Opportunity" WHERE typeof(createdAt) = 'text' OR typeof(updatedAt) = 'text'`);
      expect(Number(文本[0].n)).toBeGreaterThan(10);
      expect(await 全部商机(db, true), `种子 ${种子}`).toEqual(基准);
      expect(await 全部商机(db, false)).toEqual(基准);
    }
  });

  it("空库：两边都是空数组", async () => {
    await db.$executeRawUnsafe('DELETE FROM "Opportunity"');
    expect(await 原来()).toEqual([]);
    expect(await 全部商机(db, true)).toEqual([]);
  });

  it("限定（业务员）时不走裸 SQL：行要过 lib/team-scope 那层 where", async () => {
    await 灌(44, 20);
    const 不许裸 = new Proxy(db, {
      get(t, p) {
        if (p === "$queryRaw" || p === "$queryRawUnsafe") throw new Error("限定时不该走裸 SQL");
        return Reflect.get(t, p, t);
      },
    });
    expect(await 全部商机(不许裸, false)).toEqual(await 原来());
  });

  it("首页接的是这个函数，限定与否和客户数共用一次判断", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/dashboard/Board.tsx"), "utf8");
    expect(src).toMatch(/全部商机\(prisma, await 不限定\(\)\)/);
    expect(src).toMatch(/客户数\(prisma, now, await 不限定\(\)\)/);
    expect(src).toMatch(/限定的我\(defaultClient\)\.then\(\(我\) => !我\)/);
    expect(src).not.toMatch(/prisma\.opportunity\.findMany\(\{ select: \{ createdAt/);
  });
});
