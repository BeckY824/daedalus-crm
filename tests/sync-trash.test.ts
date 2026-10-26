/**
 * 同步删掉的客户：老板那台自动留底、恢复（2026-10-26，0.46.28，lib/sync/trash.ts）。
 * 业务员在他那台删了客户，同步过来老板那台也跟着删——删之前老板那台留一份，30 天内能放回去，老板自己这两天录的不受影响。
 * 两份独立的库，和 sync-local.test.ts 一样走「推 → 加密 → 拉 → 回放」；甲 = 老板（回放时留底），乙 = 业务员。
 */
import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma";
import { 改身份, 建同步表, 装触发器, 记全量, 待推, 记已推, 回放 } from "@/lib/sync/local";
import { 封, 拆, 新钥匙 } from "@/lib/sync/crypto";
import { 列出回收站, 恢复回收站, 记设备主人, 有不认识的设备 } from "@/lib/sync/trash";
import { 列出每日备份, 列出备份里删了的, 从备份捞回 } from "@/lib/sync/trash-backup";

const 测试库 = path.resolve(__dirname, "../prisma/test.db");
const 模板账号 = [
  { id: "cmusc55660000dulko96ek8kr", email: "admin", name: "管理员", role: "ADMIN" },
  { id: "cmusc55680001dulki71dcsts", email: "zhangsan", name: "张三", role: "SALES" },
  { id: "cmusc55690002dulk1u0ifs17", email: "lisi", name: "李四", role: "SALES" },
];

let 目录: string;
const 开着: PrismaClient[] = [];
// 每台拷贝和桌面端正式库一样：1 个连接、WAL（Windows CI 防卡，见 sync-local.test.ts 开头）
async function 一台(名: string): Promise<PrismaClient> {
  const f = path.join(目录, `${名}.db`);
  fs.copyFileSync(测试库, f);
  if (fs.existsSync(`${测试库}-wal`)) fs.copyFileSync(`${测试库}-wal`, `${f}-wal`);
  const db = new PrismaClient({ datasourceUrl: `file:${f}?connection_limit=1` });
  开着.push(db);
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await db.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  for (const t of ["AiConversation", "AiProject", "Setting", "AuditLog", "ImportBatch", "Task", "FollowPlan", "FollowUpSource", "FollowUp", "Contract", "Opportunity", "Contact", "UnassignedContact", "Lead", "CustomerMerge", "Attachment"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  }
  await db.$executeRawUnsafe('UPDATE "Customer" SET referrerCustomerId = NULL, attributionCustomerId = NULL');
  for (const t of ["Customer", "Channel", "Supplier", "User"]) await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  for (const u of 模板账号) await db.user.create({ data: { ...u, password: "x", title: "管理员", createdAt: new Date("2026-10-01T00:00:00Z") } });
  return db;
}
async function 进团队(db: PrismaClient, 账号: string, email: string, name: string) {
  await 改身份(db, `acct_${账号}`, { email, name });
  await 建同步表(db);
  await 装触发器(db);
  await 记全量(db);
}
const 钥匙 = 新钥匙();
async function 推(db: PrismaClient, 设备: string) {
  const { 改动: 批, 到 } = await 待推(db, 设备);
  if (!批.length) return null;
  await 记已推(db, 到);
  return 封(批, 钥匙);
}
/** 甲是老板：回放乙的改动时留底（client.ts 按 能管理团队 传） */
async function 同步(甲: PrismaClient, 乙: PrismaClient) {
  const a = await 推(甲, "A");
  const b = await 推(乙, "B");
  if (a) await 回放(乙, 拆(a, 钥匙), "B");
  if (b) await 回放(甲, 拆(b, 钥匙), "A", { 留底: true });
}
async function 一对() {
  const 甲 = await 一台("boss");
  const 乙 = await 一台("sales");
  await 进团队(甲, "jia", "jia@example.com", "老板");
  await 进团队(乙, "yi", "yi@example.com", "业务员");
  await 同步(甲, 乙);
  return { 甲, 乙 };
}
/** 乙录了一位客户：联系人、跟进、商机、签约都有 */
async function 乙录一位(乙: PrismaClient, id = "c1") {
  await 乙.customer.create({ data: { id, name: "离职前删的客户", phone: "13800000001", salesOwnerId: "acct_yi" } });
  await 乙.contact.create({ data: { id: `${id}-ct`, customerId: id, name: "王经理", phone: "13900000001", isPrimary: true } });
  await 乙.followUp.create({ data: { id: `${id}-f`, type: "PHONE", title: "", content: "聊了报价", status: "已完成", occurredAt: new Date("2026-10-20T08:00:00Z"), customerId: id, ownerId: "acct_yi" } });
  await 乙.opportunity.create({ data: { id: `${id}-o`, customerId: id, ownerId: "acct_yi", name: "年单" } });
  await 乙.contract.create({ data: { id: `${id}-k`, customerId: id, amount: 12000, signedAt: new Date("2026-10-21T08:00:00Z") } });
}
const 数一数 = async (db: PrismaClient, id = "c1") => ({
  客户: await db.customer.count({ where: { id } }),
  联系人: await db.contact.count({ where: { customerId: id } }),
  跟进: await db.followUp.count({ where: { customerId: id } }),
  商机: await db.opportunity.count({ where: { customerId: id } }),
  签约: await db.contract.count({ where: { customerId: id } }),
});
const 全有 = { 客户: 1, 联系人: 1, 跟进: 1, 商机: 1, 签约: 1 };

/** 商机下挂一张图：行在乙那台建、同步过来；文件放在老板这台的附件目录（真用时由附件同步拉下来） */
async function 挂附件(乙: PrismaClient, id = "att00001", oppId = "c1-o") {
  await 乙.attachment.create({ data: { id, opportunityId: oppId, name: "报价单.jpg", mime: "image/jpeg", size: 3, sha256: "x", userId: "acct_yi" } });
  fs.mkdirSync(path.join(数据目录, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(数据目录, "attachments", id), "jpg");
}
const 有文件 = (id = "att00001") => fs.existsSync(path.join(数据目录, "attachments", id));

let 数据目录: string;
const 原数据目录 = process.env.CRM_DATA_DIR;
beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-trash-"));
  数据目录 = path.join(目录, "boss-data");
  fs.mkdirSync(数据目录);
  process.env.CRM_DATA_DIR = 数据目录;
});
afterEach(async () => {
  if (原数据目录 === undefined) delete process.env.CRM_DATA_DIR; else process.env.CRM_DATA_DIR = 原数据目录;
  for (const db of 开着.splice(0)) await db.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it("业务员删了客户：老板那台留了底，恢复后连同子表回来，老板这两天录的不动；推出去业务员那台也回来", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 甲.customer.create({ data: { id: "c0", name: "被他推荐来的", phone: "13800000000", salesOwnerId: "acct_jia" } });
  await 同步(甲, 乙);
  await 甲.customer.update({ where: { id: "c0" }, data: { referrerCustomerId: "c1" } });
  await 同步(甲, 乙);

  await 乙.customer.delete({ where: { id: "c1" } });
  await 同步(甲, 乙);
  expect(await 数一数(甲)).toEqual({ 客户: 0, 联系人: 0, 跟进: 0, 商机: 0, 签约: 0 });
  expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c0" } })).referrerCustomerId).toBeNull();

  // 老板这两天自己录的
  await 甲.customer.create({ data: { id: "c5", name: "老板新录的", phone: "13800000005", salesOwnerId: "acct_jia" } });
  await 甲.followUp.create({ data: { id: "f5", type: "PHONE", title: "", content: "老板的跟进", status: "已完成", occurredAt: new Date(), customerId: "c5", ownerId: "acct_jia" } });

  const 列 = await 列出回收站(甲);
  expect(列).toHaveLength(1);
  // 设备还没对上人：按客户原来的负责人认
  expect(列[0]).toMatchObject({ root: "c1", 名称: "离职前删的客户", 客户也删了: true, 条数: 5, 删的人: "acct_yi", 按负责人猜的: true, 客户还在: false });
  expect(await 有不认识的设备(甲)).toBe(true);
  await 记设备主人(甲, [{ device: "B", accountId: "yi" }]);
  expect(await 有不认识的设备(甲)).toBe(false);
  expect((await 列出回收站(甲))[0]).toMatchObject({ 删的人: "acct_yi", 按负责人猜的: false });

  const r = await 恢复回收站(甲, ["c1"]);
  expect(r).toMatchObject({ 插回: 5, 跳过: 0, 客户们: ["c1"] });
  expect(await 数一数(甲)).toEqual(全有);
  expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c1" } })).lastFollowAt).toEqual(new Date("2026-10-20T08:00:00Z"));
  expect((await 甲.contract.findUniqueOrThrow({ where: { id: "c1-k" } })).amount.toString()).toBe("12000");
  expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c0" } })).referrerCustomerId).toBe("c1");
  expect(await 甲.followUp.count({ where: { customerId: "c5" } })).toBe(1);
  expect(await 列出回收站(甲)).toEqual([]);
  expect(await 甲.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);

  // 插回不在「回放中」：进了日志，推出去业务员那台也回来（比当初那条删除晚）
  await 同步(甲, 乙);
  expect(await 数一数(乙)).toEqual(全有);
  expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c0" } })).referrerCustomerId).toBe("c1");
  expect(await 乙.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
});

it("只在老板那台留底：业务员那台回放老板的删除不存", async () => {
  const { 甲, 乙 } = await 一对();
  await 甲.customer.create({ data: { id: "c2", name: "老板删的", phone: "13800000002", salesOwnerId: "acct_jia" } });
  await 同步(甲, 乙);
  await 甲.customer.delete({ where: { id: "c2" } });
  await 同步(甲, 乙);
  expect(await 乙.customer.count({ where: { id: "c2" } })).toBe(0);
  expect(await 列出回收站(乙)).toEqual([]);
  expect(await 列出回收站(甲)).toEqual([]); // 老板自己删的不进（不是同步来的删除）
});

it("合并掉的客户不进回收站（内容已经并到留下的那位）", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙, "c1");
  await 乙.customer.create({ data: { id: "c2", name: "留下的那位", phone: "13800000002", salesOwnerId: "acct_yi" } });
  await 同步(甲, 乙);
  await 乙.$transaction(async (tx) => {
    await tx.customerMerge.create({ data: { id: "c1", fromId: "c1", intoId: "c2", fromName: "离职前删的客户", userId: "acct_yi" } });
    for (const t of ["contact", "followUp", "opportunity", "contract"] as const) {
      await (tx[t] as unknown as { updateMany: (a: unknown) => Promise<unknown> }).updateMany({ where: { customerId: "c1" }, data: { customerId: "c2" } });
    }
    await tx.customer.delete({ where: { id: "c1" } });
  });
  await 同步(甲, 乙);
  expect(await 甲.customer.count({ where: { id: "c1" } })).toBe(0);
  expect(await 数一数(甲, "c2")).toEqual(全有);
  expect(await 列出回收站(甲)).toEqual([]);
});

it("只删了客户下面的一条：列出来是「只删了下面几条」；本机已有同 id 的不盖", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 同步(甲, 乙);
  await 乙.followUp.delete({ where: { id: "c1-f" } });
  await 乙.contact.delete({ where: { id: "c1-ct" } });
  await 同步(甲, 乙);
  expect(await 列出回收站(甲)).toMatchObject([{ root: "c1", 客户也删了: false, 条数: 2, 客户还在: true }]);
  // 老板在这期间按同一个 id 又有了这位联系人（别的途径）：恢复不盖他的
  await 甲.contact.create({ data: { id: "c1-ct", customerId: "c1", name: "老板改过的名字", phone: "13900000009" } });
  expect(await 恢复回收站(甲, ["c1"])).toMatchObject({ 插回: 1, 跳过: 1 });
  expect((await 甲.contact.findUniqueOrThrow({ where: { id: "c1-ct" } })).name).toBe("老板改过的名字");
  expect(await 甲.followUp.count({ where: { id: "c1-f" } })).toBe(1);
});

it("业务员删客户的同时老板给他记了跟进：老板那条也跟着留底，恢复后回来", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 同步(甲, 乙);
  await 乙.customer.delete({ where: { id: "c1" } });
  await 甲.followUp.create({ data: { id: "f-boss", type: "PHONE", title: "", content: "老板也打过电话", status: "已完成", occurredAt: new Date("2026-10-25T08:00:00Z"), customerId: "c1", ownerId: "acct_jia" } });
  await 同步(甲, 乙);
  expect(await 甲.customer.count({ where: { id: "c1" } })).toBe(0);
  expect(await 甲.followUp.count({ where: { id: "f-boss" } })).toBe(0);
  await 恢复回收站(甲, ["c1"]);
  expect(await 甲.followUp.findUniqueOrThrow({ where: { id: "f-boss" } })).toMatchObject({ content: "老板也打过电话" });
  expect((await 甲.customer.findUniqueOrThrow({ where: { id: "c1" } })).lastFollowAt).toEqual(new Date("2026-10-25T08:00:00Z"));
  await 同步(甲, 乙);
  expect(await 乙.followUp.count({ where: { customerId: "c1" } })).toBe(2);
});

it("删客户时联系人搬进了「未归属」：放回去以后未归属里那份去掉，两台都一样", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 同步(甲, 乙);
  await 乙.$transaction(async (tx) => {
    await tx.unassignedContact.create({ data: { id: "u1", name: "王经理", phone: "13900000001", fromCustomerId: "c1", fromCustomerName: "离职前删的客户", ownerId: "acct_yi" } });
    await tx.unassignedContact.create({ data: { id: "u2", name: "别人", phone: "13900000002", fromCustomerId: "c1", fromCustomerName: "离职前删的客户", ownerId: "acct_yi" } });
    await tx.customer.delete({ where: { id: "c1" } });
  });
  await 同步(甲, 乙);
  expect(await 甲.unassignedContact.count()).toBe(2);
  await 恢复回收站(甲, ["c1"]);
  expect((await 甲.unassignedContact.findMany()).map((u) => u.id)).toEqual(["u2"]);
  await 同步(甲, 乙);
  expect((await 乙.unassignedContact.findMany()).map((u) => u.id)).toEqual(["u2"]);
  expect(await 数一数(乙)).toEqual(全有);
});

it("留 30 天：更早的不列、顺手清掉", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 同步(甲, 乙);
  await 乙.customer.delete({ where: { id: "c1" } });
  await 同步(甲, 乙);
  expect(await 列出回收站(甲)).toHaveLength(1);
  await 甲.$executeRawUnsafe("UPDATE _sync_trash SET at = ?", Date.now() - 31 * 86_400_000);
  expect(await 列出回收站(甲)).toEqual([]);
  expect(await 甲.$queryRawUnsafe<unknown[]>("SELECT 1 FROM _sync_trash")).toEqual([]);
});

it("商机下的附件也留底：父行没了的附件过一天连文件清掉，恢复时行和文件都回来", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 挂附件(乙);
  await 同步(甲, 乙);
  expect(await 甲.attachment.count()).toBe(1);
  await 乙.customer.delete({ where: { id: "c1" } });
  await 同步(甲, 乙);
  expect((await 列出回收站(甲))[0]).toMatchObject({ root: "c1", 条数: 6 });
  // 清孤儿（附件没有外键，删客户不会连带删）：过一天连行带文件删掉，删行也同步过来
  await 乙.attachment.delete({ where: { id: "att00001" } });
  await 同步(甲, 乙);
  fs.rmSync(path.join(数据目录, "attachments", "att00001"));
  expect(await 甲.attachment.count()).toBe(0);

  expect(await 恢复回收站(甲, ["c1"])).toMatchObject({ 插回: 6, 客户们: ["c1"] });
  expect(await 甲.attachment.findUniqueOrThrow({ where: { id: "att00001" } })).toMatchObject({ opportunityId: "c1-o", name: "报价单.jpg" });
  expect(有文件()).toBe(true);
  await 同步(甲, 乙);
  expect(await 乙.attachment.count({ where: { opportunityId: "c1-o" } })).toBe(1);
});

/* ---------- 从某天的自动备份里只捞回被删掉的（lib/sync/trash-backup.ts）：回收站没留到的（这一版以前删的、过了 30 天的） ---------- */

/** 老板这台那天的自动备份：和 desktop/auto-backup.js 一样 VACUUM INTO，附件文件硬链进附件池 */
async function 备一份(db: PrismaClient, 日期: string) {
  const 目 = path.join(数据目录, "backups");
  fs.mkdirSync(path.join(目, "attachments"), { recursive: true });
  await db.$executeRawUnsafe(`VACUUM INTO '${path.join(目, `daily-${日期}.db`).replace(/'/g, "''")}'`);
  const 附 = path.join(数据目录, "attachments");
  if (fs.existsSync(附)) for (const f of fs.readdirSync(附)) if (!fs.existsSync(path.join(目, "attachments", f))) fs.linkSync(path.join(附, f), path.join(目, "attachments", f));
  return `daily-${日期}.db`;
}

it("从前天的备份只捞回被删的客户：老板这两天录的、改的都不动；推荐人接回；附件文件从附件池补；推出去全队都回来", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙);
  await 挂附件(乙);
  await 甲.customer.create({ data: { id: "c0", name: "被他推荐来的", phone: "13800000000", salesOwnerId: "acct_jia" } });
  await 同步(甲, 乙);
  await 甲.customer.update({ where: { id: "c0" }, data: { referrerCustomerId: "c1" } });
  await 同步(甲, 乙);
  const 文件 = await 备一份(甲, "2026-10-24");

  await 乙.customer.delete({ where: { id: "c1" } });
  await 乙.attachment.delete({ where: { id: "att00001" } });
  await 同步(甲, 乙);
  // 当作回收站没留到：清掉，附件文件也已经清孤儿删了
  await 甲.$executeRawUnsafe("DELETE FROM _sync_trash");
  fs.rmSync(path.join(数据目录, "attachments", "att00001"));
  fs.rmSync(path.join(数据目录, "attachments-trash"), { recursive: true, force: true });
  // 老板这两天自己的
  await 甲.customer.create({ data: { id: "c5", name: "老板新录的", phone: "13800000005", salesOwnerId: "acct_jia" } });
  await 甲.customer.update({ where: { id: "c0" }, data: { name: "老板改过名" } });

  expect(列出每日备份()).toEqual([{ 文件, 日期: "2026-10-24" }]);
  const 列 = await 列出备份里删了的(甲, 文件);
  expect(列).toHaveLength(1);
  expect(列[0]).toMatchObject({ id: "c1", 名称: "离职前删的客户", 条数: 5, 删的人: "acct_yi", 按负责人猜的: true });
  expect(列[0].删的时间).not.toBeNull();
  await 记设备主人(甲, [{ device: "B", accountId: "yi" }]);
  expect((await 列出备份里删了的(甲, 文件))[0]).toMatchObject({ 删的人: "acct_yi", 按负责人猜的: false });

  const r = await 从备份捞回(甲, 文件, ["c1"]);
  expect(r).toMatchObject({ 插回: 6, 跳过: 0, 客户们: ["c1"], 附件补了: 1 });
  expect(await 数一数(甲)).toEqual(全有);
  expect(有文件()).toBe(true);
  expect(await 甲.customer.findUniqueOrThrow({ where: { id: "c0" } })).toMatchObject({ name: "老板改过名", referrerCustomerId: "c1" });
  expect(await 甲.customer.count({ where: { id: "c5" } })).toBe(1);
  expect(await 甲.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check")).toEqual([]);
  expect(await 列出备份里删了的(甲, 文件)).toEqual([]);

  await 同步(甲, 乙);
  expect(await 数一数(乙)).toEqual(全有);
  expect(await 乙.attachment.count({ where: { opportunityId: "c1-o" } })).toBe(1);
  expect((await 乙.customer.findUniqueOrThrow({ where: { id: "c0" } })).referrerCustomerId).toBe("c1");
});

it("备份里合并掉的不列也不捞；文件名只认每天那几份", async () => {
  const { 甲, 乙 } = await 一对();
  await 乙录一位(乙, "c1");
  await 乙.customer.create({ data: { id: "c2", name: "留下的那位", phone: "13800000002", salesOwnerId: "acct_yi" } });
  await 同步(甲, 乙);
  const 文件 = await 备一份(甲, "2026-10-24");
  await 乙.$transaction(async (tx) => {
    await tx.customerMerge.create({ data: { id: "c1", fromId: "c1", intoId: "c2", fromName: "离职前删的客户", userId: "acct_yi" } });
    for (const t of ["contact", "followUp", "opportunity", "contract"] as const) {
      await (tx[t] as unknown as { updateMany: (a: unknown) => Promise<unknown> }).updateMany({ where: { customerId: "c1" }, data: { customerId: "c2" } });
    }
    await tx.customer.delete({ where: { id: "c1" } });
  });
  await 同步(甲, 乙);
  expect(await 列出备份里删了的(甲, 文件)).toEqual([]);
  expect(await 从备份捞回(甲, 文件, ["c1"])).toMatchObject({ 插回: 0 });
  expect(await 甲.customer.count({ where: { id: "c1" } })).toBe(0);
  await expect(列出备份里删了的(甲, "../boss.db")).rejects.toThrow("找不到这份备份");
  await expect(列出备份里删了的(甲, "daily-2026-10-01.db")).rejects.toThrow("找不到这份备份");
});
