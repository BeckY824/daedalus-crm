/**
 * 合并疑似重复（2026-10-20）：中继这一半。
 *   - 老板把业务员录的那份（X）合并进自己那份（Y）：先挪跟进、写合并记号、再删 X，按顺序推上来都收
 *   - 合并记号挂在 X 下面：X 原来的负责人（业务员）照样拉得到记号和删除，离线那台回来后照着把 X 删掉
 *   - 离线那台推回来的旧改动（改 X 的资料、给 X 记跟进）被拒，不会把删掉的 X 推回来——业务员自己的客户也一样
 *   - 撤销合并：先删记号、再把 X 建回来，中继收
 */
import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封范围 } from "@/lib/sync/crypto";
import { 提取范围, 合并掉了, 行键, type 范围索引 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-merge-"));
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let owner = "", member = "", team = "", seq = 0;
const key = 新钥匙();

beforeAll(async () => {
  process.env.MULTI_TENANT = "1"; process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(root, "sync"); process.env.CONTROL_DATABASE_URL = `file:${path.join(root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(root, "control.db"), path.join(root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control")); relay = await import("@/lib/tenant/sync-relay"); scoped = await import("@/lib/tenant/sync-scoped");
  for (const name of ["owner", "member"]) {
    const a = await control.account.create({ data: { name, email: `${name}@example.invalid`, password: "not-a-login" } });
    if (name === "owner") owner = a.id; else member = a.id;
  }
  const t = await relay.建团队(owner, "merge QA", { device: "owner-device", pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  await relay.入队(member, team, t.joinSecret, { device: "member-device", pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
  await scoped.开始范围迁移(owner, team, "owner-device");
  for (const e of [
    event("Customer", "Y", { salesOwnerId: `acct_${owner}` }),
    event("Customer", "Z", { salesOwnerId: `acct_${owner}` }),
  ]) await push(owner, "owner-device", e);
  await scoped.完成范围迁移(owner, team, "owner-device", await control.syncScopedBatch.count({ where: { teamId: team } }));
  // 业务员录的 X（同号码）和一条跟进
  await push(member, "member-device", event("Customer", "X", { salesOwnerId: `acct_${member}` }));
  await push(member, "member-device", event("FollowUp", "fx1", { customerId: "X", opportunityId: null, contactId: null }));
});
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ["MULTI_TENANT", "CRM_SCOPED_SYNC", "SYNC_DIR", "CONTROL_DATABASE_URL"]) delete process.env[n]; });

function event(t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 {
  return { t, k, r: o === "D" ? null : r, o, c, h: `${1700000000000 + ++seq}-merge` };
}
function packet(e: 改动, device: string) {
  const meta = 提取范围(e), eventId = createHmac("sha256", key).update(JSON.stringify(e)).digest("hex");
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device, eventId, meta }) };
}
async function push(a: string, d: string, ...es: 改动[]) { return scoped.收范围推送(a, team, d, es.map((e) => packet(e, d))); }
const 目录 = async (a: string) => (await scoped.范围目录(a, team)).scopes.map((s) => s.id).sort();

it("合并掉了：只认「有活着的记号 + 客户已删」，别的删除（没记号、记号撤了）照旧", () => {
  const 行 = (t: string, k: string, deleted: boolean, fields: Record<string, string | null> = {}): 范围索引 => ({ t, k, fields, clocks: {}, deleted, clock: "1", routeSeq: 0 });
  const 表 = (...rs: 范围索引[]) => { const m = new Map(rs.map((r) => [行键(r.t, r.k), r])); return { get: (k: string) => m.get(k) }; };
  const 改X = 行("Customer", "X", false);
  expect(合并掉了(改X, 表(行("Customer", "X", true), 行("CustomerMerge", "X", false, { fromId: "X" })))).toBe(true);
  expect(合并掉了(改X, 表(行("Customer", "X", true)))).toBe(false); // 普通删除：照旧可以「删了又改」
  expect(合并掉了(改X, 表(行("Customer", "X", true), 行("CustomerMerge", "X", true)))).toBe(false); // 撤销过
  expect(合并掉了(改X, 表(行("Customer", "X", false), 行("CustomerMerge", "X", false)))).toBe(false); // 还没删（推送中间）
  expect(合并掉了(行("Customer", "X", true), 表(行("Customer", "X", true), 行("CustomerMerge", "X", false)))).toBe(false); // 删除本身
});

it("老板合并：挪跟进、写记号、删 X 一次推上来都收；业务员照样拉得到记号和删除", async () => {
  await expect(push(owner, "owner-device",
    event("FollowUp", "fx1", { customerId: "Y" }, "U"),
    event("CustomerMerge", "X", { fromId: "X", intoId: "Y", userId: `acct_${owner}` }),
    event("Customer", "X", {}, "D"),
  )).resolves.toMatchObject({ stored: 3 });
  expect(await 目录(member)).toContain("Customer:X");
  const 拉 = await scoped.给范围拉取(member, team, "Customer:X", 0);
  expect(拉.batches.map((b) => `${b.meta.t}:${b.meta.o}`)).toEqual(expect.arrayContaining(["CustomerMerge:I", "Customer:D"]));
});

it("离线那台回来：改 X 的资料、给 X 记跟进都被拒（X 是业务员自己的也一样），中继里 X 还是删的", async () => {
  const 前 = await control.syncScopedBatch.count({ where: { teamId: team } });
  await expect(push(member, "member-device", event("Customer", "X", { salesOwnerId: `acct_${member}`, remark: "离线时改的" }, "U"))).rejects.toMatchObject({ 状态: 403 });
  await expect(push(member, "member-device", event("FollowUp", "fx-offline", { customerId: "X", opportunityId: null, contactId: null }))).rejects.toMatchObject({ 状态: 403 });
  // 老板自己推一份旧的也不行
  await expect(push(owner, "owner-device", event("Customer", "X", { salesOwnerId: `acct_${member}` }, "U"))).rejects.toMatchObject({ 状态: 403 });
  expect(await control.syncScopedBatch.count({ where: { teamId: team } })).toBe(前);
  const x = await control.syncScopedRecord.findUniqueOrThrow({ where: { teamId_key: { teamId: team, key: "Customer:X" } } });
  expect((JSON.parse(x.metadata) as 范围索引).deleted).toBe(true);
  // 普通删除不受影响：老板删了 Z，又改回来（「删了又被更晚地改 → 复活」）照旧收
  await push(owner, "owner-device", event("Customer", "Z", {}, "D"));
  await expect(push(owner, "owner-device", event("Customer", "Z", { salesOwnerId: `acct_${owner}` }))).resolves.toMatchObject({ stored: 1 });
});

it("撤销合并：先删记号、再把 X 建回来、跟进挪回去，中继收；之后业务员又能改 X", async () => {
  await expect(push(owner, "owner-device",
    event("CustomerMerge", "X", {}, "D"),
    event("Customer", "X", { salesOwnerId: `acct_${member}` }),
    event("FollowUp", "fx1", { customerId: "X" }, "U"),
  )).resolves.toMatchObject({ stored: 3 });
  await expect(push(member, "member-device", event("Customer", "X", { remark: "撤销后改的" }, "U"))).resolves.toMatchObject({ stored: 1 });
});
