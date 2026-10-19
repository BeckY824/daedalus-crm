/**
 * 团队版按时长开通（lib/team-pricing.ts + lib/tenant/team-plan.ts，2026-10-15）。
 *   - 到期日：按日历加月（1-31 加一个月是 2 月底）、落在北京时间那天结束；没到期顺延，过期 / 从没开通 / 原来不限期从今天算
 *   - 应收按分四舍五入（29.9 × 3 = 89.7，不是 89.69999…）
 *   - 到期 = 暂停同步：推、拉、范围同步都回 402「已到期」；续费后自动恢复；停用同一道闸
 *   - 10-15 之前开通的老团队没有到期日 = 不限期，升级后照常同步
 *   - 每次开通、续费、改到期、停用都留记录（谁、时长、人数、实收、前后到期日、备注）
 *   - 价格表：没改过用默认，改了存库、桌面端读到新价；乱填不收
 *   - 运营通知：3 天内到期报「快到期」，过了报「已到期」，停用的不报
 *   - 席位（2026-10-19 用户拍板「要拦」）：运营台填的人数就是上限（含老板）；满了新成员入队、被移出的人重新加入都拦，
 *     本人加设备只在人数已经超过上限时拦；运营台「改人数」马上生效；没设人数的老团队不拦
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 封, 设备钥匙对 } from "@/lib/sync/crypto";
import { 加月, 新到期日, 剩几天, 应收, 北京日期, 解析日期, 当天结束, 同步闸, 人满话 } from "@/lib/team-pricing";

const 临时根 = path.join(os.tmpdir(), `crm-team-plan-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.SYNC_DIR = path.join(临时根, "sync");
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", "const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs'); const db = new DatabaseSync(process.argv[1]); db.exec(fs.readFileSync(process.argv[2], 'utf8')); db.close();", path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  delete process.env.SYNC_DIR;
  await closeTestDatabases(临时根);
  fs.rmSync(临时根, { recursive: true, force: true });
});

const 钥 = "A".repeat(43);
const 包 = 封(["一"], 钥, 0);
const 天 = 86_400_000;

let n = 0;
async function 账号(名: string) {
  const { control } = await import("@/lib/tenant/control");
  return (await control.account.create({ data: { email: `${名}${n++}@plan.test`, password: "x", name: 名 } })).id;
}
async function 团队(名: string) {
  const r = await import("@/lib/tenant/sync-relay");
  const 甲 = await 账号("老板"), 乙 = await 账号("业务员");
  const t = await r.建团队(甲, 名);
  if (!t.ok) throw new Error(t.error);
  await r.入队(乙, t.teamId, t.joinSecret);
  return { 甲, 乙, teamId: t.teamId };
}

describe("到期日的算法（不碰库）", () => {
  it("按日历加月：1-31 加一个月是 2 月底，闰年 2-29；跨年不乱", () => {
    expect(北京日期(加月(new Date("2027-01-31T10:00:00+08:00"), 1))).toBe("2027-02-28");
    expect(北京日期(加月(new Date("2028-01-31T10:00:00+08:00"), 1))).toBe("2028-02-29");
    expect(北京日期(加月(new Date("2026-11-15T10:00:00+08:00"), 3))).toBe("2027-02-15");
    expect(北京日期(加月(new Date("2026-10-15T10:00:00+08:00"), 12))).toBe("2027-10-15");
    // 北京时间凌晨（UTC 还是前一天）按北京的日子算
    expect(北京日期(加月(new Date("2026-10-31T01:00:00+08:00"), 1))).toBe("2026-11-30");
  });

  it("新到期日：没到期从原到期日顺延；过期、从没开通、不限期从今天算；都落在北京时间那天结束", () => {
    const now = new Date("2026-10-15T09:00:00Z"); // 北京 17:00
    const 一月后 = 新到期日(null, { months: 1 }, now);
    expect(北京日期(一月后)).toBe("2026-11-15");
    expect(一月后.toISOString()).toBe("2026-11-15T15:59:59.999Z"); // 北京 23:59:59.999
    // 还没到期：在原到期日上加，不吃掉已付的天数
    expect(北京日期(新到期日(当天结束(new Date("2026-11-01T12:00:00+08:00")), { months: 3 }, now))).toBe("2027-02-01");
    // 已经过期：从今天算
    expect(北京日期(新到期日(new Date("2026-10-01T12:00:00+08:00"), { months: 1 }, now))).toBe("2026-11-15");
    // 试用按天
    expect(北京日期(新到期日(null, { days: 14 }, now))).toBe("2026-10-29");
  });

  it("剩几天按北京日期：今天到期 0、明天 1、昨天 -1", () => {
    const now = new Date("2026-10-15T23:30:00+08:00");
    expect(剩几天(当天结束(now), now)).toBe(0);
    expect(剩几天(当天结束(new Date(now.getTime() + 天)), now)).toBe(1);
    expect(剩几天(当天结束(new Date(now.getTime() - 天)), now)).toBe(-1);
  });

  it("应收按分四舍五入；解析日期认 YYYY-MM-DD、不认 2 月 30", () => {
    expect(应收(29.9, 3)).toBe(89.7);
    expect(应收(84.9, 7)).toBe(594.3);
    expect(应收(159, 2)).toBe(318);
    expect(北京日期(解析日期("2026-12-31")!)).toBe("2026-12-31");
    expect(解析日期("2026-02-30")).toBeNull();
    expect(解析日期("12/31/2026")).toBeNull();
  });

  it("同步闸：没开通、到期各一句；没有到期日 = 不限期", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    expect(同步闸({ active: false }, null, now)).toBe("团队同步还没开通");
    expect(同步闸({ active: true }, null, now)).toBeNull();
    expect(同步闸({ active: true }, { paidUntil: null }, now)).toBeNull();
    expect(同步闸({ active: true }, { paidUntil: new Date(now.getTime() + 1000) }, now)).toBeNull();
    expect(同步闸({ active: true }, { paidUntil: new Date("2026-10-14T15:59:59.999Z") }, now)).toMatch(/^团队同步已到期（2026-10-14）.*续费后自动恢复/);
  });
});

describe("开通 / 续费 / 到期暂停", () => {
  it("开通 3 个月：写到期日和席位、打开同步、留记录；到期后推拉都停，续费后恢复", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const { control } = await import("@/lib/tenant/control");
    const { 甲, 乙, teamId } = await 团队("按时长开通");
    expect(await r.收推送(甲, teamId, "dev-A", 包)).toEqual({ ok: false, 状态: 402, error: "团队同步还没开通" });

    const 开 = await p.开通续费({ teamId, 时长: { months: 3 }, seats: 2, amount: 169.8, note: "微信转账", by: "ops@x.com" });
    expect(开.ok).toBe(true);
    const 计划 = await control.syncTeamPlan.findUniqueOrThrow({ where: { teamId } });
    expect(计划.seats).toBe(2);
    expect(p.剩几天(计划.paidUntil!)).toBeGreaterThanOrEqual(89);
    expect((await control.syncTeam.findUniqueOrThrow({ where: { id: teamId } })).active).toBe(true);
    expect((await r.收推送(甲, teamId, "dev-A", 包)).ok).toBe(true);
    expect((await r.给拉取(乙, teamId, 0)).ok).toBe(true);
    const [记] = await control.syncTeamPlanLog.findMany({ where: { teamId } });
    expect(记).toMatchObject({ kind: "开通", by: "ops@x.com", months: 3, seats: 2, amount: 169.8, before: null, note: "微信转账" });
    expect(记.after?.getTime()).toBe(计划.paidUntil!.getTime());

    // 桌面端看得到到期日、还剩几天、席位
    const [我看] = await r.我的团队(乙);
    expect(我看).toMatchObject({ active: true, paidUntil: p.北京日期(计划.paidUntil!), seats: 2 });
    expect(我看).not.toHaveProperty("expired");

    // 到期了（运营台把到期日改到昨天）：推、拉都回 402「已到期」，本机数据不归我们管
    const 昨天 = p.北京日期(new Date(Date.now() - 天));
    expect((await p.改到期({ teamId, paidUntil: p.解析日期(昨天), note: "测到期", by: "ops@x.com" })).ok).toBe(true);
    const 推 = await r.收推送(甲, teamId, "dev-A", 包);
    expect(推).toMatchObject({ ok: false, 状态: 402 });
    expect(!推.ok && 推.error).toContain(`团队同步已到期（${昨天}）`);
    expect(await r.给拉取(乙, teamId, 0)).toMatchObject({ ok: false, 状态: 402 });
    // 老版本桌面端只认 active：到期回 false，不再显示「同步中」；新版本看 expired
    const [到期看] = await r.我的团队(乙);
    expect(到期看).toMatchObject({ active: false, expired: true, paidUntil: 昨天 });

    // 续费 1 个月：已经过期，从今天算；同步自动恢复，不用再点开通
    const 续 = await p.开通续费({ teamId, 时长: { months: 1 }, seats: 3, amount: 89.7, by: "ops@x.com" });
    expect(续.ok && p.北京日期(续.paidUntil!)).toBe(p.北京日期(p.新到期日(null, { months: 1 })));
    expect((await r.收推送(甲, teamId, "dev-A", 包)).ok).toBe(true);
    const 记录 = await control.syncTeamPlanLog.findMany({ where: { teamId }, orderBy: { at: "asc" } });
    expect(记录.map((x) => x.kind)).toEqual(["开通", "改到期", "续费"]);
    expect(记录[2]).toMatchObject({ months: 1, seats: 3, amount: 89.7 });
  });

  it("还没到期续费：从原到期日往后顺延", async () => {
    const p = await import("@/lib/tenant/team-plan");
    const { teamId } = await 团队("顺延");
    const 一 = await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    const 二 = await p.开通续费({ teamId, 时长: { months: 6 }, seats: 1, amount: 159, by: "口令" });
    if (!一.ok || !二.ok) throw new Error("开通失败");
    expect(p.北京日期(二.paidUntil!)).toBe(p.北京日期(p.加月(一.paidUntil!, 6)));
  });

  it("老团队（10-15 之前开通、没有到期日）升级后照常同步；运营台第一次设时长从今天算", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const { 甲, teamId } = await 团队("Liu Exim Limited 那样的老团队");
    await r.设开通(teamId, true); // 老办法开通：只有开关、没有到期日
    expect((await r.收推送(甲, teamId, "dev-A", 包)).ok).toBe(true);
    const [看] = await r.我的团队(甲);
    expect(看.active).toBe(true);
    expect(看).not.toHaveProperty("paidUntil");
    const 开 = await p.开通续费({ teamId, 时长: { months: 12 }, seats: 2, amount: 598, by: "口令" });
    expect(开.ok && p.北京日期(开.paidUntil!)).toBe(p.北京日期(p.新到期日(null, { months: 12 })));
    const { control } = await import("@/lib/tenant/control");
    expect((await control.syncTeamPlanLog.findFirstOrThrow({ where: { teamId } })).kind).toBe("续费");
  });

  it("停用和到期同一道闸：停用后不收推送；到期日不动，再开通 / 续费照常顺延", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const { control } = await import("@/lib/tenant/control");
    const { 甲, teamId } = await 团队("停用");
    const 开 = await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    expect((await p.停用({ teamId, by: "口令", note: "客户要求" })).ok).toBe(true);
    expect(await r.收推送(甲, teamId, "dev-A", 包)).toEqual({ ok: false, 状态: 402, error: "团队同步还没开通" });
    expect((await control.syncTeamPlan.findUniqueOrThrow({ where: { teamId } })).paidUntil?.getTime()).toBe(开.ok ? 开.paidUntil!.getTime() : 0);
    const 再 = await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    expect(再.ok && p.北京日期(再.paidUntil!)).toBe(开.ok ? p.北京日期(p.加月(开.paidUntil!, 1)) : "");
    expect((await r.收推送(甲, teamId, "dev-A", 包)).ok).toBe(true);
    expect((await control.syncTeamPlanLog.findMany({ where: { teamId }, orderBy: { at: "asc" } })).map((x) => x.kind)).toEqual(["开通", "停用", "续费"]);
  });

  it("试用：按天、不记金额；改到期日可以清成不限期，不动开通状态", async () => {
    const p = await import("@/lib/tenant/team-plan");
    const { control } = await import("@/lib/tenant/control");
    const { teamId } = await 团队("试用");
    const 试 = await p.开通续费({ teamId, 时长: { days: 14 }, seats: 2, amount: null, by: "口令" });
    expect(试.ok && p.剩几天(试.paidUntil!)).toBe(14);
    expect(await control.syncTeamPlanLog.findFirstOrThrow({ where: { teamId } })).toMatchObject({ kind: "试用", days: 14, amount: null });
    expect((await p.改到期({ teamId, paidUntil: null, by: "口令" })).ok).toBe(true);
    expect((await control.syncTeamPlan.findUniqueOrThrow({ where: { teamId } })).paidUntil).toBeNull();
    expect((await control.syncTeam.findUniqueOrThrow({ where: { id: teamId } })).active).toBe(true);
  });

  it("乱填的不收：时长、人数、金额、团队", async () => {
    const p = await import("@/lib/tenant/team-plan");
    const { teamId } = await 团队("乱填");
    expect(await p.开通续费({ teamId, 时长: { months: 2 }, seats: 1, amount: 1, by: "口令" })).toEqual({ ok: false, error: "时长不对" });
    expect(await p.开通续费({ teamId, 时长: { days: 0 }, seats: 1, amount: null, by: "口令" })).toEqual({ ok: false, error: "时长不对" });
    expect((await p.开通续费({ teamId, 时长: { months: 1 }, seats: 0, amount: 1, by: "口令" })).ok).toBe(false);
    expect((await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1.5, amount: 1, by: "口令" })).ok).toBe(false);
    expect((await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1, amount: 29.999, by: "口令" })).ok).toBe(false);
    expect((await p.开通续费({ teamId, 时长: { months: 1 }, seats: 1, amount: -1, by: "口令" })).ok).toBe(false);
    expect(await p.开通续费({ teamId: "没有这个团队", 时长: { months: 1 }, seats: 1, amount: 1, by: "口令" })).toEqual({ ok: false, error: "团队不存在" });
  });

  it("范围同步也过这一道闸：到期后状态、目录都回 402", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const scoped = await import("@/lib/tenant/sync-scoped");
    const 甲 = await 账号("范围老板");
    const t = await r.建团队(甲, "范围到期", { device: "dScope01", pubKey: 设备钥匙对().公钥 });
    if (!t.ok) throw new Error(t.error);
    await p.开通续费({ teamId: t.teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    await expect(scoped.范围状态(甲, t.teamId)).resolves.toMatchObject({ owner: true });
    await p.改到期({ teamId: t.teamId, paidUntil: new Date(Date.now() - 1000), by: "口令" });
    await expect(scoped.范围状态(甲, t.teamId)).rejects.toMatchObject({ 状态: 402, message: expect.stringContaining("团队同步已到期") });
    await expect(scoped.范围目录(甲, t.teamId)).rejects.toMatchObject({ 状态: 402 });
  });
});

describe("席位：满了要拦（2026-10-19）", () => {
  const 机 = () => ({ device: `d${Math.random().toString(36).slice(2, 10)}`, pubKey: 设备钥匙对().公钥 });

  /** 手机申请 + 挑战核过，直接走到「允许」那一步（挑战的封 / 解在 mobile-link.test.ts 里测过） */
  async function 批一台手机(accountId: string, teamId: string, 批的设备: string) {
    const { control } = await import("@/lib/tenant/control");
    const link = await import("@/lib/tenant/mobile-link");
    const nonce = `n${n++}`;
    const r = await control.syncMobileLink.create({
      data: { accountId, tokenId: `tk${n++}`, device: `m_${Math.random().toString(36).slice(2, 10)}`, pubKey: 设备钥匙对().公钥, label: "手机", status: "pending",
        proofHash: createHash("sha256").update(nonce).digest("hex"), proofDevice: 批的设备, proofAt: new Date() },
    });
    return link.允许(accountId, r.id, teamId, "封好的", nonce);
  }

  it("运营台开 2 人：老板 + 1 位满了，第三个人拿邀请码进不来，提示人满；改成 3 人马上能进", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const 老板 = await 账号("席位老板"), 李 = await 账号("李"), 赵 = await 账号("赵");
    const t = await r.建团队(老板, "两人团", 机());
    if (!t.ok) throw new Error(t.error);
    await p.开通续费({ teamId: t.teamId, 时长: { months: 1 }, seats: 2, amount: 59.8, by: "口令" });
    expect((await r.入队(李, t.teamId, t.joinSecret, 机())).ok).toBe(true);
    expect(await r.入队(赵, t.teamId, t.joinSecret, 机())).toEqual({ ok: false, 状态: 409, error: 人满话(2) });
    expect(人满话(2)).toBe("团队人数已满（2 人），要加人请私信我们");
    // 已经在队里的人拿邀请码再连一台电脑：不占人数，不拦
    expect((await r.入队(李, t.teamId, t.joinSecret, 机())).ok).toBe(true);

    expect(await p.改人数({ teamId: t.teamId, seats: 3, by: "口令" })).toEqual({ ok: true });
    expect((await r.入队(赵, t.teamId, t.joinSecret, 机())).ok).toBe(true);
    const { control } = await import("@/lib/tenant/control");
    expect(await control.syncTeamPlanLog.findFirstOrThrow({ where: { teamId: t.teamId, kind: "改人数" } })).toMatchObject({ seats: 3, note: "原来 2 人" });
    // 改人数不动到期日
    const 计划 = await control.syncTeamPlan.findUniqueOrThrow({ where: { teamId: t.teamId } });
    expect(北京日期(计划.paidUntil!)).toBe(北京日期(新到期日(null, { months: 1 })));
    expect((await p.改人数({ teamId: t.teamId, seats: 0, by: "口令" })).ok).toBe(false);
  });

  it("被移出的人满员时回不来；老板移出一位腾出位子后可以", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const 老板 = await 账号("席位老板"), 李 = await 账号("李"), 赵 = await 账号("赵");
    const t = await r.建团队(老板, "移出再回", 机());
    if (!t.ok) throw new Error(t.error);
    await p.开通续费({ teamId: t.teamId, 时长: { months: 1 }, seats: 2, amount: 59.8, by: "口令" });
    expect((await r.入队(李, t.teamId, t.joinSecret, 机())).ok).toBe(true);
    const 移 = await r.移除成员(老板, t.teamId, 李);
    if (!移.ok) throw new Error(移.error);
    expect((await r.入队(赵, t.teamId, 移.joinSecret, 机())).ok).toBe(true);
    // 李被移出、赵占了位子：李拿新邀请码也进不来
    expect(await r.入队(李, t.teamId, 移.joinSecret, 机())).toMatchObject({ ok: false, 状态: 409, error: 人满话(2) });
  });

  it("批准新设备：满员时本人加手机照常；人数已经超过上限（运营台改小了）就拦", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const 老板 = await 账号("席位老板"), 李 = await 账号("李"), 赵 = await 账号("赵");
    const 老板电脑 = 机(), 李电脑 = 机();
    const t = await r.建团队(老板, "批设备", 老板电脑);
    if (!t.ok) throw new Error(t.error);
    await p.开通续费({ teamId: t.teamId, 时长: { months: 1 }, seats: 3, amount: 89.7, by: "口令" });
    expect((await r.入队(李, t.teamId, t.joinSecret, 李电脑)).ok).toBe(true);
    expect((await r.入队(赵, t.teamId, t.joinSecret, 机())).ok).toBe(true);
    // 正好满：李在电脑上批自己的手机，不多占人
    expect(await 批一台手机(李, t.teamId, 李电脑.device)).toEqual({ ok: true });
    // 运营台改成 2 人（比现在的 3 人少）：已经在的人不踢，但新设备批不了
    expect((await p.改人数({ teamId: t.teamId, seats: 2, by: "口令" })).ok).toBe(true);
    expect(await 批一台手机(老板, t.teamId, 老板电脑.device)).toEqual({ ok: false, 状态: 409, error: 人满话(2) });
    expect(await p.席位闸(t.teamId, false)).toBe(人满话(2));
    expect(await p.席位闸(t.teamId, true)).toBe(人满话(2));
  });

  it("没设人数的老团队（10-19 之前开的）不拦", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const p = await import("@/lib/tenant/team-plan");
    const 老板 = await 账号("老团队");
    const t = await r.建团队(老板, "老团队", 机());
    if (!t.ok) throw new Error(t.error);
    await r.设开通(t.teamId, true);
    for (let i = 0; i < 4; i++) expect((await r.入队(await 账号("成员"), t.teamId, t.joinSecret, 机())).ok).toBe(true);
    expect(await p.席位闸(t.teamId, true)).toBeNull();
  });
});

describe("价格表", () => {
  it("没改过用默认价；改了存库、公开价格折算每月；乱填不收", async () => {
    const p = await import("@/lib/tenant/team-plan");
    expect(await p.读价格()).toEqual(p.默认价格);
    expect(await p.公开价格()).toEqual({
      prices: [
        { months: 1, label: "1 个月", perSeat: 29.9, perMonth: 29.9 },
        { months: 3, label: "3 个月", perSeat: 84.9, perMonth: 28.3 },
        { months: 6, label: "半年", perSeat: 159, perMonth: 26.5 },
        { months: 12, label: "1 年", perSeat: 299, perMonth: 24.9 },
      ],
      trialDays: 7,
    });
    expect(await p.存价格({ prices: [{ months: 1, perSeat: 19.9 }, { months: 3, perSeat: 55 }, { months: 6, perSeat: 100 }, { months: 12, perSeat: 188 }], trialDays: 7 }, "ops@x.com")).toBeNull();
    expect(await p.读价格()).toEqual({ prices: [{ months: 1, perSeat: 19.9 }, { months: 3, perSeat: 55 }, { months: 6, perSeat: 100 }, { months: 12, perSeat: 188 }], trialDays: 7 });
    expect(await p.存价格({ prices: [{ months: 1, perSeat: 19.9 }], trialDays: 7 }, "x")).toMatch(/3 个月/);
    expect(await p.存价格({ prices: p.默认价格.prices, trialDays: 100 }, "x")).toMatch(/试用天数/);
    expect(await p.存价格({ prices: [{ months: 1, perSeat: 1.234 }, ...p.默认价格.prices.slice(1)], trialDays: 7 }, "x")).toMatch(/1 个月/);
    // 还原，别影响别的用例
    expect(await p.存价格(p.默认价格, "ops@x.com")).toBeNull();
  });
});

describe("运营通知", () => {
  it("3 天内到期报「快到期」，过了报「已到期」；键带到期日；停用的不报", async () => {
    const p = await import("@/lib/tenant/team-plan");
    const { 读运营通知 } = await import("@/lib/ops-notices");
    const 快 = await 团队("快到期的团");
    const 过 = await 团队("刚到期的团");
    const 停 = await 团队("停用的团");
    await p.开通续费({ teamId: 快.teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    await p.改到期({ teamId: 快.teamId, paidUntil: new Date(Date.now() + 2 * 天), by: "口令" });
    await p.开通续费({ teamId: 过.teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    await p.改到期({ teamId: 过.teamId, paidUntil: new Date(Date.now() - 3600_000), by: "口令" });
    await p.开通续费({ teamId: 停.teamId, 时长: { months: 1 }, seats: 1, amount: 29.9, by: "口令" });
    await p.改到期({ teamId: 停.teamId, paidUntil: new Date(Date.now() + 天), by: "口令" });
    await p.停用({ teamId: 停.teamId, by: "口令" });
    const { 事件 } = await 读运营通知(new Date(Date.now() - 60_000).toISOString());
    const 这几个 = [快.teamId, 过.teamId, 停.teamId];
    const 到期 = 事件.filter((e) => e.key.startsWith("团队到期:") && 这几个.some((id) => e.key.includes(id)));
    expect(到期.map((e) => e.标题).sort()).toEqual(["团队已到期：刚到期的团", "团队快到期：快到期的团"]);
    expect(到期.every((e) => e.kind === "团队" && e.path === "/admin/sync")).toBe(true);
    expect(到期.find((e) => e.标题.includes("快到期"))!.key).toMatch(new RegExp(`^团队到期:将:${快.teamId}@\\d{4}-\\d{2}-\\d{2}$`));
  });
});
