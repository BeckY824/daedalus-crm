/**
 * 团队版业务主管（2026-10-20，老板 → 业务主管 → 业务员）：中继这一半。
 *   - 角色记在中继 SyncMember.role = manager，只有建团队的人能设 / 改回；团队名单、范围状态、目录都带出来
 *   - 主管：目录里有全队客户（不看互看开关）、整段历史都给；全队客户能改（改资料、转交、进出公海、建待办）；
 *     业务配置（Setting）、别人的账号行、别人的个人范围（未归属联系人等）照旧不行
 *   - 改回业务员：目录回到「自己的 + 公海」；退队再回来的主管回来是业务员
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-manager-"));
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let owner = "", member = "", other = "", team = "", joinSecret = "", seq = 0;
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
  const t = await relay.建团队(owner, "manager QA", { device: "owner-device", pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId; joinSecret = t.joinSecret;
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
    event("Setting", "business", { }),
    event("User", `acct_${other}`, { }),
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

it("默认是业务员；业务员设不了主管，老板能设，也不能把自己（老板）改掉", async () => {
  expect(await 目录(member)).toEqual(["Customer:member-own", "Customer:pool", "team"]);
  expect(await scoped.范围状态(member, team)).toMatchObject({ manager: false, share: false });
  expect(await relay.设角色(member, team, member, "manager")).toMatchObject({ ok: false, 状态: 403 });
  expect(await relay.设角色(owner, team, owner, "manager")).toMatchObject({ ok: false, 状态: 400 });
  expect(await relay.设角色(owner, team, member, "owner")).toMatchObject({ ok: false, 状态: 400 });
  expect(await relay.设角色(owner, team, member, "manager")).toEqual({ ok: true, role: "manager" });
  expect((await relay.我的团队(owner)).find((t) => t.id === team)?.成员.find((m) => m.accountId === member)?.role).toBe("manager");
  expect(await scoped.范围状态(member, team)).toMatchObject({ manager: true, owner: false });
  // 主管设不了别人
  expect(await relay.设角色(member, team, other, "manager")).toMatchObject({ ok: false, 状态: 403 });
});

it("主管：开关关着也拿到全队客户、整段历史；别人的个人范围照旧不给", async () => {
  expect(await relay.互看(team)).toBe(false);
  const ids = await 目录(member);
  expect(ids).toEqual(expect.arrayContaining(["Customer:boss-private", "Customer:member-own", "Customer:other-private", "Customer:pool", "team"]));
  expect(ids.some((s) => s.startsWith("personal:"))).toBe(false);
  expect((await scoped.范围目录(member, team)).manager).toBe(true);
  const r = await scoped.给范围拉取(member, team, "Customer:other-private", 0);
  expect(r.batches.map((b) => `${b.meta.t}:${b.meta.o}`)).toEqual(["Customer:I", "Customer:U", "FollowUp:I"]);
});

it("主管：全队客户能改、能转交、能进出公海、能建待办；业务配置、别人的账号行、别人的未归属联系人不行", async () => {
  for (const e of [
    event("Customer", "other-private", { remark: "主管改的" }, "U"),
    event("Task", "manager-task", { customerId: "other-private" }),
    event("FollowUp", "other-follow", { customerId: "other-private", opportunityId: null, contactId: null }, "U"),
    event("Contact", "manager-contact", { customerId: "boss-private" }),
    event("Customer", "boss-private", { salesOwnerId: `acct_${other}` }, "U"),
    event("CustomerPool", "other-private", { customerId: "other-private" }),
    event("CustomerPool", "other-private", {}, "D"),
  ]) await expect(push(member, "member-device", e), `${e.t} ${e.o}`).resolves.toBeTruthy();
  const 前 = await control.syncScopedBatch.count({ where: { teamId: team } });
  for (const e of [
    event("Setting", "business", { }, "U"),
    event("User", `acct_${other}`, { }, "U"),
    event("UnassignedContact", "other-loose", { ownerId: `acct_${member}` }, "U"),
  ]) await expect(push(member, "member-device", e), `${e.t} ${e.o}`).rejects.toMatchObject({ 状态: 403 });
  expect(await control.syncScopedBatch.count({ where: { teamId: team } })).toBe(前);
});

it("改回业务员：目录回到自己的 + 公海，同事的客户拉不到、写不进", async () => {
  expect(await relay.设角色(owner, team, member, "member")).toEqual({ ok: true, role: "member" });
  expect(await 目录(member)).toEqual(["Customer:member-own", "Customer:pool", "team"]);
  await expect(scoped.给范围拉取(member, team, "Customer:other-private", 0)).rejects.toMatchObject({ 状态: 403 });
  await expect(push(member, "member-device", event("Customer", "other-private", { remark: "改回后再改" }, "U"))).rejects.toMatchObject({ 状态: 403 });
});

it("走了再回来的主管回来是业务员", async () => {
  await relay.设角色(owner, team, member, "manager");
  await relay.退队(member, team);
  await relay.入队(member, team, joinSecret, { device: "member-device-2", pubKey: 设备钥匙对().公钥 });
  expect((await relay.我的团队(member)).find((t) => t.id === team)?.成员.find((m) => m.accountId === member)?.role).toBe("member");
  // 不在队里的人设不了
  await relay.退队(member, team);
  expect(await relay.设角色(owner, team, member, "manager")).toMatchObject({ ok: false, 状态: 404 });
});
