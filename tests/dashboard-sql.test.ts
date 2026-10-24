/**
 * 看板「数客户」改成库里按天数（lib/dashboard-sql.ts，2026-10-24），和原来取行在 JS 里数的写法对拍。
 *
 * 取行数 就是 Board 原来那一段（近90天趋势 / 每周新增 / 本月上月新增），当基准。两边吃同一个库，输出必须完全一样：
 *   - 随机数据：每个「现在」150 个客户 + 300 条跟进（三成落在边界时刻上），散在「现在」前后 200 天
 *   - 边界：每天零点、零点前后 1 毫秒；月初；周起点那一刻；30 天窗口两头；现在这一刻
 *   - 时区：Asia/Shanghai、Europe/London、America/New_York（夏令时那几天）；本机时钟和北京业务钟各一遍
 *   - 空库
 * 库拷自测试库到临时目录，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Dayjs } from "dayjs";
import { PrismaClient } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";
import { 客户数, 取行数, _内部 } from "@/lib/dashboard-sql";
import { 最近8周 } from "@/lib/dashboard-trend";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 我 = "cmdashsql0000000000000001";
let 目录: string;
let db: PrismaClient;

beforeAll(async () => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-dash-sql-"));
  const f = path.join(目录, "t.db");
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await 清空();
  await db.user.create({ data: { id: 我, email: "dash-sql", name: "老板", role: "ADMIN", password: "x" } });
});

const 原TZ = process.env.TZ;
const 原MT = process.env.MULTI_TENANT;
afterAll(async () => {
  process.env.TZ = 原TZ;
  if (原MT === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = 原MT;
  await db?.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function 清空() {
  for (const t of ["CustomerMerge", "CustomerNotDupe", "AiConversation", "AiProject", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerExtra", "CustomerPool", "CustomerClaim"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  await db.$executeRawUnsafe('DELETE FROM "Customer"');
}

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

const 天 = 86_400_000;

function 边界时刻(now: Dayjs): Date[] {
  const out: Date[] = [now.toDate(), new Date(now.valueOf() - 1), new Date(now.valueOf() + 1)];
  for (let i = -125; i <= 3; i++) {
    const 零点 = now.add(i, "day").startOf("day").valueOf();
    out.push(new Date(零点), new Date(零点 - 1), new Date(零点 + 1));
  }
  for (const 月 of [-4, -3, -2, -1, 0, 1]) {
    const 月初 = now.add(月, "month").startOf("month").valueOf();
    out.push(new Date(月初), new Date(月初 - 1));
  }
  // 「每周新增」两头都不含：正好在周起点、周止点那一刻的要单独测
  for (const w of 最近8周(now)) out.push(w.起.toDate(), w.止.toDate(), new Date(w.起.valueOf() + 1), new Date(w.止.valueOf() - 1));
  return out;
}

async function 灌(now: Dayjs, 种子: number, 个数: number) {
  await 清空();
  const r = 随机(种子);
  const 时刻 = () => new Date(now.valueOf() + Math.floor((r() * 2 - 1.6) * 200 * 天));
  const 边界 = 边界时刻(now);
  const 挑 = () => (r() < 0.3 ? 边界[Math.floor(r() * 边界.length)] : 时刻());
  await db.customer.createMany({
    data: Array.from({ length: 个数 }, (_, i) => ({ id: `c${种子}x${i}`, name: `客户${i}`, phone: `139${种子}${i}`, salesOwnerId: 我, createdAt: 挑() })),
  });
  await db.followUp.createMany({
    data: Array.from({ length: 个数 * 2 }, (_, i) => ({
      // 同一个客户多条跟进、同一天多条：活跃数是去重后的人数
      customerId: `c${种子}x${Math.floor(r() * 个数 * 0.6)}`,
      ownerId: 我,
      type: "PHONE",
      title: `跟进${i}`,
      content: "x",
      occurredAt: 挑(),
    })),
  });
}

const 现在们 = [
  "2026-10-20T03:15:00Z",
  "2026-12-31T15:59:59.999Z", // 北京 1 月 1 日零点前 1 毫秒
  "2026-12-31T16:00:00.000Z", // 北京 1 月 1 日零点
  "2027-01-01T00:30:00Z",
  "2026-03-01T00:00:00Z",
  "2026-03-29T01:30:00Z", // 伦敦进夏令时
  "2026-10-25T00:30:00Z", // 伦敦出夏令时
  "2026-03-08T07:30:00Z", // 纽约进夏令时
  "2026-11-01T06:30:00Z", // 纽约出夏令时
];
const 时区们 = ["Asia/Shanghai", "Europe/London", "America/New_York"];
const 时钟们 = [
  { 名: "本机时钟（桌面端）", MULTI_TENANT: undefined },
  { 名: "北京业务钟（托管版）", MULTI_TENANT: "1" },
];
function 设环境(tz: string, mt: string | undefined) {
  process.env.TZ = tz;
  if (mt === undefined) delete process.env.MULTI_TENANT;
  else process.env.MULTI_TENANT = mt;
}

describe("看板客户数：库里按天数和取行算一模一样", () => {
  for (const tz of 时区们) {
    for (const 钟 of 时钟们) {
      it(`${tz} · ${钟.名}`, async () => {
        设环境(tz, 钟.MULTI_TENANT);
        expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
        for (const [k, iso] of 现在们.entries()) {
          const now = dayjs(new Date(iso));
          await 灌(now, 2000 + k, 150);
          const 计 = _内部.排边界(now);
          // 这些「现在」都该走库里那条路：不然对拍的是取行对取行
          expect(计, `边界排得出 · 现在=${iso}`).not.toBeNull();
          const 基准 = await 取行数(db, now);
          expect(await _内部.库里数(db, 计!), `现在=${iso}`).toEqual(基准);
          expect(await 客户数(db, now, true), `入口 · 现在=${iso}`).toEqual(基准);
        }
      }, 60_000);
    }
  }

  it("空库", async () => {
    设环境("Asia/Shanghai", undefined);
    await 清空();
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    expect(await 客户数(db, now, true)).toEqual(await 取行数(db, now));
  });

  it("限定（业务员）时不走库里数，照旧取行", async () => {
    设环境("Asia/Shanghai", undefined);
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    await 灌(now, 99, 20);
    const 原 = db.$queryRawUnsafe.bind(db);
    let 调了 = 0;
    const 包 = new Proxy(db, {
      get(t, p, r) {
        if (p === "$queryRawUnsafe") return (...a: Parameters<typeof 原>) => { 调了++; return 原(...a); };
        return Reflect.get(t, p, r);
      },
    });
    expect(await 客户数(包, now, false)).toEqual(await 取行数(db, now));
    expect(调了).toBe(0);
  });
});

describe("第几天：能除时直接除，和嵌套 CASE 一样", () => {
  it("均匀的一串零点：边界前后、小数、NULL、早于和晚于两头", async () => {
    const z0 = Date.parse("2026-06-01T16:00:00Z");
    const 零点 = Array.from({ length: 130 }, (_, i) => z0 + i * 天);
    const 除 = _内部.除出第几天("t", 零点);
    expect(除).not.toBeNull();
    const 值们: (number | null)[] = [null, z0, z0 + 0.5, z0 + 天 - 1, z0 + 天 - 0.25, z0 + 天, 零点[129] - 1, 零点[129], 零点[129] + 5 * 天 + 3];
    for (let i = 0; i < 200; i++) 值们.push(z0 + Math.floor(i * 0.73 * 天) + (i % 3) - 1);
    const 表 = 值们.filter((v) => v === null || v >= z0).map((v) => `(${v === null ? "NULL" : v})`).join(",");
    const 行 = await db.$queryRawUnsafe<{ a: bigint | number; b: bigint | number }[]>(
      `SELECT ${除} AS a, ${_内部.第几天("t", 零点)} AS b FROM (SELECT column1 AS t FROM (VALUES ${表}))`,
    );
    expect(行.length).toBeGreaterThan(200);
    for (const r of 行) expect(Number(r.a)).toBe(Number(r.b));
  });

  it("夏令时切换落在这段里就不除", () => {
    设环境("Europe/London", undefined);
    expect(_内部.除出第几天("t", _内部.排边界(dayjs(new Date("2026-10-20T03:15:00Z")))!.零点)).toBeNull();
    设环境("Asia/Shanghai", undefined);
    expect(_内部.除出第几天("t", _内部.排边界(dayjs(new Date("2026-10-20T03:15:00Z")))!.零点)).not.toBeNull();
  });
});
