/**
 * 团队同步 · 中转（云端这一半，2026-10-03）。
 *   - 建团队回入队口令；口令不对 / 团队不存在说同一句；重复入队不出错；20 人上限
 *   - 没开通不收推送也不给拉；开通后按序号推拉；退队后推拉都不行，再入队恢复
 *   - 密文存成文件，库里只有元数据；文件没了跳过这一批不卡住
 *   - 接口：没有令牌 401，不是托管版 404
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { closeTestDatabases } from "./close-databases";
import { 封, 设备钥匙对 } from "@/lib/sync/crypto";

const 临时根 = path.join(os.tmpdir(), `crm-sync-relay-${process.pid}`);

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

/** 推送要读包头的钥匙编号：用真格式的包（内容随便，中转解不开也不解） */
const 钥 = "A".repeat(43);
const 包1 = 封(["一"], 钥, 0), 包2 = 封(["二"], 钥, 0);

let n = 0;
async function 账号(名: string) {
  const { control } = await import("@/lib/tenant/control");
  return (await control.account.create({ data: { email: `${名}${n++}@x.com`, password: "x", name: 名 } })).id;
}

describe("中转", () => {
  it("建团队、入队（口令不对和团队不存在说同一句）、看成员", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const 甲 = await 账号("甲"), 乙 = await 账号("乙"), 丙 = await 账号("丙");
    const t = await r.建团队(甲, "明亮贸易");
    if (!t.ok) throw new Error(t.error);
    expect(await r.入队(乙, t.teamId, "错的")).toEqual({ ok: false, 状态: 403, error: "邀请码不对或已经作废了，找老板要一个新的" });
    expect(await r.入队(乙, "不存在的团队", t.joinSecret)).toEqual({ ok: false, 状态: 403, error: "邀请码不对或已经作废了，找老板要一个新的" });
    expect(await r.入队(乙, t.teamId, t.joinSecret)).toEqual({ ok: true, teamName: "明亮贸易", active: false, epoch: 0 });
    expect((await r.入队(乙, t.teamId, t.joinSecret)).ok).toBe(true);
    const [团] = await r.我的团队(乙);
    expect(团).toMatchObject({ name: "明亮贸易", active: false, 我是建的人: false });
    expect(团.成员.map((m) => [m.name, m.role])).toEqual([["甲", "owner"], ["乙", "member"]]);
    expect(await r.我的团队(丙)).toEqual([]);
    expect((await r.建团队(甲, "  ")).ok).toBe(false);
  });

  it("没开通不收推送也不给拉；开通后按序号推拉，密文存文件；退队后不行、再入队恢复", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 账号("甲"), 乙 = await 账号("乙"), 外人 = await 账号("外");
    const t = await r.建团队(甲, "团");
    if (!t.ok) throw new Error(t.error);
    await r.入队(乙, t.teamId, t.joinSecret);
    expect(await r.收推送(甲, t.teamId, "dev-A", 包1)).toEqual({ ok: false, 状态: 402, error: "团队同步还没开通" });
    await r.设开通(t.teamId, true);
    const p1 = await r.收推送(甲, t.teamId, "dev-A", 包1);
    const p2 = await r.收推送(乙, t.teamId, "dev-B", 包2);
    expect(p1.ok && p2.ok).toBe(true);
    expect((await r.收推送(外人, t.teamId, "dev-X", 包1)).ok).toBe(false);
    expect((await r.收推送(甲, t.teamId, "坏 设备", 包1)).ok).toBe(false);
    const 拉 = await r.给拉取(乙, t.teamId, 0);
    expect(拉.ok && 拉.batches.map((b) => [b.device, b.data])).toEqual([["dev-A", 包1], ["dev-B", 包2]]);
    const 后 = await r.给拉取(乙, t.teamId, p1.ok ? p1.seq : 0);
    expect(后.ok && 后.batches.map((b) => b.data)).toEqual([包2]);
    // 格式不对的（不是桌面端封的包）不收
    expect(await r.收推送(甲, t.teamId, "dev-A", "密文")).toMatchObject({ ok: false, 状态: 400 });
    // 库里只有元数据，密文在文件里
    expect((await control.syncBatch.findFirstOrThrow({ where: { teamId: t.teamId } })).size).toBe(包1.length);
    expect(fs.readdirSync(path.join(临时根, "sync", t.teamId)).sort()).toEqual([`${p1.ok && p1.seq}.bin`, `${p2.ok && p2.seq}.bin`].sort());
    // 设备编号认账号：乙冒用甲的设备号不收
    expect(await r.收推送(乙, t.teamId, "dev-A", 包2)).toMatchObject({ ok: false, 状态: 409 });
    // 刚建的批次缺文件（记录先有、文件后写的那一刻）：停在它前面，下一轮再来，不越过它
    fs.rmSync(path.join(临时根, "sync", t.teamId, `${p1.ok && p1.seq}.bin`));
    const 刚建 = await r.给拉取(乙, t.teamId, 0);
    expect(刚建.ok && 刚建.batches).toEqual([]);
    expect(刚建.ok && 刚建.more).toBe(false);
    // 建了一分钟以上还没文件：真没了，跳过那一批，不卡住
    await control.syncBatch.update({ where: { id: p1.ok ? p1.seq : 0 }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const 缺 = await r.给拉取(乙, t.teamId, 0);
    expect(缺.ok && 缺.batches.map((b) => b.data)).toEqual([包2]);
    // 退队
    await r.退队(乙, t.teamId);
    expect((await r.给拉取(乙, t.teamId, 0)).ok).toBe(false);
    expect((await r.入队(乙, t.teamId, t.joinSecret)).ok).toBe(true);
    expect((await r.给拉取(乙, t.teamId, 0)).ok).toBe(true);
  });

  it("运营台列表：人数、批次、占用、建的人", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const 甲 = await 账号("老板");
    const t = await r.建团队(甲, "列表测试团");
    if (!t.ok) throw new Error(t.error);
    await r.设开通(t.teamId, true);
    await r.收推送(甲, t.teamId, "dev-A", 包1);
    const 行 = (await r.全部团队()).find((x) => x.id === t.teamId)!;
    expect(行).toMatchObject({ name: "列表测试团", active: true, 人数: 1, 批次: 1, 字节: 包1.length });
    expect(行.建的人?.name).toBe("老板");
  });

  it("T-054 同一个编号并发换两次钥匙：一次成、另一次 409（不是 500），库里只有一把、信封不混", async () => {
    const r = await import("@/lib/tenant/sync-relay");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 账号("甲"), 乙 = await 账号("乙");
    const t = await r.建团队(甲, "并发换钥匙", { device: "dJia0001", pubKey: 设备钥匙对().公钥 });
    if (!t.ok) throw new Error(t.error);
    await r.入队(乙, t.teamId, t.joinSecret, { device: "dYi00001", pubKey: 设备钥匙对().公钥 });
    const 两次 = await Promise.allSettled([
      r.换钥匙(甲, t.teamId, 1, "环-一", [{ device: "dJia0001", data: "信-一" }, { device: "dYi00001", data: "信-一" }]),
      r.换钥匙(甲, t.teamId, 1, "环-二", [{ device: "dJia0001", data: "信-二" }, { device: "dYi00001", data: "信-二" }]),
    ]);
    // 两次都要「回话」：抛出来的话接口就是 500
    expect(两次.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    const 结果 = 两次.map((x) => (x.status === "fulfilled" ? x.value : null));
    expect(结果.filter((x) => x?.ok)).toHaveLength(1);
    expect(结果.find((x) => !x?.ok)).toMatchObject({ ok: false, 状态: 409 });
    const 环 = await control.syncKey.findMany({ where: { teamId: t.teamId } });
    expect(环).toHaveLength(1);
    // 成的那次的环和信封是一套：没有一半「环-一」一半「信-二」
    const 信 = await control.syncKeyEnvelope.findMany({ where: { teamId: t.teamId, epoch: 1 } });
    expect(信.map((x) => x.data)).toEqual(环[0].ring === "环-一" ? ["信-一", "信-一"] : ["信-二", "信-二"]);
  });

  it("接口：没令牌 401；不是托管版 404", async () => {
    const { GET } = await import("@/app/api/sync/team/route");
    expect((await GET(new Request("http://x/api/sync/team"))).status).toBe(401);
    delete process.env.MULTI_TENANT;
    try {
      expect((await GET(new Request("http://x/api/sync/team"))).status).toBe(404);
    } finally {
      process.env.MULTI_TENANT = "1";
    }
  });
});
