/**
 * 阿里国际站 ID（CustomerExtra.alibabaId，迁移 040，2026-10-21）走团队同步。总控验收里最要紧的一条：
 * 还没升级的老版本客户端收到带这个字段的记录，不能报错，也不能卡住同步（团队里总有人晚升级）。
 *
 *   新 → 旧：老版本那台库里没有这一列——回放只写本机有的列，不报错、不进「没同步上」，别的格照常；
 *            只有阿里 ID 的客户（档案行里别的格全空）也落得下来；手机伴侣新建（插入带全部列）同样
 *   旧 → 新：老版本那台改国家、新建档案行（不带这一列），新版这边的阿里 ID 不被冲掉
 *   旧升级：补上这一列、重装触发器、表结构签名变了 → 从头重放一遍就补齐
 * 台子照 tests/trade-basics-sync.test.ts（那边是 level / website 两列的同一套）。
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@/generated/prisma";
import { 建同步表, 装触发器, 待推, 记已推, 回放, 没同步上, 本机结构签名, type 改动 } from "@/lib/sync/local";
import { 封, 拆, 新钥匙 } from "@/lib/sync/crypto";
import { 写外贸档案 } from "@/lib/customer-extra-db";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 迁移目录 = path.resolve(__dirname, "../migrations");
const 管理员 = { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN" };

let 目录: string;
const 开着: PrismaClient[] = [];
const 钥匙 = 新钥匙();

function 拷库(名: string): string {
  const f = path.join(目录, `${名}.db`);
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  return f;
}

/** 老版本（0.46.24 及以前）的库：没有 alibabaId 这一列。拿当前测试库拷一份、把这列拆掉，和真老库的表结构一样 */
function 拆成老库(f: string) {
  const d = new DatabaseSync(f);
  d.exec('ALTER TABLE "CustomerExtra" DROP COLUMN "alibabaId"');
  d.close();
}

/** 老库升级：照 desktop/server-entry.js 把整个 migrations/ 重跑一遍（加列那句第二遍抛 duplicate column name，当预期跳过） */
function 跑迁移(f: string) {
  const d = new DatabaseSync(f);
  for (const m of fs.readdirSync(迁移目录).filter((x) => x.endsWith(".sql")).sort()) {
    try {
      d.exec(fs.readFileSync(path.join(迁移目录, m), "utf8"));
    } catch (e) {
      if (!/duplicate column name|already exists/i.test(String((e as Error)?.message))) throw e;
    }
  }
  d.close();
}

async function 开(f: string): Promise<PrismaClient> {
  const db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  开着.push(db);
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await db.user.create({ data: { ...管理员, password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
  await 建同步表(db);
  await 装触发器(db);
  return db;
}

/** 推一包（经过加密），返回明文改动给对方回放；历史留着，给「升级后从头重拉」用 */
async function 推(db: PrismaClient, 设备: string, 历史: 改动[][]): Promise<改动[]> {
  const { 改动: 批, 到 } = await 待推(db, 设备);
  if (!批.length) return [];
  await 记已推(db, 到);
  const 回 = 拆(封(批, 钥匙), 钥匙);
  历史.push(回);
  return 回;
}

/** 老版本客户端写数据：它的 Prisma 不知道 alibabaId，表里也没有——直接写 SQL，模拟老包的写法（老包的 写外贸档案 只认七格） */
async function 老包写档案(db: PrismaClient, customerId: string, 格: { country?: string; whatsapp?: string }) {
  const 有 = (await db.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "CustomerExtra" WHERE "customerId" = ?', customerId)).length > 0;
  if (有) {
    for (const [k, v] of Object.entries(格)) await db.$executeRawUnsafe(`UPDATE "CustomerExtra" SET "${k}" = ? WHERE "customerId" = ?`, v, customerId);
  } else {
    await db.$executeRawUnsafe('INSERT INTO "CustomerExtra" ("customerId", "country", "whatsapp", "wechat", "email", "source", "level", "website") VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)', customerId, 格.country ?? null, 格.whatsapp ?? null);
  }
}

const 列们 = async (db: PrismaClient) => (await db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("CustomerExtra")')).map((c) => c.name);

beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-alibaba-sync-"));
});
afterEach(async () => {
  for (const db of 开着.splice(0)) await db.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it("新 ↔ 新：阿里 ID 同步过去；两台同时改同一位的不同格（甲改阿里 ID、乙改国家）都留下", async () => {
  const a = await 开(拷库("A"));
  const b = await 开(拷库("B"));
  const 史: 改动[][] = [];
  const c = await a.customer.create({ data: { name: "Acme", phone: "", salesOwnerId: 管理员.id } });
  await 写外贸档案(a, c.id, { alibabaId: "us001" }, false);
  await 回放(b, await 推(a, "A", 史), "B");
  expect(await b.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ alibabaId: "us001" });

  await 写外贸档案(a, c.id, { alibabaId: "us002" });
  await 写外贸档案(b, c.id, { country: "美国" });
  const pa = await 推(a, "A", 史);
  const pb = await 推(b, "B", 史);
  await 回放(b, pa, "B");
  await 回放(a, pb, "A");
  for (const db of [a, b]) expect(await db.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ alibabaId: "us002", country: "美国" });
  expect((await 没同步上(a)).条数).toBe(0);
  expect((await 没同步上(b)).条数).toBe(0);
});

it("新 → 旧 → 升级：老版本收到带阿里 ID 的档案不报错、不卡同步，后面的改动照常进；升级后从头重放就补齐", async () => {
  const 新 = await 开(拷库("new"));
  const 旧库 = 拷库("old");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  expect(await 列们(旧)).not.toContain("alibabaId");
  const 签名前 = await 本机结构签名(旧);
  const 史: 改动[][] = [];

  // 一位只有阿里 ID 的（档案行别的格全空）、一位阿里 ID + 国家的
  const 只阿里 = await 新.customer.create({ data: { name: "Only Ali", phone: "", salesOwnerId: 管理员.id } });
  await 写外贸档案(新, 只阿里.id, { alibabaId: "ae01" }, false);
  const 两样 = await 新.customer.create({ data: { name: "Globex", phone: "", salesOwnerId: 管理员.id } });
  await 写外贸档案(新, 两样.id, { country: "德国", alibabaId: "de02" }, false);
  await 回放(旧, await 推(新, "N", 史), "O");
  expect((await 没同步上(旧)).条数).toBe(0);
  expect((await 旧.customer.findMany({ orderBy: { name: "asc" } })).map((x) => x.name)).toEqual(["Globex", "Only Ali"]);
  const 行 = (await 旧.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "CustomerExtra" WHERE "customerId" = ?', 两样.id))[0];
  expect(行).toMatchObject({ country: "德国" });
  expect(行).not.toHaveProperty("alibabaId");

  // 之后新版再改阿里 ID、再建一位、再记一条跟进：老库照样往下收，没卡在那一条上
  await 写外贸档案(新, 两样.id, { alibabaId: "de03" });
  const 第三 = await 新.customer.create({ data: { name: "Initech", phone: "13900009100", salesOwnerId: 管理员.id } });
  await 新.followUp.create({ data: { customerId: 第三.id, ownerId: 管理员.id, type: "CALL", title: "", content: "问报价" } });
  await 回放(旧, await 推(新, "N", 史), "O");
  expect((await 没同步上(旧)).条数).toBe(0);
  expect(await 旧.followUp.count({ where: { customerId: 第三.id } })).toBe(1);

  // 升级：补列（迁移跑两遍，第二遍「列已存在」当预期跳过）→ 重装触发器 → 签名变了 → 从头重放补齐
  await 旧.$disconnect();
  跑迁移(旧库);
  跑迁移(旧库);
  const 升级后 = new PrismaClient({ datasourceUrl: `file:${旧库}?connection_limit=1` });
  开着.push(升级后);
  await 装触发器(升级后);
  expect(await 列们(升级后)).toContain("alibabaId");
  expect(await 本机结构签名(升级后)).not.toBe(签名前);
  for (const 包 of 史) await 回放(升级后, 包, "O");
  expect(await 升级后.customerExtra.findUniqueOrThrow({ where: { customerId: 只阿里.id } })).toMatchObject({ alibabaId: "ae01" });
  expect(await 升级后.customerExtra.findUniqueOrThrow({ where: { customerId: 两样.id } })).toMatchObject({ country: "德国", alibabaId: "de03" });
  expect((await 没同步上(升级后)).条数).toBe(0);
});

it("旧 → 新：老版本那台改国家、或者给同一位新建档案行（不带阿里 ID），新版这边的阿里 ID 不被冲掉", async () => {
  const 新 = await 开(拷库("new2"));
  const 旧库 = 拷库("old2");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  const 史: 改动[][] = [];

  const c = await 新.customer.create({ data: { name: "Hooli", phone: "", salesOwnerId: 管理员.id } });
  await 回放(旧, await 推(新, "N", 史), "O");
  await 写外贸档案(新, c.id, { alibabaId: "us77" }, false);
  await 老包写档案(旧, c.id, { country: "英国" });
  const 新包 = await 推(新, "N", 史);
  const 旧包 = await 推(旧, "O", 史);
  expect(旧包.find((x) => x.t === "CustomerExtra")?.r).not.toHaveProperty("alibabaId");
  await 回放(新, 旧包, "N");
  await 回放(旧, 新包, "O");
  expect(await 新.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "英国", alibabaId: "us77" });

  await 老包写档案(旧, c.id, { country: "爱尔兰" });
  await 回放(新, await 推(旧, "O", 史), "N");
  expect(await 新.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "爱尔兰", alibabaId: "us77" });
  expect((await 没同步上(新)).条数).toBe(0);
  expect((await 没同步上(旧)).条数).toBe(0);
});

it("手机伴侣新建只有阿里 ID 的客户（插入带全部列）：老版本电脑回放不报错，客户落下来；新版电脑连阿里 ID 一起落下", async () => {
  const 手机 = await import("@/lib/mobile/sync");
  const 库 = new 手机.内存库();
  const 状态 = 手机.新状态();
  const 钟 = { 钟: { name: "x" } };
  await 库.放({ t: "User", k: 管理员.id, r: { id: 管理员.id, name: 管理员.name }, ...钟 });
  await 库.放({ t: "Setting", k: "business", r: { key: "business", value: JSON.stringify({ template: "trade", currency: "USD" }) }, ...钟 });
  const 机 = { teamId: "t1", device: "m_phone", key: "", epoch: 0, keys: {}, userId: 管理员.id, 私钥: new Uint8Array() } as unknown as import("@/lib/mobile/sync").手机团队;
  const { id } = await 手机.新建客户(机, 库, 状态, { name: "Omar", alibabaId: "sa88" });
  const 包 = 拆(封(状态.待推, 钥匙), 钥匙) as 改动[];
  expect(包.find((x) => x.t === "CustomerExtra")?.r).toMatchObject({ alibabaId: "sa88", email: null });

  const 旧库 = 拷库("old3");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  await 回放(旧, 包, "O");
  expect((await 没同步上(旧)).条数).toBe(0);
  expect((await 旧.customer.findUniqueOrThrow({ where: { id } })).name).toBe("Omar");

  const 新 = await 开(拷库("new3"));
  await 回放(新, 包, "N");
  expect(await 新.customerExtra.findUniqueOrThrow({ where: { customerId: id } })).toMatchObject({ alibabaId: "sa88" });
  expect((await 没同步上(新)).条数).toBe(0);
});
