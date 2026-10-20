/**
 * 团队「同事之间互相看得到客户」（2026-10-20，客户需求）：中继这一半。
 *   - 开关存在中继（control-migrations/028 SyncTeamShare），只有建团队的人能改；团队名单、范围状态、目录都带出来
 *   - 开着：业务员的目录里有同事的客户、整段历史都给；同事的客户只许新加跟进家族（跟进、来源、关联订单、操作日志）
 *   - 关掉：目录回到「自己的 + 公海」，同事的客户拉不到、也写不进去（客户端照目录清理失权副本）
 */
import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封范围 } from "@/lib/sync/crypto";
import { 提取范围 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-share-"));
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let owner = "", member = "", other = "", team = "", seq = 0;
const key = 新钥匙();

beforeAll(async () => {
  process.env.MULTI_TENANT = "1"; process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(root, "sync"); process.env.CONTROL_DATABASE_URL = `file:${path.join(root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(root, "control.db"), path.join(root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control")); relay = await import("@/lib/tenant/sync-relay"); scoped = await import("@/lib/tenant/sync-scoped");
  for (const name of ["owner", "member", "other"]) {
    const a = await control.account.create({ data: { name, email: `${name}@example.invalid`, password: "not-a-login" } });
    if (name === "owner") owner = a.id; else if (name === "member") member = a.id; else other = a.id;
  }
  const t = await relay.建团队(owner, "share QA", { device: "owner-device", pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  for (const [a, d] of [[member, "member-device"], [other, "other-device"]]) await relay.入队(a, team, t.joinSecret, { device: d, pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
  await scoped.开始范围迁移(owner, team, "owner-device");
  for (const e of [
    event("Customer", "boss-private", { salesOwnerId: `acct_${owner}` }),
    event("Customer", "member-own", { salesOwnerId: `acct_${member}` }),
    // 先归老板、后转给同事：改过归属（routeSeq > 0），互看时也得从头拿到
    event("Customer", "other-private", { salesOwnerId: `acct_${owner}` }),
    event("Customer", "pool", { salesOwnerId: `acct_${owner}` }),
    event("CustomerPool", "pool", { customerId: "pool" }),
    event("Contact", "boss-contact", { customerId: "boss-private" }),
    event("UnassignedContact", "other-loose", { ownerId: `acct_${other}` }),
  ]) await push(owner, "owner-device", e);
  await scoped.完成范围迁移(owner, team, "owner-device", await control.syncScopedBatch.count({ where: { teamId: team } }));
  await push(owner, "owner-device", event("Customer", "other-private", { salesOwnerId: `acct_${other}` }, "U"));
  await push(other, "other-device", event("FollowUp", "other-follow", { customerId: "other-private", opportunityId: null, contactId: null }));
});
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ["MULTI_TENANT", "CRM_SCOPED_SYNC", "SYNC_DIR", "CONTROL_DATABASE_URL"]) delete process.env[n]; });

function event(t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 {
  return { t, k, r: o === "D" ? null : r, o, c, h: `${1700000000000 + ++seq}-share` };
}
function packet(e: 改动, device: string) {
  const meta = 提取范围(e), eventId = createHmac("sha256", key).update(JSON.stringify(e)).digest("hex");
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device, eventId, meta }) };
}
async function push(a: string, d: string, e: 改动) { return scoped.收范围推送(a, team, d, [packet(e, d)]); }
const 目录 = async (a: string) => (await scoped.范围目录(a, team)).scopes.map((s) => s.id).sort();

it("默认关：业务员只看得到自己的 + 公海；业务员改不了开关，老板能改", async () => {
  expect(await relay.互看(team)).toBe(false);
  expect(await 目录(member)).toEqual(["Customer:member-own", "Customer:pool"]);
  expect(await scoped.范围状态(member, team)).toMatchObject({ share: false });
  expect(await relay.设互看(member, team, true)).toMatchObject({ ok: false, 状态: 403 });
  expect(await relay.互看(team)).toBe(false);
  expect(await relay.设互看(owner, team, true)).toEqual({ ok: true, on: true });
  expect(await control.syncTeamShare.findUnique({ where: { teamId: team } })).toMatchObject({ on: true, by: owner });
});

it("开着：团队名单、范围状态都带出开关；目录里有同事的客户，未归属联系人这类个人范围照旧不给", async () => {
  expect((await relay.我的团队(member)).find((t) => t.id === team)).toMatchObject({ 互看: true });
  expect(await scoped.范围状态(member, team)).toMatchObject({ share: true });
  expect(await 目录(member)).toEqual(["Customer:boss-private", "Customer:member-own", "Customer:other-private", "Customer:pool"]);
  expect((await 目录(member)).some((s) => s.startsWith("personal:"))).toBe(false);
});

it("开着：同事的客户整段历史都给（改过归属的也从头给，不等老板补起点）", async () => {
  const r = await scoped.给范围拉取(member, team, "Customer:other-private", 0);
  // 建（归老板）、转给同事、同事记的跟进
  expect(r.batches.map((b) => `${b.meta.t}:${b.meta.o}`)).toEqual(["Customer:I", "Customer:U", "FollowUp:I"]);
  expect((await scoped.给范围拉取(member, team, "Customer:boss-private", 0)).batches.map((b) => b.meta.t)).toEqual(["Customer", "Contact"]);
});

it("开着：同事的客户只许新加跟进家族；改资料、删、加联系人 / 待办、改别人的跟进都拒", async () => {
  await push(member, "member-device", event("FollowUp", "member-on-other", { customerId: "other-private", opportunityId: null, contactId: null }));
  await push(member, "member-device", event("FollowUpSource", "member-on-other", { followUpId: "member-on-other" }));
  await push(member, "member-device", event("AuditLog", "audit-on-other", { userId: `acct_${member}`, entity: "FollowUp", entityId: "member-on-other" }));
  const 前 = await control.syncScopedBatch.count({ where: { teamId: team } });
  for (const e of [
    event("Customer", "other-private", { remark: "改同事的资料" }, "U"),
    event("Customer", "other-private", { salesOwnerId: `acct_${member}` }, "U"),
    event("Customer", "boss-private", {}, "D"),
    event("Contact", "member-contact", { customerId: "boss-private" }),
    event("Task", "member-task", { customerId: "other-private" }),
    event("FollowPlan", "member-plan", { customerId: "other-private" }),
    event("FollowUp", "other-follow", { customerId: "other-private", opportunityId: null, contactId: null }, "U"),
    event("FollowUp", "other-follow", {}, "D"),
    event("CustomerPool", "other-private", { customerId: "other-private" }),
  ]) await expect(push(member, "member-device", e), `${e.t} ${e.o}`).rejects.toMatchObject({ 状态: 403 });
  expect(await control.syncScopedBatch.count({ where: { teamId: team } })).toBe(前);
  // 自己的客户照旧什么都能改
  await push(member, "member-device", event("Customer", "member-own", { remark: "自己的" }, "U"));
  await push(member, "member-device", event("Task", "member-own-task", { customerId: "member-own" }));
});

it("关掉：目录回到自己的 + 公海，同事的客户拉不到、也写不进去", async () => {
  expect(await relay.设互看(owner, team, false)).toEqual({ ok: true, on: false });
  expect(await 目录(member)).toEqual(["Customer:member-own", "Customer:pool"]);
  expect(await scoped.范围状态(member, team)).toMatchObject({ share: false });
  expect((await relay.我的团队(member)).find((t) => t.id === team)).toMatchObject({ 互看: false });
  await expect(scoped.给范围拉取(member, team, "Customer:other-private", 0)).rejects.toMatchObject({ 状态: 403 });
  await expect(push(member, "member-device", event("FollowUp", "after-off", { customerId: "other-private", opportunityId: null, contactId: null }))).rejects.toMatchObject({ 状态: 403 });
  // 开着时记的那条跟进还在同事那里（老板 / 负责人照常拉得到）
  expect((await scoped.给范围拉取(other, team, "Customer:other-private", 0)).batches.map((b) => b.meta.k)).toContain("member-on-other");
});
