import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeTestDatabases } from "./close-databases";
import { 设备钥匙对, 新钥匙, 封, 封范围 } from "@/lib/sync/crypto";
import { 提取范围, 行键 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";
/*
  拉取拿到索引之后、读批次之前插一次推送（索引缓存的竞态测试用，2026-10-21）：设了 插一手，下一次取团队索引返回之前先把它跑完。
  这样「拉取用的是转走之前的索引，转走那一批已经提交」这一刻每次都出现，不靠运气撞
*/
const 钩 = vi.hoisted(() => ({ 插一手: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/tenant/scoped-index", async (原) => {
  const m = await 原<typeof import("@/lib/tenant/scoped-index")>();
  return { ...m, 团队索引: async (teamId: string) => {
    const e = await m.团队索引(teamId);
    const h = 钩.插一手; 钩.插一手 = null;
    if (h) await h();
    return e;
  } };
});
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
  return { meta, eventId, data: 封范围({ meta, change: e }, key, 0, { teamId: team, device, eventId, meta }) };
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
  // 新负责人不拿失权期间的历史：起点补上之前什么都不给，补上后只给起点及之后
  const none = await scoped.给范围拉取(other, team, 'Customer:member-private', 0);
  expect(none.batches).toHaveLength(0); expect(none.revision).toBeGreaterThan(0);
  const snap = { ...packet(event('Customer', 'member-private', { salesOwnerId: `acct_${other}`, name: 'QA业务员' }), 'owner-device'), baseline: true };
  await scoped.收范围推送(owner, team, 'owner-device', [snap]);
  const received = await scoped.给范围拉取(other, team, 'Customer:member-private', 0);
  expect(received.batches).toHaveLength(1); expect(received.batches[0].eventId).toBe(snap.eventId);
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
/*
  同 eventId 换密文（2026-10-21 改）：原来 409。可每次加密随机 IV，回包丢了客户端重推字节必然不同，一丢就永久 409；
  中转解不开密文、分不出「同一条重加密」和「换了内容」，现在一律当重复：不落盘、原来那份不动（借旧编号换不掉内容），
  外层范围信息不一样仍 409（那是中转能看到的、决定谁看得见的部分）
*/
it('v3 旧密文拒收；同 eventId 换密文当重复、不落盘；换范围信息 409', async () => {
  const e = event('Customer', 'own-v3', { salesOwnerId: `acct_${owner}` });
  const p = packet(e, 'owner-device');
  await expect(scoped.收范围推送(owner, team, 'owner-device', [{ ...p, data: 封({ meta: p.meta, change: e }, key, 0, { teamId: team, device: 'owner-device' }) }])).rejects.toMatchObject({ 状态: 400 });
  await scoped.收范围推送(owner, team, 'owner-device', [p]);
  const swapped = 封范围({ meta: p.meta, change: { ...e, r: { ...e.r, name: 'swap' } } }, key, 0, { teamId: team, device: 'owner-device', eventId: p.eventId, meta: p.meta });
  const 前 = await control.syncScopedBatch.findFirstOrThrow({ where: { teamId: team, eventId: p.eventId } });
  expect(await scoped.收范围推送(owner, team, 'owner-device', [{ ...p, data: swapped }])).toEqual({ received: 1, stored: 1 });
  expect(await control.syncScopedBatch.findMany({ where: { teamId: team, eventId: p.eventId } })).toEqual([前]);
  const 别人的 = packet(event('Customer', 'own-v3', { salesOwnerId: `acct_${member}` }), 'owner-device');
  await expect(scoped.收范围推送(owner, team, 'owner-device', [{ ...别人的, eventId: p.eventId }])).rejects.toMatchObject({ 状态: 409 });
});
/*
  索引缓存（2026-10-21，tenant/scoped-index.ts）：目录、拉取不再每次整表读，改从缓存出。下面三条守住它不出错：
  转走那一刻正在拉的人拿不到转走之后的批次；目录只发变了的；缓存给的和现读现算的一模一样
*/
it('索引缓存：转走客户的同时正在拉的人，拿不到转走之后的任何一批；转走后再拉 403', async () => {
  for (let i = 0; i < 12; i++) {
    const k = `race-cache-${i}`;
    await push(other, 'other-device', event('Customer', k, { salesOwnerId: `acct_${other}` }));
    await scoped.范围目录(other, team); // 先把缓存热起来
    const 转走前 = (await control.syncScopedBatch.findFirstOrThrow({ where: { teamId: team }, orderBy: { id: 'desc' } })).id;
    const 转走 = [packet(event('Customer', k, { salesOwnerId: `acct_${owner}` }, 'U'), 'owner-device'), packet(event('FollowUp', `${k}-secret`, { customerId: k, ownerId: `acct_${owner}` }), 'owner-device')];
    const [拉, 推] = await Promise.allSettled([scoped.给范围拉取(other, team, `Customer:${k}`, 0), scoped.收范围推送(owner, team, 'owner-device', 转走)]);
    expect(推.status).toBe('fulfilled');
    if (拉.status === 'fulfilled') expect(拉.value.batches.every(b => b.seq <= 转走前)).toBe(true);
    else expect(拉.reason).toMatchObject({ 状态: 403 });
    await expect(scoped.给范围拉取(other, team, `Customer:${k}`, 0)).rejects.toMatchObject({ 状态: 403 });
  }
});
it('索引缓存：拉取拿到索引后、读批次前客户被转走（每次都插在这一刻）：拿不到转走那一批，回 403', async () => {
  const k = 'race-exact';
  await push(other, 'other-device', event('Customer', k, { salesOwnerId: `acct_${other}` }));
  await push(other, 'other-device', event('FollowUp', `${k}-old`, { customerId: k, ownerId: `acct_${other}` }));
  await scoped.范围目录(other, team); // 缓存热着，拉取拿到的就是转走之前那份
  const 转走前 = (await control.syncScopedBatch.findFirstOrThrow({ where: { teamId: team }, orderBy: { id: 'desc' } })).id;
  let 推了 = false;
  钩.插一手 = async () => {
    await scoped.收范围推送(owner, team, 'owner-device', [packet(event('Customer', k, { salesOwnerId: `acct_${owner}` }, 'U'), 'owner-device'), packet(event('FollowUp', `${k}-old`, { customerId: k, ownerId: `acct_${owner}`, note: 'secret' } as Record<string, unknown>, 'U', ['note']), 'owner-device')]);
    推了 = true;
  };
  const 拉 = await scoped.给范围拉取(other, team, `Customer:${k}`, 0).then(v => v, (e: unknown) => e);
  expect(推了).toBe(true);
  // 没有「核版本、不一致重来」时，这里会拿到转走那一批和转走之后改的跟进（seq > 转走前）
  if (拉 && typeof 拉 === 'object' && 'batches' in 拉) expect((拉 as { batches: { seq: number }[] }).batches.filter(b => b.seq > 转走前)).toEqual([]);
  else expect(拉).toMatchObject({ 状态: 403 });
});
it('目录只发变了的：带上次的 token 来只拿变了的范围和看不到了的；token 对不上拿全的；每个范围带 head', async () => {
  const 目录 = (base?: string) => scoped.范围目录(other, team, { device: 'other-device', base }) as Promise<{ token: string; delta?: boolean; removed?: string[]; scopes: { id: string; head: number }[] }>;
  const d1 = await 目录();
  expect(d1.delta).toBeUndefined();
  const d2 = await 目录(d1.token);
  expect(d2).toMatchObject({ delta: true, scopes: [], removed: [] });
  await push(other, 'other-device', event('Customer', 'delta-new', { salesOwnerId: `acct_${other}` }));
  const d3 = await 目录(d2.token);
  expect(d3.delta).toBe(true);
  expect(d3.scopes.map(x => x.id)).toEqual(['Customer:delta-new']);
  const 最新 = (await control.syncScopedBatch.findFirstOrThrow({ where: { teamId: team, recordKey: 'Customer:delta-new' }, orderBy: { id: 'desc' } })).id;
  expect(d3.scopes[0].head).toBe(最新);
  await push(owner, 'owner-device', event('Customer', 'delta-new', { salesOwnerId: `acct_${owner}` }, 'U'));
  const d4 = await 目录(d3.token);
  expect(d4).toMatchObject({ delta: true, scopes: [], removed: ['Customer:delta-new'] });
  // 拿旧 token 来（上一次回包丢了）：拿全的
  const d5 = await 目录(d3.token);
  expect(d5.delta).toBeUndefined();
  expect(d5.scopes.map(x => x.id).sort()).toEqual((await scoped.范围目录(other, team)).scopes.map(x => x.id).sort());
  // 老客户端不带设备号：全的、也不发 token
  expect(await scoped.范围目录(other, team)).not.toHaveProperty('token');
});
it('CRM_SCOPED_CACHE_OFF=1 回老路：目录内容和缓存给的一模一样，只是发全的、不带 token 和 head；拉取照常', async () => {
  // 范围的先后不算（客户端只要求「团队」排第一）：缓存里新记录排在后面，现读按键排
  const 去掉 = (d: Record<string, unknown>) => { const { token: _t, scopes, ...x } = d; return { ...x, scopes: (scopes as { id: string; head?: number }[]).map(({ head: _h, ...y }) => y).sort((a, b) => a.id.localeCompare(b.id)) }; };
  for (const [a, d] of [[owner, 'owner-device'], [other, 'other-device']]) {
    const 第一次 = await scoped.范围目录(a, team, { device: d }) as { token: string };
    const 缓存的 = 去掉(await scoped.范围目录(a, team) as Record<string, unknown>);
    process.env.CRM_SCOPED_CACHE_OFF = '1';
    try {
      const 老路 = await scoped.范围目录(a, team, { device: d, base: 第一次.token }) as Record<string, unknown> & { scopes: Record<string, unknown>[] };
      expect(老路).not.toHaveProperty('token'); expect(老路).not.toHaveProperty('delta');
      expect(老路.scopes.length).toBeGreaterThan(0);
      for (const x of 老路.scopes) expect(x).not.toHaveProperty('head');
      expect(去掉(老路)).toEqual(缓存的);
      const 一个 = 老路.scopes.find(x => x.id !== 'team')!;
      expect((await scoped.给范围拉取(a, team, 一个.id as string, 0)).batches.length).toBeGreaterThan(0);
    } finally { delete process.env.CRM_SCOPED_CACHE_OFF; }
  }
});
it('灰度开关关闭且团队未迁移：不能开始迁移', async () => {
  const t = await relay.建团队(other, 'flag-off', { device: 'flag-dev', pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error);
  await relay.设开通(t.teamId, true);
  delete process.env.CRM_SCOPED_SYNC;
  try {
    await expect(scoped.开始范围迁移(other, t.teamId, 'flag-dev')).rejects.toMatchObject({ 状态: 404 });
    expect(await scoped.范围开放(t.teamId)).toBe(false);
    expect(await scoped.范围开放(team)).toBe(true);
  } finally { process.env.CRM_SCOPED_SYNC = '1'; }
});
it('开关开、团队还没迁移：业务员旧接口的话要老板升级并打开；例外名单里的团队照旧协议', async () => {
  const t = await relay.建团队(other, 'not-yet', { device: 'ny-dev', pubKey: 设备钥匙对().公钥 });
  if (!t.ok) throw Error(t.error);
  await relay.入队(owner, t.teamId, t.joinSecret, { device: 'ny-member', pubKey: 设备钥匙对().公钥 });
  await relay.设开通(t.teamId, true);
  const r = await relay.给拉取(owner, t.teamId, 0);
  expect(r).toMatchObject({ ok: false, 状态: 409 });
  expect(!r.ok && r.error).toMatch(/老板.*最新版/);
  expect(await scoped.范围状态(other, t.teamId)).toMatchObject({ stage: 'legacy', enabled: true, owner: true });
  process.env.CRM_SCOPED_SYNC_LEGACY_TEAMS = `x-team, ${t.teamId}`;
  try {
    expect(await scoped.范围状态(other, t.teamId)).toMatchObject({ stage: 'legacy', enabled: false });
    expect(await scoped.范围开放(t.teamId)).toBe(false);
    await expect(scoped.开始范围迁移(other, t.teamId, 'ny-dev')).rejects.toMatchObject({ 状态: 404 });
    expect(await relay.给拉取(owner, t.teamId, 0)).toMatchObject({ ok: true });
    // 已迁移的团队不受例外名单影响：不能退回全队包
    process.env.CRM_SCOPED_SYNC_LEGACY_TEAMS = team;
    expect(await scoped.范围开放(team)).toBe(true);
    expect(await scoped.范围状态(owner, team)).toMatchObject({ stage: 'ready', enabled: true });
  } finally { delete process.env.CRM_SCOPED_SYNC_LEGACY_TEAMS; }
});
it('人多放慢（2026-10-21）：目录里带 pace，不到 10 人 0、10 人起 20 秒、20 人起 30 秒', async () => {
  const 人数 = () => control.syncMember.count({ where: { teamId: team, leftAt: null } });
  expect(await 人数()).toBeLessThan(10);
  expect(await scoped.范围目录(owner, team)).toMatchObject({ pace: 0 });
  const 加到 = async (n: number) => {
    while ((await 人数()) < n) {
      const a = await control.account.create({ data: { name: 'pace', email: `pace${await 人数()}@example.invalid`, password: 'not-a-login' } });
      await control.syncMember.create({ data: { teamId: team, accountId: a.id } });
    }
  };
  await 加到(9); expect(await scoped.范围目录(owner, team)).toMatchObject({ pace: 0 });
  await 加到(10); expect(await scoped.范围目录(owner, team)).toMatchObject({ pace: 20 });
  await 加到(20); expect(await scoped.范围目录(owner, team)).toMatchObject({ pace: 30 });
  process.env.CRM_SYNC_PACE_OFF = '1';
  try { expect(await scoped.范围目录(owner, team)).toMatchObject({ pace: 0 }); } finally { delete process.env.CRM_SYNC_PACE_OFF; }
});
