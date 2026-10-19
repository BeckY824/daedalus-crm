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
import { 当前编号, 在队里, 设备还在, 记设备在用 } from "./sync-relay";
import { 范围开关 } from "./scoped-flag";
import { 能同步 } from "./team-plan";
import { 包的编号 } from "../sync/crypto";
import { 合并范围, 推送可写, 挂在已删的上, 算范围, 范围可读, 范围字段, 行键, type 范围元数据, type 范围索引, type 范围行表 } from "../sync/scope-policy";

/** denied：403 时被拒的包在本次 packets 里的下标（整批已回滚）；新客户端据此只把这几条转冲突、其余原样重推 */
/** gone：denied 里挂在已删客户 / 商机下面的那几包（2026-10-19），手机据此说清「客户已被删」，不是「不归你了」 */
export class 范围错误 extends Error { constructor(public 状态: number, message: string, public denied?: number[], public gone?: number[]) { super(message); } }
/** 一次推送最多几包：转交 / 领取那一批要和它的起点快照放进同一次请求（见 推送可写），起点可能有几百包 */
export const 范围单次上限 = 1000;
function fail(status: number, message: string, denied?: number[], gone?: number[]): never { throw new 范围错误(status, message, denied, gone); }
const 根 = () => path.join(process.env.SYNC_DIR ?? path.join(workspaceDir(), "sync"), "scoped");
const file = (digest: string) => path.join(根(), `${digest}.bin`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** baseline = 这一包是某条记录当前状态的字段钟快照（改归属 / 进出公海后由有权设备补发） */
export type 范围包 = { meta: 范围元数据; eventId: string; data: string; baseline?: boolean };
type Db = typeof control | Prisma.TransactionClient;
async function auth(accountId: string, teamId: string, device?: string, db: Db = control) {
  const t = await db.syncTeam.findUnique({ where: { id: teamId } });
  const m = await db.syncMember.findUnique({ where: { teamId_accountId: { teamId, accountId } } });
  const account = await db.account.findUnique({ where: { id: accountId }, select: { active: true } });
  if (!account?.active) fail(403, "账号已停用，请联系管理员");
  if (!t || !m || m.leftAt) fail(403, "你不在这个团队里");
  // 没开通、停用、到期（2026-10-15）都在这一道闸
  const 闸 = await 能同步(t, db);
  if (闸) fail(402, 闸);
  if (device !== undefined) {
    const d = await db.syncDevice.findUnique({ where: { teamId_device: { teamId, device } } });
    if (!d || d.accountId !== accountId) fail(403, "设备身份不符，请重新加入团队");
  }
  return { owner: t.ownerAccountId === accountId, team: t };
}
async function indices(teamId: string, db: Db = control) {
  return new Map((await db.syncScopedRecord.findMany({ where: { teamId } })).map(r => [r.key, JSON.parse(r.metadata) as 范围索引]));
}
/**
 * 灰度开关（scoped-flag.ts）：CRM_SCOPED_SYNC=1 且团队不在 CRM_SCOPED_SYNC_LEGACY_TEAMS 里才能开始迁移；
 * 已开始/完成迁移的团队即使关了开关也继续走新协议（不能退回全队包）
 */
export { 范围开关 };
/**
 * 带着设备号来的请求（2026-10-15 多设备同步）：顺手记「这台最近在同步、用的哪枚令牌」；
 * 拉取、目录这两样原来不带设备号（只按账号核），在「我的设备」里被移除的那台用同一个账号重新登录还能拉——
 * 新客户端带上设备号，设备已经不在这个账号名下就挡下。老客户端不带，照旧（它们的令牌在移除时已作废）
 */
export async function 核设备(accountId: string, teamId: string, device: unknown, tokenId?: string) {
  if (typeof device !== "string" || !device) return;
  /*
    人已经不在团队里（被老板移出、在别的设备上退出了）：设备也一起注销了，但不能说成「从我的设备里移除」——
    那是让人去点「退出团队」再连回来，人其实已经回不来了；手机上更是没有「设置 → 团队」。说「不在这个团队里」，
    桌面端据此自动退出、只留自己的，手机据此清掉数据（2026-10-16 团队版全面检验）
  */
  if (!(await 在队里(teamId, accountId))) fail(403, "你不在这个团队里了：可能被老板移出了，或者你在别的设备上退出了团队");
  if (!(await 设备还在(teamId, accountId, device))) fail(403, "这台设备已经从「我的设备」里移除，不能再同步：在「设置 → 团队」里点「退出团队」（只清这台电脑），再重新连接");
  await 记设备在用(teamId, accountId, device, tokenId);
}
export async function 范围开放(teamId: string) {
  return 范围开关(teamId) || !!(await control.syncPrivacy.findUnique({ where: { teamId } }));
}
export async function 范围状态(accountId: string, teamId: string) {
  const { owner } = await auth(accountId, teamId);
  const p = await control.syncPrivacy.findUnique({ where: { teamId } });
  // pushRule：服务端按「请求开始时的权限」核一次推送（推送可写），客户端才把转交和起点快照放进同一次请求；旧服务端没有这一项
  return { stage: p?.stage ?? "legacy", owner, enabled: 范围开关(teamId) || !!p, fence: p?.fence ?? 0, epoch: await 当前编号(teamId), device: owner ? p?.device ?? null : null, pushRule: "request-start", maxPackets: 范围单次上限 };
}
export async function 开始范围迁移(accountId: string, teamId: string, device: string) {
  const { owner } = await auth(accountId, teamId, device);
  if (!owner) fail(403, "请先由老板升级并迁移团队同步");
  if (!范围开关(teamId) && !(await control.syncPrivacy.findUnique({ where: { teamId } }))) fail(404, "范围同步尚未开放");
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
  if (packet.baseline !== undefined && typeof packet.baseline !== 'boolean') fail(400, "范围密文包格式不对");
  if (!/^[a-f0-9]{64}$/.test(packet.eventId) || typeof packet.data !== 'string' || packet.data.length > 8 * 1024 * 1024) fail(400, "范围密文包格式不对");
  // v4：AAD 绑定团队、设备、eventId 与元数据摘要；中转无钥匙不能验，接收端解密时验。旧版 v2/v3 一律拒收。
  if (Buffer.from(packet.data.slice(0, 8), 'base64url')[0] !== 4) fail(400, "范围密文必须绑定团队、设备和授权元数据");
}
export async function 收范围推送(accountId: string, teamId: string, device: string, packets: 范围包[]) {
  await auth(accountId, teamId, device);
  if (!Array.isArray(packets) || !packets.length || packets.length > 范围单次上限 || JSON.stringify(packets).length > 8 * 1024 * 1024) fail(413, "请分批推送范围改动");
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
    /*
      起点视图（推送可写 ②）：本次请求改过的记录记下开始时的样子；开始时还没有的，记它第一次被接受时的那一版。
      没改过的记录直接读 rows（和开始时一样），不用整表复制。
    */
    const 原样 = new Map<string, 范围索引 | undefined>(), 新建 = new Map<string, 范围索引>();
    const start: 范围行表 = { get: k => (原样.has(k) ? 原样.get(k) ?? 新建.get(k) : rows.get(k)) };
    const 落 = (k: string, v: 范围索引) => {
      if (!原样.has(k)) { 原样.set(k, rows.get(k)); if (!rows.has(k)) 新建.set(k, v); }
      rows.set(k, v);
    };
    let stored = 0;
    type 一包 = { i: number; packet: 范围包; key: string; batchId: number };
    const 试 = async ({ packet, key, batchId }: 一包) => {
      const old = rows.get(key), n = 合并范围(old, packet.meta, batchId);
      // 这一包删除成了当前状态：记下批次号，拉取时直接给这一包（见 给范围拉取），不用回头翻批次
      if (packet.meta.o === 'D' && n.deleted && n.clock === packet.meta.h) n.delSeq = batchId;
      if (p.stage === 'ready' && !推送可写(start, rows, n, accountId, owner)) return false;
      落(key, n); stored++;
      await tx.syncScopedRecord.upsert({ where: { teamId_key: { teamId, key } }, create: { teamId, key, metadata: JSON.stringify(n) }, update: { metadata: JSON.stringify(n) } });
      if (packet.baseline) await tx.syncScopedBaseline.create({ data: { teamId, recordKey: key, batchId } });
      // 进出公海也是改范围：客户的路由版本跟着变，新获权的人只从之后的起点拉
      if (p.stage === 'ready' && !packet.baseline && packet.meta.t === 'CustomerPool' && (old ? old.deleted !== n.deleted : !n.deleted)) {
        const ck = 行键('Customer', packet.meta.k), c = rows.get(ck);
        if (c) { const nc = { ...c, routeSeq: Math.max(c.routeSeq, batchId) }; 落(ck, nc); await tx.syncScopedRecord.update({ where: { teamId_key: { teamId, key: ck } }, data: { metadata: JSON.stringify(nc) } }); }
      }
      return true;
    };
    const 待定: 一包[] = [];
    for (const [i, { packet, digest }] of prepared.entries()) {
      const duplicate = await tx.syncScopedBatch.findUnique({ where: { teamId_device_eventId: { teamId, device, eventId: packet.eventId } } });
      if (duplicate) {
        // 同一事件重发必须逐字节相同；否则可借旧 eventId 换掉已授权过的密文
        if (duplicate.metadata !== JSON.stringify(packet.meta) || duplicate.digest !== digest) fail(409, "重复事件的范围信息不一致");
        continue;
      }
      const key = 行键(packet.meta.t, packet.meta.k);
      const b = await tx.syncScopedBatch.create({ data: { teamId, device, accountId, recordKey: key, eventId: packet.eventId, metadata: JSON.stringify(packet.meta), digest } });
      const x = { i, packet, key, batchId: b.id };
      // 被拒的先不落（后面的包按「没有它」核），挪到本次请求末尾再核
      if (!(await 试(x))) 待定.push(x);
    }
    /*
      挪到末尾再核，直到没有进展：等于把这几包排到同一次请求的最后。例如旧版本客户端领取时先删公海、后改负责人——
      删公海那一包要求删完客户仍归自己，排到改负责人之后就成立。每一包仍按 推送可写 核，不多给权限。
    */
    for (let 有进展 = true; 有进展 && 待定.length;) {
      有进展 = false;
      for (const x of [...待定]) if (await 试(x)) { 待定.splice(待定.indexOf(x), 1); 有进展 = true; }
    }
    // 仍被拒：全部报出来（下标），整批回滚——新客户端只把这几条转成冲突、其余重推
    if (待定.length) {
      const gone = 待定.filter(x => 挂在已删的上(合并范围(rows.get(x.key), x.packet.meta, x.batchId), rows)).map(x => x.i);
      fail(403, "该记录已不在你的同步权限范围内，未上传改动已保留", 待定.map(x => x.i), gone);
    }
    // stored = 本次新落库条数（重发的不算），客户端据此累计迁移批次数，回包丢失重试也不会重复计数
    return { received: packets.length, stored };
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
  return control.$transaction(tx => 目录里(accountId, teamId, tx, true));
}
/** 要补起点：只有 directory 动作算 needBaseline；拉取每个范围都会重算目录，不跟着多查 */
async function 目录里(accountId: string, teamId: string, db: Db, 要补起点 = false) {
  const { owner, team } = await auth(accountId, teamId, undefined, db);
  const p = await db.syncPrivacy.findUnique({ where: { teamId } });
  if (p?.stage !== 'ready') fail(409, "请等待老板完成团队范围迁移");
  const rows = await indices(teamId, db);
  const scopes = new Map<string, { id: string; revision: number; records: 范围索引[] }>();
  const 老板 = `acct_${team.ownerAccountId}`;
  const 候选 = new Map<string, number>();
  for (const r of rows.values()) {
    const scope = 算范围(r, rows);
    if (!范围可读(scope, accountId, owner) || !scope) continue;
    const s = scopes.get(scope.id) ?? { id: scope.id, revision: 0, records: [] };
    s.revision = Math.max(s.revision, scope.routeSeq); s.records.push(r); scopes.set(scope.id, s);
    if (owner && 要补起点 && !r.deleted && scope.routeSeq > 0 && (scope.public || scope.owners.some(o => o !== 老板))) 候选.set(行键(r.t, r.k), scope.routeSeq);
  }
  /*
    老板那台补起点（2026-10-14）：改过归属、有业务员看得到、改归属之前有过批次（改归属之后才新建的不需要，见 给范围拉取）、
    却还没有「改归属之后的起点」的记录——交出去的人推不了（旧版客户端、起点太大没跟转交放进同一次请求），接手的人就一直拉不到。
    老板收全队、永远有权写，由它补。只查改过归属的那些记录，按块一次查，不逐条查。
  */
  const needBaseline: string[] = [];
  const keys = [...候选.keys()];
  for (let i = 0; i < keys.length && needBaseline.length < 500; i += 400) {
    const part = keys.slice(i, i + 400);
    const 起点 = new Map((await db.syncScopedBaseline.groupBy({ by: ['recordKey'], where: { teamId, recordKey: { in: part } }, _max: { batchId: true } })).map(x => [x.recordKey, x._max.batchId ?? 0]));
    const 缺 = part.filter(k => (起点.get(k) ?? 0) < 候选.get(k)!);
    if (!缺.length) continue;
    for (const x of await db.syncScopedBatch.groupBy({ by: ['recordKey'], where: { teamId, recordKey: { in: 缺 } }, _min: { id: true } })) {
      if ((x._min.id ?? Infinity) < 候选.get(x.recordKey)! && needBaseline.length < 500) needBaseline.push(x.recordKey);
    }
  }
  /*
    「团队」范围（成员、设置、渠道、供应商）放最前（2026-10-15）：客户端照目录的顺序拉，原来按记录键字母序，
    「Customer:…」排在「User:…」前面——新同事加入后马上录了客户、老板这段时间没同步，老板就先收到客户、后收到同事的账号行，
    回放时负责人在本机不存在，整批客户当孤儿永久跳过（tests/sync-scoped-join-order.test.ts）
  */
  const 排好 = [...scopes.values()].sort((a, b) => Number(b.id === "team") - Number(a.id === "team"));
  return { owner, scopes: 排好, epoch: (await db.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: 'desc' } }))?.epoch ?? 0, ...(owner && 要补起点 ? { needBaseline } : {}) };
}
/** 这条记录在改归属（threshold）之前有没有批次：有 = 新获权的人需要一份起点，没有 = 整段历史都在改归属之后 */
const 有更早批次 = async (db: Db, teamId: string, recordKey: string, threshold: number) => !!(await db.syncScopedBatch.findFirst({ where: { teamId, recordKey, id: { lt: threshold } }, select: { id: true } }));
/**
 * 把这条记录删成现在这样的那一包（删除、字段钟等于索引里的当前钟）；找不到 = 不给。
 * 2026-10-14 起索引里直接记 delSeq（收范围推送），不用查库；之前建的索引没有，才按记录翻它的批次（只认删除包，分页翻完，不设固定回看条数——
 * 删除之后又来几十条更早字段钟的改动也不会把它挤出去）。
 */
async function 当前删除包(db: Db, teamId: string, r: 范围索引) {
  const recordKey = 行键(r.t, r.k);
  // delSeq 只在「这一包删除成了当前状态」时写（删除包按 validate 不带归属字段）；之后被改回来 deleted 就是 false、用不到它，
  // 更新的删除会覆盖它——所以直接用，不再查库
  if (r.delSeq) return r.delSeq;
  for (let before = Number.MAX_SAFE_INTEGER; ;) {
    const page = await db.syncScopedBatch.findMany({ where: { teamId, recordKey, id: { lt: before } }, orderBy: { id: 'desc' }, take: 200, select: { id: true, metadata: true } });
    for (const b of page) {
      const m = JSON.parse(b.metadata) as 范围元数据;
      if (m.o === 'D' && m.h === r.clock && !Object.keys(m.fields ?? {}).length) return b.id;
    }
    if (page.length < 200) return null;
    before = page[page.length - 1].id;
  }
}
export async function 给范围拉取(accountId: string, teamId: string, scopeId: string, after: number) {
  return control.$transaction(async tx => {
  const directory = await 目录里(accountId, teamId, tx);
  const scope = directory.scopes.find(s => s.id === scopeId);
  if (!scope) fail(403, "该范围不在你的同步权限内");
  const from = Math.max(0, Math.floor(after) || 0);
  /*
    改过归属（含父链、进出公海）的记录：非老板只从「改归属之后的第一个起点快照」开始拉，
    失权期间（不在本范围时）的历史密文不下发；起点还没补上的记录这一轮先不给，游标不受影响。
    老板本来就看全队，照旧给全部历史。
  */
  const rows = directory.owner ? null : await indices(teamId, tx);
  const starts: { key: string; gt: number; only?: number }[] = [];
  for (const r of scope.records) {
    const key = 行键(r.t, r.k);
    const threshold = rows ? (算范围(r, rows)?.routeSeq ?? 0) : 0;
    if (!threshold) { starts.push({ key, gt: from }); continue; }
    const base = await tx.syncScopedBaseline.findFirst({ where: { teamId, recordKey: key, batchId: { gte: threshold } }, orderBy: { batchId: 'asc' } });
    if (base) starts.push({ key, gt: Math.max(from, base.batchId - 1) });
    // 改归属之后才新建的记录（例如领到 / 接手之后老板给这位客户记的跟进）：整段历史都在改归属之后，不需要起点，从改归属那一刻起给（2026-10-14）
    else if (!(await 有更早批次(tx, teamId, key, threshold))) starts.push({ key, gt: Math.max(from, threshold - 1) });
    /*
      已删除、又没有改归属之后起点的记录（起点快照只拍活着的行）：只给「把它删掉的那一包」（2026-10-14 候选 6 实机：
      同一账号的另一台电脑领取后，这台的公海那一行永远收不到删除、客户一直挂在公海页签）。
      删除包不带内容：元数据只有表名、编号、字段钟（目录里本来就给），密文里的整行接收端要求为空（验收范围包），
      所以不会因此拿到失权期间的任何历史。
    */
    else if (r.deleted) {
      const d = await 当前删除包(tx, teamId, r);
      if (d && d > from) starts.push({ key, gt: from, only: d });
    }
  }
  const batches = [];
  // 避开 SQLite 的变量个数上限，各分块取最早 201 条，再整体截到 200。
  for (let i = 0; i < starts.length; i += 200) batches.push(...await tx.syncScopedBatch.findMany({ where: { teamId, OR: starts.slice(i, i + 200).map(x => (x.only ? { recordKey: x.key, id: x.only } : { recordKey: x.key, id: { gt: x.gt } })) }, orderBy: { id: 'asc' }, take: 201 }));
  batches.sort((a, b) => a.id - b.id);
  return { epoch: directory.epoch, revision: scope.revision, more: batches.length > 200, batches: batches.slice(0, 200).map(b => {
    let data: string; try { data = fs.readFileSync(file(b.digest), 'utf8'); } catch { return fail(503, "范围密文暂不可读，请稍后重试；游标未跳过"); }
    if (sha(data) !== b.digest) fail(503, "范围密文校验失败；游标未跳过");
    return { seq: b.id, device: b.device, eventId: b.eventId, meta: JSON.parse(b.metadata) as 范围元数据, data };
  }) };
  }, { timeout: 60_000 });
}
