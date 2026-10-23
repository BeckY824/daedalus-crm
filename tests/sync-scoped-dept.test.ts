/**
 * 团队版项目模式 1b（2026-10-23）：部门隔离，中继这一半。两个一级部门（内贸 a1 a2、外贸 b1 b2）+ 老板：
 *   - 老团队等价：没部门、只有一个一级部门时，人人的目录、范围状态和升级前一模一样
 *   - 两个一级部门后：公海、互看、销售管理都只到本一级部门；管理员、总管理默认看全公司
 *   - 越权：别部门的客户拉不到、推不进（改资料、加跟进都不行）
 *   - 跨部门查重：只回概况（客户 id、负责人、封好的名字）+ 对方一级部门名
 *   - 调部门：名下客户跟着人走；改角色、建部门只有老板 / 总管理 / 管理员能做，总管理只有老板能给
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-scope-dept-"));
let relay: typeof import("@/lib/tenant/sync-relay");
let scoped: typeof import("@/lib/tenant/sync-scoped");
let dept: typeof import("@/lib/tenant/team-dept");
let control: typeof import("@/lib/tenant/control").control;
const id: Record<string, string> = {};
let team = "", seq = 0;
const key = 新钥匙();
const 人 = ["owner", "a1", "a2", "b1", "b2"] as const;

beforeAll(async () => {
  process.env.MULTI_TENANT = "1"; process.env.CRM_SCOPED_SYNC = "1";
  process.env.SYNC_DIR = path.join(root, "sync"); process.env.CONTROL_DATABASE_URL = `file:${path.join(root, "control.db")}`;
  const sql = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(root, "schema.sql"), sql);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(root, "control.db"), path.join(root, "schema.sql")], { stdio: "pipe" });
  ({ control } = await import("@/lib/tenant/control")); relay = await import("@/lib/tenant/sync-relay"); scoped = await import("@/lib/tenant/sync-scoped"); dept = await import("@/lib/tenant/team-dept");
  for (const name of 人) id[name] = (await control.account.create({ data: { name, email: `${name}@example.invalid`, password: "not-a-login" } })).id;
  const t = await relay.建团队(id.owner, "dept QA", { device: "owner-device", pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  for (const n of 人.slice(1)) await relay.入队(id[n], team, t.joinSecret, { device: `${n}-device`, pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
  await scoped.开始范围迁移(id.owner, team, "owner-device");
  for (const e of [
    ...人.map((n) => event("Customer", `${n}-c`, { salesOwnerId: `acct_${id[n]}` })),
    // 没有负责人的客户：算默认一级部门（建得最早的）
    event("Customer", "orphan", { salesOwnerId: null }),
    // 公海客户带着放进公海前的负责人，跟原部门走
    event("Customer", "pool-a", { salesOwnerId: `acct_${id.a1}` }), event("CustomerPool", "pool-a", { customerId: "pool-a" }),
    event("Customer", "pool-b", { salesOwnerId: `acct_${id.b1}` }), event("CustomerPool", "pool-b", { customerId: "pool-b" }),
  ]) await push(id.owner, "owner-device", e);
  await scoped.完成范围迁移(id.owner, team, "owner-device", await control.syncScopedBatch.count({ where: { teamId: team } }));
});
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ["MULTI_TENANT", "CRM_SCOPED_SYNC", "SYNC_DIR", "CONTROL_DATABASE_URL"]) delete process.env[n]; });

function event(t: string, k: string, r: Record<string, unknown>, o: 改动["o"] = "I", c = Object.keys(r)): 改动 {
  return { t, k, r: o === "D" ? null : r, o, c, h: `${1700000000000 + ++seq}-dept` };
}
function packet(e: 改动, device: string) {
  const meta = 提取范围(e), eventId = createHmac("sha256", key).update(JSON.stringify(e)).digest("hex");
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device, eventId, meta }) };
}
async function push(a: string, d: string, e: 改动) { return scoped.收范围推送(a, team, d, [packet(e, d)]); }
const 目录 = async (n: (typeof 人)[number]) => (await scoped.范围目录(id[n], team)).scopes.map((s) => s.id.replace(/^Customer:/, "")).sort();
const 全部目录 = async () => Object.fromEntries(await Promise.all(人.map(async (n) => [n, { 目录: await 目录(n), 状态: await scoped.范围状态(id[n], team) }])));
const 全部客户 = ["a1-c", "a2-c", "b1-c", "b2-c", "orphan", "owner-c", "pool-a", "pool-b"];
let 内贸 = "", 外贸 = "";

it("老团队等价：建一个一级部门、把人都放进去，人人的目录和范围状态不变", async () => {
  await relay.设角色(id.owner, team, id.a1, "manager");
  const 升级前 = await 全部目录();
  expect(升级前.a1.目录).toEqual(全部客户);
  expect(升级前.a2.目录).toEqual(["a2-c", "pool-a", "pool-b"]);
  const r = await dept.建部门(id.owner, team, "内贸", null);
  if (!r.ok) throw Error(r.error); 内贸 = r.id;
  for (const n of 人.slice(1)) expect(await dept.设成员(id.owner, team, id[n], { deptId: 内贸 })).toMatchObject({ ok: true });
  // 老角色推过来：主管 → 销售管理（看本部门），业务员 → 销售成员
  const 编制 = (await relay.我的团队(id.owner)).find((t) => t.id === team)?.编制;
  expect(编制?.部门).toEqual([expect.objectContaining({ id: 内贸, name: "内贸", parentId: null, top: 内贸 })]);
  expect(await 全部目录()).toEqual(升级前);
  // 二级部门不算第二个一级部门：照样不隔离
  const 子 = await dept.建部门(id.owner, team, "内贸一组", 内贸);
  if (!子.ok) throw Error(子.error);
  expect(await dept.设成员(id.owner, team, id.a2, { deptId: 子.id })).toMatchObject({ ok: true });
  expect(await 全部目录()).toEqual(升级前);
});

it("两个一级部门：公海、销售管理只到本部门；老板、管理员看全公司", async () => {
  const r = await dept.建部门(id.owner, team, "外贸", null);
  if (!r.ok) throw Error(r.error); 外贸 = r.id;
  for (const n of ["b1", "b2"] as const) expect(await dept.设成员(id.owner, team, id[n], { deptId: 外贸 })).toMatchObject({ ok: true });
  expect(await 目录("owner")).toEqual(全部客户);
  // a1 是销售管理（老主管）：内贸的人 + 老板（没分部门，算默认的内贸）+ 没负责人的
  expect(await 目录("a1")).toEqual(["a1-c", "a2-c", "orphan", "owner-c", "pool-a"]);
  expect(await 目录("a2")).toEqual(["a2-c", "pool-a"]);
  expect(await 目录("b2")).toEqual(["b2-c", "pool-b"]);
  // 管理员默认全公司（10-23 拍板）
  expect(await dept.设成员(id.owner, team, id.b2, { bizRole: "admin" })).toMatchObject({ ok: true, bizRole: "admin" });
  expect(await 目录("b2")).toEqual(全部客户);
  expect(await scoped.范围状态(id.b2, team)).toMatchObject({ manager: true, owner: false });
  // 配置表能改：管理员改成本部门后只看外贸
  expect(await dept.设角色范围(id.owner, team, "admin", "dept")).toMatchObject({ ok: true });
  expect(await 目录("b2")).toEqual(["b1-c", "b2-c", "pool-b"]);
  expect(await dept.设角色范围(id.owner, team, "admin", "all")).toMatchObject({ ok: true });
});

it("互看开着也只看本一级部门的同事", async () => {
  expect(await relay.设互看(id.owner, team, true)).toMatchObject({ ok: true });
  expect(await 目录("a2")).toEqual(["a1-c", "a2-c", "orphan", "owner-c", "pool-a"]);
  expect(await 目录("b1")).toEqual(["b1-c", "b2-c", "pool-b"]);
  expect(await relay.设互看(id.owner, team, false)).toMatchObject({ ok: true });
});

it("越权：别部门的客户拉不到、改不了、加不了跟进", async () => {
  await expect(scoped.给范围拉取(id.a2, team, "Customer:b1-c", 0)).rejects.toMatchObject({ 状态: 403 });
  await expect(scoped.给范围拉取(id.a1, team, "Customer:pool-b", 0)).rejects.toMatchObject({ 状态: 403 });
  for (const e of [
    event("Customer", "b1-c", { name: "改名" }, "U"),
    event("Customer", "b1-c", { salesOwnerId: `acct_${id.a1}` }, "U"),
    event("FollowUp", "a1-on-b1", { customerId: "b1-c", opportunityId: null, contactId: null }),
    event("CustomerPool", "pool-b", { customerId: "pool-b" }, "D"),
  ]) await expect(push(id.a1, "a1-device", e), `${e.t} ${e.o}`).rejects.toMatchObject({ 状态: 403 });
  // 本部门照旧能改
  await expect(push(id.a1, "a1-device", event("Customer", "a2-c", { name: "内贸改" }, "U"))).resolves.toBeTruthy();
});

it("跨部门查重：只回概况和对方一级部门名", async () => {
  const { epoch } = await scoped.范围状态(id.b1, team);
  const h = "ab".repeat(32);
  expect(await scoped.收查重索引(id.b1, team, "b1-device", [{ k: "b1-c", epoch, hashes: [h], label: "封好的名字" }])).toEqual({ stored: 1, skipped: [] });
  // 内贸的人往外贸的客户报索引：看不到，不收
  expect(await scoped.收查重索引(id.a2, team, "a2-device", [{ k: "b1-c", epoch, hashes: ["cd".repeat(32)], label: "x" }])).toEqual({ stored: 0, skipped: ["b1-c"] });
  expect(await scoped.查查重(id.a2, team, [h])).toEqual({ hits: [{ k: "b1-c", owner: `acct_${id.b1}`, label: "封好的名字", dept: "外贸" }] });
  // 看得到的不回（本机自己查得到）
  expect(await scoped.查查重(id.b2, team, [h])).toEqual({ hits: [] });
});

it("调部门：名下客户跟着人走", async () => {
  expect(await dept.设成员(id.owner, team, id.b1, { deptId: 内贸 })).toMatchObject({ ok: true });
  expect(await 目录("a1")).toEqual(["a1-c", "a2-c", "b1-c", "orphan", "owner-c", "pool-a", "pool-b"]);
  expect(await 目录("b1")).toEqual(["b1-c", "pool-a", "pool-b"]);
  expect(await dept.设成员(id.owner, team, id.b1, { deptId: 外贸 })).toMatchObject({ ok: true });
});

it("谁能改：销售成员不行；管理员能建部门、调人，但给不了总管理；总管理只有老板能给", async () => {
  expect(await dept.建部门(id.a2, team, "偷建", null)).toMatchObject({ ok: false, 状态: 403 });
  expect(await dept.设成员(id.a2, team, id.a2, { bizRole: "admin" })).toMatchObject({ ok: false, 状态: 403 });
  expect(await dept.设角色范围(id.a2, team, "sales", "all")).toMatchObject({ ok: false, 状态: 403 });
  const 子 = await dept.建部门(id.b2, team, "外贸二组", 外贸);
  expect(子).toMatchObject({ ok: true });
  expect(await dept.设成员(id.b2, team, id.a2, { bizRole: "director" })).toMatchObject({ ok: false, 状态: 403 });
  expect(await dept.设成员(id.b2, team, id.owner, { bizRole: "sales" })).toMatchObject({ ok: false });
  expect(await dept.设成员(id.owner, team, id.a2, { bizRole: "director" })).toMatchObject({ ok: true, bizRole: "director" });
  expect(await 目录("a2")).toEqual(全部客户);
  // 写回老角色：老客户端看名单里是主管
  expect((await relay.我的团队(id.owner)).find((t) => t.id === team)?.成员.find((m) => m.accountId === id.a2)?.role).toBe("manager");
  expect(await dept.设成员(id.owner, team, id.a2, { bizRole: "sales" })).toMatchObject({ ok: true });
  expect((await relay.我的团队(id.owner)).find((t) => t.id === team)?.成员.find((m) => m.accountId === id.a2)?.role).toBe("member");
  // 部门里还有人删不掉；三层封顶；同层不重名
  expect(await dept.删部门(id.owner, team, 外贸)).toMatchObject({ ok: false });
  if (!子.ok) return;
  const 三 = await dept.建部门(id.owner, team, "三层", 子.id);
  expect(三).toMatchObject({ ok: true });
  if (三.ok) expect(await dept.建部门(id.owner, team, "四层", 三.id)).toMatchObject({ ok: false, 状态: 400 });
  expect(await dept.建部门(id.owner, team, "外贸", null)).toMatchObject({ ok: false });
});

it("邀请进组：不是项目范围、项目还没同步上来的都拒", async () => {
  expect(await dept.邀请进组(id.a1, team, "Customer:a1-c", id.b1, null, undefined)).toMatchObject({ ok: false, 状态: 400 });
  expect(await dept.邀请进组(id.a1, team, "Project:nope", id.b1, null, undefined)).toMatchObject({ ok: false, 状态: 404 });
  expect(await dept.回邀请(id.b1, team, "Project:nope", true)).toMatchObject({ ok: false, 状态: 404 });
  expect(await dept.进组名单(id.b1, team)).toEqual({ ok: true, 待我回: [], 组员: [] });
});
