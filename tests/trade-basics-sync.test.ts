/**
 * 外贸基础（2026-10-16）的两列新字段（CustomerExtra.level / website，迁移 037 / 038）走团队同步。
 * 总控要求：新字段要走团队版范围同步，老版本客户端连上不能报错，对老数据零影响。
 *
 *   新 ↔ 新：等级、官网同步过去；两台同时改同一位的不同格都留下
 *   新 → 旧：老版本那台的库里没有这两列——回放只写本机有的列，不报错、不进「没同步上」，别的格照常
 *   旧 → 新：老版本那台改国家、新建档案行（不带这两列），新版那边的等级、官网不被冲掉
 *   旧升级：补上两列、重装触发器、表结构签名变了 → 从头重放一遍就补齐（客户端据签名从头重拉，见 local.ts 本机结构签名）
 * 范围同步按 customerId 分人，这两列跟着客户档案那一行走，不需要另配（scope-policy.ts CustomerExtra）。
 *
 * 台子照 sync-local.test.ts：两份独立库，走「建表装触发器 → 推 → 加密 → 拉 → 回放」。
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

/**
 * 老版本（0.46.18 及以前）的库：没有 level / website 两列。拿当前测试库拷一份、把两列拆掉（SQLite 3.35+ 的 DROP COLUMN），
 * 和真老库的表结构一样
 */
function 拆成老库(f: string) {
  const d = new DatabaseSync(f);
  d.exec('DROP INDEX IF EXISTS "CustomerExtra_level_idx"');
  d.exec('ALTER TABLE "CustomerExtra" DROP COLUMN "level"');
  d.exec('ALTER TABLE "CustomerExtra" DROP COLUMN "website"');
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

/**
 * 老版本客户端写数据：它的 Prisma 不知道这两列，表里也没有——这里直接写 SQL，模拟老包的写法
 * （老包的 写外贸档案 只认五格）
 */
async function 老包写档案(db: PrismaClient, customerId: string, 格: { country?: string; whatsapp?: string }) {
  const 有 = (await db.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "CustomerExtra" WHERE "customerId" = ?', customerId)).length > 0;
  if (有) {
    for (const [k, v] of Object.entries(格)) await db.$executeRawUnsafe(`UPDATE "CustomerExtra" SET "${k}" = ? WHERE "customerId" = ?`, v, customerId);
  } else {
    await db.$executeRawUnsafe('INSERT INTO "CustomerExtra" ("customerId", "country", "whatsapp", "wechat", "email", "source") VALUES (?, ?, ?, NULL, NULL, NULL)', customerId, 格.country ?? null, 格.whatsapp ?? null);
  }
}

const 列们 = async (db: PrismaClient) => (await db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("CustomerExtra")')).map((c) => c.name);

beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-trade-basics-sync-"));
});
afterEach(async () => {
  for (const db of 开着.splice(0)) await db.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it("新 ↔ 新：等级、官网同步过去；两台同时改同一位的不同格（甲改等级、乙填官网）都留下", async () => {
  const a = await 开(拷库("A"));
  const b = await 开(拷库("B"));
  const 史: 改动[][] = [];
  const c = await a.customer.create({ data: { name: "Acme", phone: "", salesOwnerId: 管理员.id } });
  await 写外贸档案(a, c.id, { country: "美国", level: "B", website: "www.acme.com" }, false);
  await 回放(b, await 推(a, "A", 史), "B");
  expect(await b.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "美国", level: "B", website: "www.acme.com" });

  await 写外贸档案(a, c.id, { level: "A" });
  await 写外贸档案(b, c.id, { website: "https://acme.com" });
  const pa = await 推(a, "A", 史);
  const pb = await 推(b, "B", 史);
  await 回放(b, pa, "B");
  await 回放(a, pb, "A");
  for (const db of [a, b]) expect(await db.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ level: "A", website: "https://acme.com", country: "美国" });
  expect((await 没同步上(a)).条数).toBe(0);
  expect((await 没同步上(b)).条数).toBe(0);
});

it("新 → 旧 → 升级：老版本那台收到带新列的改动不报错、别的格照常；升级后签名一变，从头重放就补齐", async () => {
  const 新 = await 开(拷库("new"));
  const 旧库 = 拷库("old");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  expect(await 列们(旧)).not.toContain("level");
  const 签名前 = await 本机结构签名(旧);
  const 史: 改动[][] = [];

  const c = await 新.customer.create({ data: { name: "Globex", phone: "", salesOwnerId: 管理员.id } });
  await 写外贸档案(新, c.id, { country: "德国", whatsapp: "+49 151 2345678", level: "A", website: "globex.de" }, false);
  await 回放(旧, await 推(新, "N", 史), "O");
  // 老库那一行：有的格都在，新列没有这回事
  const 行 = (await 旧.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "CustomerExtra" WHERE "customerId" = ?', c.id))[0];
  expect(行).toMatchObject({ country: "德国", whatsapp: "+49 151 2345678" });
  expect(行).not.toHaveProperty("level");
  expect((await 没同步上(旧)).条数).toBe(0);
  expect((await 旧.customer.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("Globex");

  // 之后新版再改等级：老库照样收（没这一列就不写），不报错
  await 写外贸档案(新, c.id, { level: "C" });
  await 回放(旧, await 推(新, "N", 史), "O");
  expect((await 没同步上(旧)).条数).toBe(0);

  // 升级：补列 → 重装触发器 → 签名变了 → 客户端从头重拉（中转留着全部历史；回放按字段钟比，重放不会重复写）
  await 旧.$disconnect();
  跑迁移(旧库);
  跑迁移(旧库); // 每次启动都整个重跑，第二遍也得过
  const 升级后 = new PrismaClient({ datasourceUrl: `file:${旧库}?connection_limit=1` });
  开着.push(升级后);
  await 装触发器(升级后);
  expect(await 列们(升级后)).toEqual(expect.arrayContaining(["level", "website"]));
  expect(await 本机结构签名(升级后)).not.toBe(签名前);
  for (const 包 of 史) await 回放(升级后, 包, "O");
  expect(await 升级后.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "德国", level: "C", website: "globex.de" });
  expect((await 没同步上(升级后)).条数).toBe(0);
});

it("旧 → 新：老版本那台改国家、或者给同一位新建档案行（不带新列），新版这边的等级、官网不被冲掉", async () => {
  const 新 = await 开(拷库("new2"));
  const 旧库 = 拷库("old2");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  const 史: 改动[][] = [];

  // 两台都有这位客户（新版建的、同步过去）
  const c = await 新.customer.create({ data: { name: "Initech", phone: "", salesOwnerId: 管理员.id } });
  await 回放(旧, await 推(新, "N", 史), "O");
  // 两台各自给他建档案行：新版填等级和官网，老版填国家（老版的插入没有新列）
  await 写外贸档案(新, c.id, { level: "B", website: "initech.com" }, false);
  await 老包写档案(旧, c.id, { country: "英国" });
  const 新包 = await 推(新, "N", 史);
  const 旧包 = await 推(旧, "O", 史);
  expect(旧包.find((x) => x.t === "CustomerExtra")?.r).not.toHaveProperty("level");
  await 回放(新, 旧包, "N");
  await 回放(旧, 新包, "O");
  expect(await 新.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "英国", level: "B", website: "initech.com" });

  // 老版之后再改国家（一次更新）：新版的等级、官网照样在
  await 老包写档案(旧, c.id, { country: "爱尔兰" });
  await 回放(新, await 推(旧, "O", 史), "N");
  expect(await 新.customerExtra.findUniqueOrThrow({ where: { customerId: c.id } })).toMatchObject({ country: "爱尔兰", level: "B", website: "initech.com" });
  expect((await 没同步上(新)).条数).toBe(0);
  expect((await 没同步上(旧)).条数).toBe(0);
});

it("WhatsApp 跟进同步到老版本那台：存的就是 WHATSAPP，老版本界面按「其他记录」的样子显示（不报错）", async () => {
  const 新 = await 开(拷库("new3"));
  const 旧库 = 拷库("old3");
  拆成老库(旧库);
  const 旧 = await 开(旧库);
  const 史: 改动[][] = [];
  const c = await 新.customer.create({ data: { name: "Wa", phone: "", salesOwnerId: 管理员.id } });
  await 新.followUp.create({ data: { customerId: c.id, ownerId: 管理员.id, type: "WHATSAPP", title: "", content: "要目录" } });
  await 回放(旧, await 推(新, "N", 史), "O");
  expect((await 旧.followUp.findFirstOrThrow({ where: { customerId: c.id } })).type).toBe("WHATSAPP");
  expect((await 没同步上(旧)).条数).toBe(0);
});
