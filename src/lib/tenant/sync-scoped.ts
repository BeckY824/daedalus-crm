/** 服务端先认证、按当前归属核读写，再中转按单条记录加密的包。
 * 新包不得包含多条记录，否则转交其中一条后无法安全过滤历史密文。
 * 文件先原子落盘，索引与批次在一个 SQLite 事务内提交；失败仅留不可访问的孤儿文件。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { control } from "./control";
import type { Prisma } from "@/generated/control";
import { workspaceDir } from "./clients";
import { 当前编号 } from "./sync-relay";
import { 包的编号 } from "../sync/crypto";
import { 合并范围, 算范围, 范围可读, 范围可写, 范围字段, 行键, type 范围元数据, type 范围索引 } from "../sync/scope-policy";

export class 范围错误 extends Error { constructor(public 状态: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new 范围错误(status, message); }
const 根 = () => path.join(process.env.SYNC_DIR ?? path.join(workspaceDir(), "sync"), "scoped");
const file = (digest: string) => path.join(根(), `${digest}.bin`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export type 范围包 = { meta: 范围元数据; eventId: string; data: string };
type Db = typeof control | Prisma.TransactionClient;
async function auth(accountId: string, teamId: string, device?: string, db: Db = control) {
  const t = await db.syncTeam.findUnique({ where: { id: teamId } });
  const m = await db.syncMember.findUnique({ where: { teamId_accountId: { teamId, accountId } } });
  const account = await db.account.findUnique({ where: { id: accountId }, select: { active: true } });
  if (!account?.active) fail(403, "账号已停用，请联系管理员");
  if (!t || !m || m.leftAt) fail(403, "你不在这个团队里");
  if (!t.active) fail(402, "团队同步还没开通");
  if (device !== undefined) {
    const d = await db.syncDevice.findUnique({ where: { teamId_device: { teamId, device } } });
    if (!d || d.accountId !== accountId) fail(403, "设备身份不符，请重新加入团队");
  }
  return { owner: t.ownerAccountId === accountId, team: t };
}
async function indices(teamId: string, db: Db = control) {
  return new Map((await db.syncScopedRecord.findMany({ where: { teamId } })).map(r => [r.key, JSON.parse(r.metadata) as 范围索引]));
}
export async function 范围状态(accountId: string, teamId: string) {
  const { owner } = await auth(accountId, teamId);
  const p = await control.syncPrivacy.findUnique({ where: { teamId } });
  return { stage: p?.stage ?? "legacy", owner, fence: p?.fence ?? 0, epoch: await 当前编号(teamId) };
}
export async function 开始范围迁移(accountId: string, teamId: string, device: string) {
  const { owner } = await auth(accountId, teamId, device);
  if (!owner) fail(403, "请先由老板升级并迁移团队同步");
  // 旧推送的写事务也要核状态，确保 fence 后没有漏掉的旧包。
  return control.$transaction(async tx => {
    await auth(accountId, teamId, device, tx);
    const old = await tx.syncPrivacy.findUnique({ where: { teamId } });
    if (old) {
      if (old.stage === "building" && old.device !== device) fail(409, "团队迁移已在老板另一台设备开始，请在原设备继续");
      return { stage: old.stage, fence: old.fence };
    }
    const last = await tx.syncBatch.findFirst({ where: { teamId }, orderBy: { id: "desc" } });
    await tx.syncPrivacy.create({ data: { teamId, stage: "building", device, fence: last?.id ?? 0 } });
    return { stage: "building", fence: last?.id ?? 0 };
  });
}
function validate(packet: 范围包) {
  const m = packet?.meta;
  if (!m || !Object.hasOwn(范围字段, m.t) || typeof m.k !== 'string' || !/^[\w-]{1,100}$/.test(m.k) || !/^(I|U|D)$/.test(m.o) || typeof m.h !== 'string' || !/^\d{13,16}-[\w-]{1,100}$/.test(m.h)) fail(400, "范围事件格式不对");
  if (!m.fields || typeof m.fields !== "object" || Array.isArray(m.fields)) fail(400, "范围字段格式不对");
  for (const [k, v] of Object.entries(m.fields)) if (!范围字段[m.t].includes(k) || (v !== null && (typeof v !== 'string' || !/^[\w-]{1,100}$/.test(v)))) fail(400, "不允许的范围字段");
  if (m.o === 'D' && Object.keys(m.fields).length) fail(400, "删除事件不能改归属");
  if (!/^[a-f0-9]{64}$/.test(packet.eventId) || typeof packet.data !== 'string' || packet.data.length > 8 * 1024 * 1024) fail(400, "范围密文包格式不对");
  if (Buffer.from(packet.data, 'base64url')[0] !== 3) fail(400, "范围密文必须绑定团队和设备");
}
export async function 收范围推送(accountId: string, teamId: string, device: string, packets: 范围包[]) {
  await auth(accountId, teamId, device);
  if (!Array.isArray(packets) || !packets.length || packets.length > 100 || JSON.stringify(packets).length > 8 * 1024 * 1024) fail(413, "请分批推送范围改动");
  const epoch = await 当前编号(teamId);
  const prepared = packets.map(packet => {
    validate(packet);
    if (包的编号(packet.data) !== epoch) fail(409, "团队换过钥匙了，取到新钥匙再推");
    const digest = sha(packet.data); fs.mkdirSync(根(), { recursive: true });
    const f = file(digest), temp = `${f}.${randomUUID()}.tmp`;
    if (!fs.existsSync(f)) { fs.writeFileSync(temp, packet.data, { mode: 0o600 }); fs.renameSync(temp, f); }
    return { packet, digest };
  });
  return control.$transaction(async tx => {
    const { owner } = await auth(accountId, teamId, device, tx);
    const current = (await tx.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: 'desc' } }))?.epoch ?? 0;
    if (current !== epoch) fail(409, "团队换过钥匙了，取到新钥匙再推");
    const p = await tx.syncPrivacy.findUnique({ where: { teamId } });
    if (!p || (p.stage !== 'ready' && !(owner && p.device === device && p.stage === 'building'))) fail(409, "请等待老板完成团队范围迁移");
    const rows = new Map((await tx.syncScopedRecord.findMany({ where: { teamId } })).map(r => [r.key, JSON.parse(r.metadata) as 范围索引]));
    for (const { packet, digest } of prepared) {
      const duplicate = await tx.syncScopedBatch.findUnique({ where: { teamId_device_eventId: { teamId, device, eventId: packet.eventId } } });
      if (duplicate) {
        if (duplicate.metadata !== JSON.stringify(packet.meta)) fail(409, "重复事件的范围信息不一致");
        continue;
      }
      const key = 行键(packet.meta.t, packet.meta.k), old = rows.get(key);
      const b = await tx.syncScopedBatch.create({ data: { teamId, device, accountId, recordKey: key, eventId: packet.eventId, metadata: JSON.stringify(packet.meta), digest } });
      const n = 合并范围(old, packet.meta, b.id);
      if (p.stage === 'ready' && !范围可写(old, n, rows, accountId, owner)) fail(403, "该记录已不在你的同步权限范围内，未上传改动已保留");
      rows.set(key, n);
      await tx.syncScopedRecord.upsert({ where: { teamId_key: { teamId, key } }, create: { teamId, key, metadata: JSON.stringify(n) }, update: { metadata: JSON.stringify(n) } });
    }
    return { received: packets.length };
  }, { timeout: 60_000 });
}
export async function 完成范围迁移(accountId: string, teamId: string, device: string, count: number) {
  const { owner } = await auth(accountId, teamId, device);
  if (!owner) fail(403, "只有老板能完成迁移");
  return control.$transaction(async tx => {
    await auth(accountId, teamId, device, tx);
    const p = await tx.syncPrivacy.findUnique({ where: { teamId } });
    if (p?.stage === 'ready') return { stage: 'ready' };
    if (!p || p.device !== device) fail(409, "请在开始迁移的老板设备完成");
    if (await tx.syncScopedBatch.count({ where: { teamId } }) !== count) fail(409, "迁移批次不全，尚未开放业务员同步");
    const rows = new Map((await tx.syncScopedRecord.findMany({ where: { teamId } })).map(r => [r.key, JSON.parse(r.metadata) as 范围索引]));
    for (const r of rows.values()) if (!r.deleted && !算范围(r, rows)) fail(409, "迁移发现未归属的关联记录，请在老板端修复后继续");
    await tx.syncPrivacy.update({ where: { teamId }, data: { stage: 'ready' } });
    return { stage: 'ready' };
  });
}
export async function 范围目录(accountId: string, teamId: string) {
  return control.$transaction(tx => 目录里(accountId, teamId, tx));
}
async function 目录里(accountId: string, teamId: string, db: Db) {
  const { owner } = await auth(accountId, teamId, undefined, db);
  const p = await db.syncPrivacy.findUnique({ where: { teamId } });
  if (p?.stage !== 'ready') fail(409, "请等待老板完成团队范围迁移");
  const rows = await indices(teamId, db);
  const scopes = new Map<string, { id: string; revision: number; records: 范围索引[] }>();
  for (const r of rows.values()) {
    const scope = 算范围(r, rows);
    if (!范围可读(scope, accountId, owner) || !scope) continue;
    const s = scopes.get(scope.id) ?? { id: scope.id, revision: 0, records: [] };
    s.revision = Math.max(s.revision, scope.routeSeq); s.records.push(r); scopes.set(scope.id, s);
  }
  return { owner, scopes: [...scopes.values()], epoch: (await db.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: 'desc' } }))?.epoch ?? 0 };
}
export async function 给范围拉取(accountId: string, teamId: string, scopeId: string, after: number) {
  return control.$transaction(async tx => {
  const directory = await 目录里(accountId, teamId, tx);
  const scope = directory.scopes.find(s => s.id === scopeId);
  if (!scope) fail(403, "该范围不在你的同步权限内");
  const keys = scope.records.map(r => 行键(r.t, r.k));
  const batches = [];
  // 避开 SQLite 的变量个数上限，各分块取最早 201 条，再整体截到 200。
  for (let i = 0; i < keys.length; i += 400) batches.push(...await tx.syncScopedBatch.findMany({ where: { teamId, recordKey: { in: keys.slice(i, i + 400) }, id: { gt: Math.max(0, Math.floor(after) || 0) } }, orderBy: { id: 'asc' }, take: 201 }));
  batches.sort((a, b) => a.id - b.id);
  return { epoch: directory.epoch, revision: scope.revision, more: batches.length > 200, batches: batches.slice(0, 200).map(b => {
    let data: string; try { data = fs.readFileSync(file(b.digest), 'utf8'); } catch { return fail(503, "范围密文暂不可读，请稍后重试；游标未跳过"); }
    if (sha(data) !== b.digest) fail(503, "范围密文校验失败；游标未跳过");
    return { seq: b.id, device: b.device, meta: JSON.parse(b.metadata) as 范围元数据, data };
  }) };
  }, { timeout: 60_000 });
}
