/**
 * 收推送只读用得到的那几条记录（2026-10-22 服务器优化 #1）。
 * 原来每次推送都把整队 SyncScopedRecord 读出来逐条 JSON.parse：1 万位客户的团队一次推送 8 万条，在事务里，30 台时别的请求全排在后面。
 * 现在只读这一包和它往上查得到的父记录；权限判断要和整表读完全一样——父链每一层都在之前别的请求里推上来，必须从库里现读到。
 */
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封范围 } from "@/lib/sync/crypto";
import { 提取范围 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-reads-"));
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let control: typeof import("@/lib/tenant/control").control;
let owner = "", member = "", team = "", seq = 0;
const key = 新钥匙();
const 老客户 = 300;

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
  const t = await relay.建团队(owner, "reads QA", { device: "owner-device", pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  await relay.入队(member, team, t.joinSecret, { device: "member-device", pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
  await scoped.开始范围迁移(owner, team, "owner-device");
  // 老板的老客户：和下面的推送无关，原来每次推送都要整表读一遍
  const 老 = Array.from({ length: 老客户 }, (_, i) => event("Customer", `old${i}`, { salesOwnerId: `acct_${owner}`, channelOwnerId: null }));
  for (let i = 0; i < 老.length; i += 100) await push(owner, "owner-device", ...老.slice(i, i + 100));
  await push(owner, "owner-device", event("Customer", "boss", { salesOwnerId: `acct_${owner}`, channelOwnerId: null }));
  await scoped.完成范围迁移(owner, team, "owner-device", await control.syncScopedBatch.count({ where: { teamId: team } }));
  // 父链每层各推一次：客户 → 商机 → 跟进，老板的和业务员的各一条
  await push(member, "member-device", event("Customer", "mine", { salesOwnerId: `acct_${member}`, channelOwnerId: null }));
  for (const c of ["mine", "boss"]) {
    const a = c === "mine" ? member : owner, d = c === "mine" ? "member-device" : "owner-device";
    await push(a, d, event("Opportunity", `o-${c}`, { customerId: c }));
    await push(a, d, event("FollowUp", `f-${c}`, { customerId: c, opportunityId: `o-${c}`, contactId: null }));
  }
});
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ["MULTI_TENANT", "CRM_SCOPED_SYNC", "SYNC_DIR", "CONTROL_DATABASE_URL"]) delete process.env[n]; });

function event(t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 {
  return { t, k, r: o === "D" ? null : r, o, c, h: `${1700000000000 + ++seq}-reads` };
}
function packet(e: 改动, device: string) {
  const meta = 提取范围(e), eventId = createHmac("sha256", key).update(JSON.stringify(e)).digest("hex");
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device, eventId, meta }) };
}
async function push(a: string, d: string, ...es: 改动[]) { return scoped.收范围推送(a, team, d, es.map((e) => packet(e, d))); }

it("推一条跟进来源：父链三层都从库里现读到，自己客户下的收、老板客户下的拒", async () => {
  await expect(push(member, "member-device", event("FollowUpSource", "s-mine", { followUpId: "f-mine" }))).resolves.toMatchObject({ stored: 1 });
  await expect(push(member, "member-device", event("FollowUpSource", "s-boss", { followUpId: "f-boss" }))).rejects.toMatchObject({ 状态: 403, denied: [0] });
  // 同一次请求里先建商机、再挂跟进：第二包的父记录是本次刚落的，也认
  await expect(push(member, "member-device",
    event("Opportunity", "o2", { customerId: "mine" }),
    event("FollowUp", "f2", { customerId: "mine", opportunityId: "o2", contactId: null }),
  )).resolves.toMatchObject({ stored: 2 });
  // 挂到老板客户的商机上：父链里有不可读的一层，整批拒
  await expect(push(member, "member-device", event("FollowUp", "f3", { customerId: "mine", opportunityId: "o-boss", contactId: null }))).rejects.toMatchObject({ 状态: 403 });
});

it(`一次推一条只读几条记录，不随团队记录数（${老客户}+）涨`, async () => {
  const parse = vi.spyOn(JSON, "parse");
  try {
    await push(member, "member-device", event("FollowUp", "f4", { customerId: "mine", opportunityId: "o-mine", contactId: null }));
    const 读的记录 = parse.mock.calls.filter(([s]) => typeof s === "string" && s.startsWith('{"t":')).length;
    expect(读的记录).toBeLessThan(20);
  } finally { parse.mockRestore(); }
});
