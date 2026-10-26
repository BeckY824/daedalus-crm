/**
 * 看板「数客户」改成库里按天数（lib/dashboard-sql.ts，2026-10-24），和原来取行在 JS 里数的写法对拍。
 *
 * 取行数 就是 Board 原来那一段（近90天趋势 / 每周新增 / 本月上月新增），当基准。两边吃同一个库，输出必须完全一样：
 *   - 随机数据：每个「现在」150 个客户 + 300 条跟进（三成落在边界时刻上），散在「现在」前后 200 天
 *   - 边界：每天零点、零点前后 1 毫秒；月初；周起点那一刻；30 天窗口两头；现在这一刻
 *   - 时区：Asia/Shanghai、Europe/London、America/New_York（夏令时那几天）；本机时钟和北京业务钟各一遍
 *   - 空库
 *   - 限定（业务员）：多人数据 + 渠道负责人 + 公海，库里带范围数对 取行数(加了 team-scope 限定条件的库)；一人 / 一组 / 空组 / 不认识的人（2026-10-26）
 *   - 文本日期（ISO Z / +08:00 / 「YYYY-MM-DD HH:MM:SS」）：和先换成整数毫秒再数的结果一样（2026-10-25 按毫秒）
 * 库拷自测试库到临时目录，不碰共用的测试库。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Dayjs } from "dayjs";
import { PrismaClient } from "@/generated/prisma";
import { dayjs } from "@/lib/utils";
import { 客户数, 取行数, 毫秒, 按毫秒, _内部 } from "@/lib/dashboard-sql";
import { 最近8周 } from "@/lib/dashboard-trend";
import { 限定条件, type 谁 } from "@/lib/team-scope";

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

/** 多人的数据：销售负责人轮着来（最后一位不当销售），渠道负责人有空有人，约每 5 位有一位在公海 */
async function 灌多人(now: Dayjs, 种子: number, 个数: number, 人们: string[]) {
  await 清空();
  const r = 随机(种子);
  const 时刻 = () => new Date(now.valueOf() + Math.floor((r() * 2 - 1.6) * 200 * 天));
  const 边界 = 边界时刻(now);
  const 挑 = () => (r() < 0.3 ? 边界[Math.floor(r() * 边界.length)] : 时刻());
  const 客户们 = Array.from({ length: 个数 }, (_, i) => ({
    id: `m${种子}x${i}`,
    name: `客户${i}`,
    phone: `138${种子}${i}`,
    salesOwnerId: 人们[Math.floor(r() * (人们.length - 1))],
    channelOwnerId: r() < 0.5 ? null : 人们[Math.floor(r() * 人们.length)],
    createdAt: 挑(),
  }));
  await db.customer.createMany({ data: 客户们 });
  await db.customerPool.createMany({ data: 客户们.filter(() => r() < 0.2).map((c) => ({ customerId: c.id })) });
  await db.followUp.createMany({
    data: Array.from({ length: 个数 * 2 }, (_, i) => ({
      customerId: `m${种子}x${Math.floor(r() * 个数 * 0.8)}`,
      ownerId: 人们[Math.floor(r() * 人们.length)],
      type: "PHONE",
      title: `跟进${i}`,
      content: "x",
      occurredAt: 挑(),
    })),
  });
}

/** 取行的基准库：客户、跟进的 findMany 加上 team-scope 同一句限定条件（和线上 加上限定 加的一样） */
function 限定成(谁们: 谁): PrismaClient {
  const 加 = (model: string, a: { where?: object } = {}) => ({ ...a, where: { AND: [a.where ?? {}, 限定条件(model, 谁们)!] } });
  return {
    customer: { findMany: (a?: Parameters<PrismaClient["customer"]["findMany"]>[0]) => db.customer.findMany(加("Customer", a) as typeof a) },
    followUp: { findMany: (a?: Parameters<PrismaClient["followUp"]["findMany"]>[0]) => db.followUp.findMany(加("FollowUp", a) as typeof a) },
  } as unknown as PrismaClient;
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
          expect(await 客户数(db, now, null), `入口 · 现在=${iso}`).toEqual(基准);
        }
      }, 60_000);
    }
  }

  it("空库", async () => {
    设环境("Asia/Shanghai", undefined);
    await 清空();
    const now = dayjs(new Date("2026-10-20T03:15:00Z"));
    expect(await 客户数(db, now, null)).toEqual(await 取行数(db, now));
  });

  it("限定（业务员）：库里带范围数，和加了 team-scope 限定条件后取行算的逐条一致", async () => {
    const 人们 = ["cmdashsqlp0000000000000a", "cmdashsqlp0000000000000b", "cmdashsqlp0000000000000c", "cmdashsqlp0000000000000d"];
    for (const id of 人们) await db.user.upsert({ where: { id }, update: {}, create: { id, email: `dash-sql-${id}`, name: id, role: "SALES", password: "x" } });
    const 范围们: [string, 谁][] = [
      ["一个人", 人们[0]],
      ["一组人", [人们[0], 人们[2]]],
      ["只当渠道负责人的那位", 人们[3]],
      ["空的一组", []],
      ["没认出人", ["__无"]],
      ["不认识的人", "nobody"],
    ];
    for (const tz of 时区们) {
      设环境(tz, undefined);
      for (const [k, iso] of 现在们.entries()) {
        const now = dayjs(new Date(iso));
        await 灌多人(now, 3000 + k, 120, 人们);
        const 计 = _内部.排边界(now);
        expect(计).not.toBeNull();
        for (const [名, 谁] of 范围们) {
          const 基准 = await 取行数(限定成(谁), now);
          expect(await _内部.库里数(db, 计!, 谁), `${tz} · ${名} · 现在=${iso}`).toEqual(基准);
          expect(await 客户数(db, now, 谁), `入口 · ${tz} · ${名} · 现在=${iso}`).toEqual(基准);
        }
        // 防空对空：一个人的那份有数、而且和不限定的不一样
        const 一个人 = await 客户数(db, now, 人们[0]);
        expect(一个人.每周新增.reduce((a, b) => a + b, 0) + 一个人.本月新增 + 一个人.上月新增).toBeGreaterThan(0);
        expect(一个人).not.toEqual(await 客户数(db, now, null));
      }
    }
  }, 120_000);
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

/** 文本日期的几种写法（同步 / 老数据里见过的） */
function 文本日期(ms: number, k: number): string {
  const iso = new Date(ms).toISOString();
  if (k === 0) return iso;
  if (k === 1) return new Date(ms + 8 * 3_600_000).toISOString().replace("Z", "+08:00");
  return iso.slice(0, 19).replace("T", " ");
}

describe("按毫秒：把类型判断提到外面，值和 f(毫秒(列)) 一样", () => {
  it("整数、小数、三种文本、认不得的文本、NULL × 第几天 / IN / 比大小", async () => {
    const z0 = Date.parse("2026-06-01T16:00:00Z");
    const 零点 = Array.from({ length: 130 }, (_, i) => z0 + i * 天);
    const 值们: string[] = ["NULL", "'abc'", "''", String(z0), String(z0 - 1), `${z0}.5`, `${z0 + 天 - 0.25}`];
    for (let i = 0; i < 120; i++) {
      const ms = z0 + Math.floor((i - 10) * 1.13 * 天) + (i % 3) - 1;
      值们.push(String(ms), `'${文本日期(ms, i % 3)}'`);
    }
    const 表 = 值们.map((v) => `(${v})`).join(",");
    const 函数们: [string, (t: string) => string][] = [
      ["第几天", (t) => _内部.第几天(t, 零点)],
      ["除出第几天", (t) => _内部.除出第几天(t, 零点)!],
      ["IN", (t) => `(${t} IN (${零点[3]}, ${零点[40]}, ${零点[41] - 1}))`],
      ["比大小", (t) => `${t} >= ${零点[0]}`],
    ];
    for (const [名, f] of 函数们) {
      const 行 = await db.$queryRawUnsafe<{ a: unknown; b: unknown }[]>(
        `SELECT ${按毫秒("x", f)} AS a, ${f(毫秒("x"))} AS b FROM (SELECT column1 AS x FROM (VALUES ${表}))`,
      );
      expect(行.length, 名).toBe(值们.length);
      expect(new Set(行.map((r) => String(r.a))).size, 名).toBeGreaterThan(1);
      for (const [i, r] of 行.entries()) expect(r.a === null ? null : Number(r.a), `${名} · ${值们[i]}`).toBe(r.b === null ? null : Number(r.b));
    }
  });

  it("库里有文本日期时，和先换成整数毫秒再数的一样（三个时区 × 两个现在）", async () => {
    for (const tz of 时区们) {
      设环境(tz, undefined);
      for (const iso of ["2026-10-20T03:15:00Z", "2026-11-01T06:30:00Z"]) {
        const now = dayjs(new Date(iso));
        await 灌(now, 3000, 150);
        const r = 随机(7);
        // 三成的建档、跟进时间改成文本
        for (const [表, 列] of [["Customer", "createdAt"], ["FollowUp", "occurredAt"]] as const) {
          const 行 = await db.$queryRawUnsafe<{ id: string; t: bigint | number }[]>(`SELECT id, ${列} AS t FROM "${表}"`);
          for (const x of 行) if (r() < 0.3) await db.$executeRawUnsafe(`UPDATE "${表}" SET ${列} = ? WHERE id = ?`, 文本日期(Number(x.t), Math.floor(r() * 3)), x.id);
        }
        const 文本 = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT (SELECT count(*) FROM "Customer" WHERE typeof(createdAt) = 'text') + (SELECT count(*) FROM "FollowUp" WHERE typeof(occurredAt) = 'text') AS n`);
        expect(Number(文本[0].n)).toBeGreaterThan(100);
        const 计 = _内部.排边界(now)!;
        const 有文本 = await _内部.库里数(db, 计);
        await db.$executeRawUnsafe(`UPDATE "Customer" SET createdAt = ${毫秒("createdAt")}`);
        await db.$executeRawUnsafe(`UPDATE "FollowUp" SET occurredAt = ${毫秒("occurredAt")}`);
        expect(有文本, `${tz} · 现在=${iso}`).toEqual(await _内部.库里数(db, 计));
        expect(有文本).toEqual(await 取行数(db, now));
      }
    }
  }, 60_000);
});
