import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封 } from "@/lib/sync/crypto";
import { 提取范围, 行键 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-scope-relay-'));
let control: typeof import('@/lib/tenant/control').control;
let relay: typeof import('@/lib/tenant/sync-relay');
let scoped: typeof import('@/lib/tenant/sync-scoped');
let owner = '', member = '', other = '', team = '', seq = 0;
const key = 新钥匙();
beforeAll(async () => {
  process.env.MULTI_TENANT = '1'; process.env.CRM_SCOPED_SYNC = '1';
  process.env.SYNC_DIR = path.join(root, 'sync'); process.env.CONTROL_DATABASE_URL = `file:${path.join(root, 'control.db')}`;
  const sql = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/control.prisma', '--script'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(root, 'schema.sql'), sql);
  execFileSync(process.execPath, ['--experimental-sqlite', '-e', "const fs=require('node:fs');const d=new(require('node:sqlite').DatabaseSync)(process.argv[1]);d.exec(fs.readFileSync(process.argv[2],'utf8'));d.close()", path.join(root, 'control.db'), path.join(root, 'schema.sql')], { stdio: 'pipe' });
  ({ control } = await import('@/lib/tenant/control')); relay = await import('@/lib/tenant/sync-relay'); scoped = await import('@/lib/tenant/sync-scoped');
  for (const name of ['owner', 'member', 'other']) {
    const a = await control.account.create({ data: { name, email: `${name}@example.invalid`, password: 'not-a-login' } });
    if (name === 'owner') owner = a.id; else if (name === 'member') member = a.id; else other = a.id;
  }
  const t = await relay.建团队(owner, 'scope QA', { device: 'owner-device', pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error); team = t.teamId;
  for (const [a, d] of [[member, 'member-device'], [other, 'other-device']]) await relay.入队(a, team, t.joinSecret, { device: d, pubKey: 设备钥匙对().公钥 });
  await relay.设开通(team, true);
});
afterAll(async () => { await closeTestDatabases(root); fs.rmSync(root, { force: true, recursive: true }); for (const n of ['MULTI_TENANT', 'CRM_SCOPED_SYNC', 'SYNC_DIR', 'CONTROL_DATABASE_URL']) delete process.env[n]; });
const event = (t: string, k: string, r: Record<string, unknown>, o: 改动['o'] = 'I', c = Object.keys(r)): 改动 => ({ t, k, r: o === 'D' ? null : r, o, c, h: `${1700000000000 + ++seq}-scope` });
function packet(e: 改动, device: string) {
  const meta = 提取范围(e), eventId = createHmac('sha256', key).update(JSON.stringify(e)).digest('hex');
  return { meta, eventId, data: 封({ meta, change: e }, key, 0, { teamId: team, device }) };
}
async function push(a: string, d: string, e: 改动) { return scoped.收范围推送(a, team, d, [packet(e, d)]); }
it('旧业务员 API 在迁移之前也安全拒绝；只有老板设备能冻结旧流', async () => {
  expect(await relay.给拉取(member, team, 0)).toMatchObject({ ok: false, 状态: 409 });
  await expect(scoped.开始范围迁移(member, team, 'member-device')).rejects.toMatchObject({ 状态: 403 });
  await expect(scoped.开始范围迁移(owner, team, 'member-device')).rejects.toMatchObject({ 状态: 403 });
  expect(await scoped.开始范围迁移(owner, team, 'owner-device')).toMatchObject({ stage: 'building' });
  expect(await relay.收推送(owner, team, 'owner-device', 封([], key, 0))).toMatchObject({ ok: false, 状态: 409 });
  await expect(scoped.范围目录(member, team)).rejects.toMatchObject({ 状态: 409 });
});
it('老板完整起点启用后，目录/历史密文都只给当前有权限的人', async () => {
  for (const e of [event('Customer', 'boss-private', { salesOwnerId: `acct_${owner}`, name: 'QA老板私客', phone: '13900001611' }), event('Customer', 'member-private', { salesOwnerId: `acct_${member}`, name: 'QA业务员' }), event('Customer', 'other-private', { salesOwnerId: `acct_${other}` }), event('Customer', 'pool', { salesOwnerId: `acct_${owner}` }), event('CustomerPool', 'pool', { customerId: 'pool' }), event('Contact', 'boss-contact', { customerId: 'boss-private', name: 'QA隐私联系人' })]) await push(owner, 'owner-device', e);
  const count = await control.syncScopedBatch.count({ where: { teamId: team } });
  await expect(scoped.完成范围迁移(owner, team, 'owner-device', count - 1)).rejects.toMatchObject({ 状态: 409 });
  await scoped.完成范围迁移(owner, team, 'owner-device', count);
  const d = await scoped.范围目录(member, team);
  expect(d.scopes.map(s => s.id).sort()).toEqual(['Customer:member-private', 'Customer:pool']);
  expect(JSON.stringify(d)).not.toMatch(/boss-private|boss-contact|other-private|13900001611|QA老板/);
  expect((await scoped.范围目录(owner, team)).scopes).toHaveLength(4);
  await expect(scoped.给范围拉取(member, team, 'Customer:boss-private', 0)).rejects.toMatchObject({ 状态: 403 });
  expect((await scoped.给范围拉取(member, team, 'Customer:member-private', 0)).batches).toHaveLength(1);
  const raw = await control.syncScopedRecord.findMany({ where: { teamId: team } });
  expect(JSON.stringify(raw)).not.toMatch(/QA老板私客|13900001611|QA隐私联系人/);
});
it('已知编号、伪造负责人、新公海行/子记录均不能抢老板私客，失败不留半批', async () => {
  const before = await control.syncScopedBatch.count();
  for (const e of [event('Customer', 'boss-private', { salesOwnerId: `acct_${member}` }, 'U'), event('CustomerPool', 'boss-private', { customerId: 'boss-private' }), event('Contact', 'new-forgery', { customerId: 'boss-private' })]) await expect(push(member, 'member-device', e)).rejects.toMatchObject({ 状态: 403 });
  expect(await control.syncScopedBatch.count()).toBe(before);
});
it('转交后旧业务员不能再下载历史或写入；新负责人能取得整条历史', async () => {
  await push(member, 'member-device', event('Customer', 'member-private', { salesOwnerId: `acct_${other}` }, 'U'));
  await expect(scoped.给范围拉取(member, team, 'Customer:member-private', 0)).rejects.toMatchObject({ 状态: 403 });
  await expect(push(member, 'member-device', event('Customer', 'member-private', { remark: 'stale write' }, 'U'))).rejects.toMatchObject({ 状态: 403 });
  const received = await scoped.给范围拉取(other, team, 'Customer:member-private', 0);
  expect(received.batches).toHaveLength(2); expect(received.revision).toBeGreaterThan(0);
});
it('幂等、密文缺失不越过游标；停用/移除账号后拒绝目录和拉取', async () => {
  const e = event('Customer', 'own-new', { salesOwnerId: `acct_${member}` }); const p = packet(e, 'member-device');
  await scoped.收范围推送(member, team, 'member-device', [p]); await scoped.收范围推送(member, team, 'member-device', [p]);
  expect(await control.syncScopedBatch.count({ where: { teamId: team, eventId: p.eventId } })).toBe(1);
  const b = await control.syncScopedBatch.findFirstOrThrow({ where: { teamId: team, recordKey: 行键('Customer', 'own-new') } });
  const f = path.join(root, 'sync', 'scoped', `${b.digest}.bin`), data = fs.readFileSync(f);
  fs.rmSync(f); await expect(scoped.给范围拉取(member, team, 'Customer:own-new', 0)).rejects.toMatchObject({ 状态: 503 }); fs.writeFileSync(f, data);
  await control.account.update({ where: { id: member }, data: { active: false } });
  await expect(scoped.范围目录(member, team)).rejects.toMatchObject({ 状态: 403 });
  await control.account.update({ where: { id: member }, data: { active: true } });
  await relay.移除成员(owner, team, member);
  await expect(scoped.给范围拉取(member, team, 'Customer:own-new', 0)).rejects.toMatchObject({ 状态: 403 });
});
