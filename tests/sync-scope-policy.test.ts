import { expect, it } from "vitest";
import { 同步表 } from "@/lib/sync/tables";
import { 合并范围, 提取范围, 推送可写, 算范围, 范围可读, 范围可写, 核对范围, 范围字段, 行键, type 范围索引 } from "@/lib/sync/scope-policy";
import type { 改动 } from "@/lib/sync/local";
const event = (t: string, k: string, r: Record<string, unknown>, c = Object.keys(r), h = "1700000000000-test"): 改动 => ({ t, k, r, c, h, o: "I" });
const index = (t: string, k: string, r: Record<string, unknown>) => 合并范围(undefined, 提取范围(event(t, k, r)), 1);
function fixture() {
  const rows = new Map<string, 范围索引>();
  for (const r of [index('Customer', 'boss', { salesOwnerId: 'acct_boss' }), index('Customer', 'one', { salesOwnerId: 'acct_one' }), index('Customer', 'two', { salesOwnerId: 'acct_two' }), index('Customer', 'public', { salesOwnerId: 'acct_boss' }), index('CustomerPool', 'public', { customerId: 'public' })]) rows.set(行键(r.t, r.k), r);
  return rows;
}
it('同步表全部有明确范围，新增表不能默认为公开', () => expect(Object.keys(范围字段).sort()).toEqual([...同步表].sort()));
it('老板全队，业务员只限本人/渠道负责人及公海；改本机角色无参与判断', () => {
  const rows = fixture();
  for (const [id, visible] of [['boss', false], ['one', true], ['two', false], ['public', true]] as const) {
    const scope = 算范围(rows.get(`Customer:${id}`)!, rows);
    expect(范围可读(scope, 'one', false)).toBe(visible); expect(范围可读(scope, 'boss', true)).toBe(true);
  }
  const r = index('Customer', 'channel', { salesOwnerId: 'acct_boss', channelOwnerId: 'acct_one' }); rows.set('Customer:channel', r);
  expect(范围可读(算范围(r, rows), 'one', false)).toBe(true);
});
it('不能伪造归属、塞公海记录或关联新联系人来抢老板私客', () => {
  const rows = fixture(), old = rows.get('Customer:boss')!;
  const n = 合并范围(old, 提取范围(event('Customer', 'boss', { salesOwnerId: 'acct_one' }, ['salesOwnerId'], '1800000000000-test')), 4);
  expect(范围可写(old, n, rows, 'one', false)).toBe(false);
  for (const r of [index('CustomerPool', 'boss', { customerId: 'boss' }), index('Contact', 'fake', { customerId: 'boss' }), index('Opportunity', 'fake', { customerId: 'boss' })]) expect(范围可写(undefined, r, rows, 'one', false)).toBe(false);
});
it('转交后失权，旧离线整行非归属修改不会把新负责人改回去', () => {
  const rows = fixture(), old = rows.get('Customer:one')!;
  const transfer: 改动 = { ...event('Customer', 'one', { salesOwnerId: 'acct_two' }), o: 'U', h: '1900000000000-test' };
  const n = 合并范围(old, 提取范围(transfer), 12);
  expect(范围可写(old, n, rows, 'one', false)).toBe(true); rows.set('Customer:one', n);
  const offline: 改动 = { ...event('Customer', 'one', { salesOwnerId: 'acct_one', remark: '自己的离线改动' }, ['remark'], '1800000000000-test'), o: 'U' };
  const merged = 合并范围(n, 提取范围(offline), 13);
  expect(merged.fields.salesOwnerId).toBe('acct_two');
  expect(范围可读(算范围(merged, rows), 'one', false)).toBe(false);
});
it('公海领取需原有公海权限；领取完成后其他业务员不能继续下载', () => {
  const rows = fixture(); const c = rows.get('Customer:public')!;
  rows.set('Customer:public', 合并范围(c, 提取范围({ ...event('Customer', 'public', { salesOwnerId: 'acct_one' }), o: 'U', h: '1800000000000-test' }), 6));
  const pool = rows.get('CustomerPool:public')!;
  const deleted = 合并范围(pool, { t: 'CustomerPool', k: 'public', o: 'D', h: '1800000000001-test', fields: {} }, 7);
  expect(范围可写(pool, deleted, rows, 'one', false)).toBe(true); rows.set('CustomerPool:public', deleted);
  expect(范围可读(算范围(c, rows), 'two', false)).toBe(false);
});
it('商机/签约/订单父链必须属于同一客户；循环/未知父链均拒绝', () => {
  const rows = fixture();
  const op = index('Opportunity', 'op', { customerId: 'one' }); rows.set('Opportunity:op', op);
  const contract = index('Contract', 'contract', { customerId: 'boss' }); rows.set('Contract:contract', contract);
  const bad = index('ContractWin', 'op', { opportunityId: 'op', contractId: 'contract' });
  expect(算范围(bad, rows)).toBeNull();
  expect(算范围(index('QuoteLine', 'line', { quoteId: 'missing' }), rows)).toBeNull();
});
it('元数据不含姓名/电话/备注，接收端拒绝密文和外层编号/范围不一致', () => {
  const e = event('Customer', 'one', { id: 'one', salesOwnerId: 'acct_one', name: 'QA私客', phone: '13900001611', remark: '私有跟进' });
  const meta = 提取范围(e); expect(JSON.stringify(meta)).not.toMatch(/QA私客|13900001611|私有跟进/);
  expect(核对范围(meta, e)).toBe(true); expect(核对范围({ ...meta, k: 'boss' }, e)).toBe(false);
  expect(核对范围(meta, { ...e, r: { ...e.r, salesOwnerId: 'acct_boss' } })).toBe(false);
});
it('推送可写：转交之后同一次请求里还能改子记录（按请求开始时的权限），但请求开始时就不可读的私客怎么都不行', () => {
  const start = fixture();
  const plan = index('FollowPlan', 'p1', { customerId: 'one' }); start.set('FollowPlan:p1', plan);
  const rows = new Map(start);
  // 本次请求里先把 one 交给 two
  rows.set('Customer:one', 合并范围(start.get('Customer:one'), 提取范围({ ...event('Customer', 'one', { salesOwnerId: 'acct_two' }), o: 'U', h: '1900000000000-test' }), 9));
  const planU = 合并范围(rows.get('FollowPlan:p1'), 提取范围({ ...event('FollowPlan', 'p1', { ownerId: 'acct_two' }, ['ownerId']), o: 'U', h: '1900000000001-test' }), 10);
  expect(范围可写(rows.get('FollowPlan:p1'), planU, rows, 'one', false)).toBe(false); // 只按当前：被拒（原来的 Bug 2）
  expect(推送可写(start, rows, planU, 'one', false)).toBe(true);
  // 私客：开始时就不可读，两种状态都拒
  const boss = 合并范围(start.get('Customer:boss'), 提取范围({ ...event('Customer', 'boss', { salesOwnerId: 'acct_one' }), o: 'U', h: '1900000000002-test' }), 11);
  expect(推送可写(start, rows, boss, 'one', false)).toBe(false);
  const fakePool = index('CustomerPool', 'boss', { customerId: 'boss' });
  expect(推送可写(start, rows, fakePool, 'one', false)).toBe(false);
  // 子记录挪进私客：拒
  const move = 合并范围(plan, 提取范围({ ...event('FollowPlan', 'p1', { customerId: 'boss' }), o: 'U', h: '1900000000003-test' }), 12);
  expect(推送可写(start, rows, move, 'one', false)).toBe(false);
  // 别的业务员（请求开始时也看不到 one）：拒
  expect(推送可写(start, rows, planU, 'three', false)).toBe(false);
  // 老板永远可写
  expect(推送可写(start, rows, boss, 'boss', true)).toBe(true);
});
