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
import { 当前编号, 互看, 在队里, 设备还在, 记设备在用 } from "./sync-relay";
import { 范围开关 } from "./scoped-flag";
import { 能同步 } from "./team-plan";
import { 团队索引, 缓存关着, 索引版本, 记改过, 推送开始, 推送结束, 有推送在途, 目录增量, type 范围组 } from "./scoped-index";
import { 包的编号 } from "../sync/crypto";
import { 合并范围, 推送可写, 挂在已删的上, 算范围, 范围可读, 范围字段, 行键, type 范围元数据, type 范围索引, type 范围行表 } from "../sync/scope-policy";
import { 查重单次上限, 查重一问上限, 查重哈希格式, type 查重条目, type 查重命中 } from "../sync/dedupe";

/** denied：403 时被拒的包在本次 packets 里的下标（整批已回滚）；新客户端据此只把这几条转冲突、其余原样重推 */
/** gone：denied 里挂在已删客户 / 商机下面的那几包（2026-10-19），手机据此说清「客户已被删」，不是「不归你了」 */
/** taken：这次推送想领的公海客户已被别人先领走（客户 id → 现在的负责人用户 id；2026-10-19「记跟进 = 领取」），客户端据此说「已被 X 先领走」 */
export class 范围错误 extends Error { constructor(public 状态: number, message: string, public denied?: number[], public gone?: number[], public taken?: Record<string, string>) { super(message); } }
/** 一次推送最多几包：转交 / 领取那一批要和它的起点快照放进同一次请求（见 推送可写），起点可能有几百包 */
export const 范围单次上限 = 1000;
function fail(status: number, message: string, denied?: number[], gone?: number[], taken?: Record<string, string>): never { throw new 范围错误(status, message, denied, gone, taken); }
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
  // share：团队开了「同事之间互相看得到客户」（2026-10-20）。老板本来就看全队，用不上
  // manager：业务主管（2026-10-20，老板在设置 → 团队里设）：读全队客户（不看开关），全队客户能改；业务配置、个人范围照旧不行
  const owner = t.ownerAccountId === accountId;
  return { owner, manager: !owner && m.role === "manager", team: t, share: await 互看(teamId, db) };
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
  const { owner, manager, share } = await auth(accountId, teamId);
  const p = await control.syncPrivacy.findUnique({ where: { teamId } });
  // pushRule：服务端按「请求开始时的权限」核一次推送（推送可写），客户端才把转交和起点快照放进同一次请求；旧服务端没有这一项
  return { stage: p?.stage ?? "legacy", owner, enabled: 范围开关(teamId) || !!p, fence: p?.fence ?? 0, epoch: await 当前编号(teamId), device: owner ? p?.device ?? null : null, pushRule: "request-start", maxPackets: 范围单次上限, share, manager };
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
  // 索引缓存（scoped-index.ts）：在途登记、提交前后各记一次改过的键
  let 改过: string[] = [];
  推送开始(teamId);
  try {
    const 回 = await 收范围推送事务(accountId, teamId, device, packets, epoch, prepared, (keys) => { 改过 = keys; 记改过(teamId, keys); });
    记改过(teamId, 改过);
    return 回;
  } finally {
    推送结束(teamId);
  }
}
async function 收范围推送事务(accountId: string, teamId: string, device: string, packets: 范围包[], epoch: number, prepared: { packet: 范围包; digest: string }[], 提交前: (keys: string[]) => void) {
  return control.$transaction(async tx => {
    const { owner, manager, share } = await auth(accountId, teamId, device, tx);
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
      if (p.stage === 'ready' && !推送可写(start, rows, n, accountId, owner, share, manager)) return false;
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
        /*
          同一事件重发：外层元数据必须一样，密文只认第一次收下的那份，这次的不落盘——借旧 eventId 换不掉已授权过的密文。
          不再要求密文逐字节相同（2026-10-21）：事件编号按内容算，重推时一样，但每次加密随机 IV、字节必然不同；
          原来回包一丢，下一轮重推就永久 409「重复事件的范围信息不一致」（老板卡在迁移、业务员再也推不上去）
        */
        if (duplicate.metadata !== JSON.stringify(packet.meta)) fail(409, "重复事件的范围信息不一致");
        stored++;
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
      /*
        领公海没抢到（2026-10-19「记跟进 = 领取」）：这次被拒的里有「删公海那一行」，客户已经出了公海、归了别人——
        只对这几位（刚才还在公海、人人看得到的）回现在的负责人，客户端说「已被 X 先领走」；别的私客不回
      */
      const taken: Record<string, string> = {};
      for (const x of 待定) {
        if (x.packet.meta.t !== "CustomerPool" || x.packet.meta.o !== "D") continue;
        const cust = rows.get(行键("Customer", x.packet.meta.k));
        const pool = rows.get(行键("CustomerPool", x.packet.meta.k));
        const who = cust?.fields.salesOwnerId;
        if (cust && !cust.deleted && (!pool || pool.deleted) && who && who !== `acct_${accountId}`) taken[x.packet.meta.k] = who;
      }
      fail(403, "该记录已不在你的同步权限范围内，未上传改动已保留", 待定.map(x => x.i), gone, Object.keys(taken).length ? taken : undefined);
    }
    /*
      stored = 这次请求里的包在中转上落着的条数（新落库的 + 这台以前推过、这次重发的），客户端据此累计迁移批次数、完成迁移时和中转对数。
      重发的也要算（2026-10-21）：会重发只有一种情况——上一次的回包这台没收到、没记进累计数；原来重发的不算，回包丢一次
      完成迁移就永远对不上数（「迁移批次不全」）。事件编号按内容 + 字段钟算，同一台不会有两条真的不同的改动撞编号
    */
    提交前([...原样.keys()]);
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
/**
 * 人多时前台放慢（2026-10-21 客户 Even 30 人压测的兜底）：壳在前台 8 秒戳一次本地服务，10 人起至少隔 15 秒才真同步一轮（实际约 16 秒）。
 * 本机实测 30 台、老板 1000 位老客户：没缓存时 8 秒一轮云端一个核打满，先定了 10 人 20 秒、20 人 30 秒；
 * 有了索引缓存（scoped-index.ts）不放慢空闲也只要 0.04 核，30 秒反倒让老板最慢 25–32 秒才看到业务员写的（要 20 秒内），改成 15 秒。
 * 改完 1.5 秒就推、「立即同步」不受它管（客户端 lib/sync/client.ts 该放慢）。由云端说，以后要调不用发客户端；单位秒，0 = 不放慢。
 * 云端设 CRM_SYNC_PACE_OFF=1 就全不放慢（有了索引缓存后压测对照用；正式服真要关也不用发版）
 */
export const 前台最短间隔 = (人数: number) =>
  process.env.CRM_SYNC_PACE_OFF === "1" ? 0 : 人数 >= 10 ? 15 : 0;
/**
 * 目录（2026-10-21 起从索引缓存出，见 scoped-index.ts）：这个人看得到的范围，每个带 revision（改归属后从头拉）、
 * head（这个范围最新的批次号：客户端游标已经到这儿就不用拉）和记录索引。
 * 带 device 和 base（上次目录回的 token）来的新客户端只拿变了的范围 + removed（看不到了的范围编号），delta = true；
 * 老客户端什么都不带，照旧拿全的
 */
export async function 范围目录(accountId: string, teamId: string, 选项: { device?: string; base?: unknown } = {}) {
  const { owner, manager, team, share } = await auth(accountId, teamId);
  const p = await control.syncPrivacy.findUnique({ where: { teamId } });
  if (p?.stage !== 'ready') fail(409, "请等待老板完成团队范围迁移");
  const e = await 团队索引(teamId);
  const 可读 = (x: 范围组) => 范围可读(x.scope, accountId, owner, share || manager);
  /*
    「团队」范围（成员、设置、渠道、供应商）放最前（2026-10-15）：客户端照目录的顺序拉，原来按记录键字母序，
    「Customer:…」排在「User:…」前面——新同事加入后马上录了客户、老板这段时间没同步，老板就先收到客户、后收到同事的账号行，
    回放时负责人在本机不存在，整批客户当孤儿永久跳过（tests/sync-scoped-join-order.test.ts）
  */
  const 看得到 = [...e.groups.values()].filter(可读).sort((a, b) => Number(b.id === "team") - Number(a.id === "team"));
  const 老路 = 缓存关着();
  const 增 = 目录增量(!老路 && typeof 选项.device === "string" ? `${teamId}|${accountId}|${选项.device}` : null, 选项.base, 看得到);
  const pace = 前台最短间隔(await control.syncMember.count({ where: { teamId, leftAt: null } }));
  return {
    owner, share, manager, pace,
    scopes: 增.scopes.map(x => ({ id: x.id, revision: x.revision, ...(老路 ? {} : { head: x.head }), records: x.records })),
    ...(增.token ? { token: 增.token } : {}),
    ...(增.delta ? { delta: true, removed: 增.removed } : {}),
    epoch: (await control.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: 'desc' } }))?.epoch ?? 0,
    ...(owner ? { needBaseline: await 要补起点(teamId, e, `acct_${team.ownerAccountId}`) } : {}),
  };
}
/*
  老板那台补起点（2026-10-14）：改过归属、有业务员看得到、改归属之前有过批次（改归属之后才新建的不需要，见 给范围拉取）、
  却还没有「改归属之后的起点」的记录——交出去的人推不了（旧版客户端、起点太大没跟转交放进同一次请求），接手的人就一直拉不到。
  老板收全队、永远有权写，由它补。只查改过归属的那些记录，按块一次查，不逐条查。
  起点和批次只随推送变（推送会让索引版本变），所以同一版索引只算一次（2026-10-21）
*/
const 补起点记 = new WeakMap<object, Promise<string[]>>();
function 要补起点(teamId: string, e: Awaited<ReturnType<typeof 团队索引>>, 老板: string): Promise<string[]> {
  let p = 补起点记.get(e);
  if (!p) { p = 算要补起点(teamId, e, 老板); 补起点记.set(e, p); p.catch(() => 补起点记.delete(e)); }
  return p;
}
async function 算要补起点(teamId: string, e: Awaited<ReturnType<typeof 团队索引>>, 老板: string) {
  const 候选 = new Map<string, number>();
  for (const [key, r] of e.rows) {
    const scope = e.归.get(key);
    if (scope && !r.deleted && scope.routeSeq > 0 && (scope.public || scope.owners.some(o => o !== 老板))) 候选.set(key, scope.routeSeq);
  }
  const needBaseline: string[] = [];
  const keys = [...候选.keys()];
  for (let i = 0; i < keys.length && needBaseline.length < 500; i += 400) {
    const part = keys.slice(i, i + 400);
    const 起点 = new Map((await control.syncScopedBaseline.groupBy({ by: ['recordKey'], where: { teamId, recordKey: { in: part } }, _max: { batchId: true } })).map(x => [x.recordKey, x._max.batchId ?? 0]));
    const 缺 = part.filter(k => (起点.get(k) ?? 0) < 候选.get(k)!);
    if (!缺.length) continue;
    for (const x of await control.syncScopedBatch.groupBy({ by: ['recordKey'], where: { teamId, recordKey: { in: 缺 } }, _min: { id: true } })) {
      if ((x._min.id ?? Infinity) < 候选.get(x.recordKey)! && needBaseline.length < 500) needBaseline.push(x.recordKey);
    }
  }
  return needBaseline;
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
/**
 * 拉一个范围（2026-10-21 起不再每次重算整份目录：范围和记录从索引缓存取，见 scoped-index.ts）。
 * 给出去的批次和判「这条记录在不在这个范围」用的索引必须是同一时刻的，否则转走的客户可能借旧缓存多拉到一条：
 * 有推送在途就等它结束；事务读完批次后索引版本变了（期间有推送提交）就整个重来
 */
export async function 给范围拉取(accountId: string, teamId: string, scopeId: string, after: number) {
  return 核着版本拉(teamId, async (e) => {
    const tx = control;
    const c = await 拉取前提(tx, accountId, teamId);
    const scope = e.groups.get(scopeId);
    if (!scope || !范围可读(scope.scope, accountId, c.owner, c.share || c.manager)) fail(403, "该范围不在你的同步权限内");
    return { epoch: c.epoch, revision: scope.revision, ...(await 范围批次(tx, teamId, c, scope, after, e, 范围每页)) };
  });
}
/**
 * 一次拉多个范围（2026-10-21 客户 Even 30 人压测：开互看后每位业务员要拉全队上千个客户范围，一个范围一个请求，
 * 29 台 × 1000 位就是近 3 万个请求，10 分钟一台都没拉齐）。权限、钥匙编号只查一次，同一份索引。
 * 整次最多 范围批量包上限 包（按批次号从小到大），给到一些没给完的范围回 more、一包没轮上的回 later，客户端下一个请求再要。
 * 一块范围一条查询，不再一个范围一条（压测：29 台同时开互看，一个范围一条查询时每个请求都超过 30 秒、客户端放弃重来、越堆越多）。
 * 额度 500 包（约半 MB）：1000 包时 29 台同时开互看，云端最慢一个请求（含排队）23 秒，离客户端的 30 秒超时太近；500 包时最慢 12 秒。
 * 看不到的范围不让整次失败：回 error 403，客户端照单个拉到 403 的办法处理（这一轮失败、下一轮新目录里就没有它了）
 */
export const 范围批量上限 = 500, 范围批量包上限 = 500;
let 批量包上限 = 范围批量包上限;
/** 测试用：把整次的包数额度调小，测截断 */
export function 设范围批量包上限(n = 范围批量包上限) { 批量包上限 = n; }
const 范围每页 = 200;
export type 批量拉取项 = { scopeId: string; revision?: number; more?: boolean; later?: true; error?: number; batches?: 拉出的包[] };
export async function 给多个范围拉取(accountId: string, teamId: string, items: unknown): Promise<{ epoch: number; scopes: 批量拉取项[] }> {
  if (!Array.isArray(items) || !items.length || items.length > 范围批量上限) fail(400, "范围拉取格式不对");
  const list = (items as { scopeId?: unknown; after?: unknown }[]).map((x) => {
    if (!x || typeof x.scopeId !== "string" || x.scopeId.length > 200) fail(400, "范围拉取格式不对");
    return { scopeId: x.scopeId as string, after: Number(x.after) || 0 };
  });
  return 核着版本拉(teamId, async (e) => {
    const tx = control;
    const c = await 拉取前提(tx, accountId, teamId);
    const 出 = new Map<string, 批量拉取项>();
    // 按整个范围凑块（一块最多 200 个起点）：一块一条查询，按批次号取最早的、整次最多 范围批量包上限 包。
    // 同一个范围不跨块——截在某一块时，每个范围给到的都是它自己批次号最小的那几包，游标前进不会越过没给的
    const 块: { scopeId: string; scope: 范围组; starts: 起点[] }[][] = [[]];
    let 块里起点 = 0;
    for (const { scopeId, after } of list) {
      const scope = e.groups.get(scopeId);
      if (!scope || !范围可读(scope.scope, accountId, c.owner, c.share || c.manager)) { 出.set(scopeId, { scopeId, error: 403 }); continue; }
      const starts = await 范围起点(tx, teamId, c, scope, after, e);
      if (!starts.length) { 出.set(scopeId, { scopeId, revision: scope.revision, more: false, batches: [] }); continue; }
      // 一个范围就超过 200 个起点（很少见）：单独照一个范围的办法给一页
      if (starts.length > 200) { 出.set(scopeId, { scopeId, revision: scope.revision, ...(await 范围批次(tx, teamId, c, scope, after, e, 范围每页)) }); continue; }
      if (块里起点 + starts.length > 200) { 块.push([]); 块里起点 = 0; }
      块.at(-1)!.push({ scopeId, scope, starts });
      块里起点 += starts.length;
    }
    let 余 = 批量包上限;
    for (let i = 0; i < 块.length; i++) {
      const 这块 = 块[i];
      if (!这块.length) continue;
      if (余 <= 0) { for (const x of 块.slice(i).flat()) 出.set(x.scopeId, { scopeId: x.scopeId, later: true }); break; }
      const 归 = new Map<string, string>();
      for (const x of 这块) for (const st of x.starts) 归.set(st.key, x.scopeId);
      let rows = await tx.syncScopedBatch.findMany({ where: { teamId, OR: 这块.flatMap((x) => x.starts.map(起点条件)) }, orderBy: { id: 'asc' }, take: 余 + 1 });
      const 截了 = rows.length > 余;
      if (截了) rows = rows.slice(0, 余);
      余 -= rows.length;
      const 分 = new Map<string, 拉出的包[]>();
      for (const r of rows) { const id = 归.get(r.recordKey)!; const xs = 分.get(id) ?? []; xs.push(读密文(r)); 分.set(id, xs); }
      for (const x of 这块) {
        const got = 分.get(x.scopeId) ?? [];
        // 截了：这块里给到一些的说 more（下一次接着要），一包都没轮上的说 later（游标不动、下一次再要）
        出.set(x.scopeId, 截了 && !got.length ? { scopeId: x.scopeId, later: true } : { scopeId: x.scopeId, revision: x.scope.revision, more: 截了, batches: got });
      }
      if (截了) { for (const x of 块.slice(i + 1).flat()) 出.set(x.scopeId, { scopeId: x.scopeId, later: true }); break; }
    }
    return { epoch: c.epoch, scopes: list.map(({ scopeId }) => 出.get(scopeId)!) };
  });
}
/*
  拉取不开事务（2026-10-21 30 台压测：开互看后几十台同时拉，交互事务在 SQLite 上排队，等不到 2 秒就 P2028，一批 503）。
  一致性靠的是 核着版本拉：推送提交之前就把版本加了，拉取读完才核版本，期间有任何推送提交都整个重来——
  所以读到的批次、起点、权限和用来判范围的索引一定是同一时刻的，不需要事务再包一层
*/
async function 核着版本拉<T>(teamId: string, 拉: (e: 团队索引类型) => Promise<T>): Promise<T> {
  for (let 次 = 0; 次 < 40; 次++) {
    if (有推送在途(teamId)) { await new Promise(r => setTimeout(r, 25)); continue; }
    const e = await 团队索引(teamId);
    if (有推送在途(teamId)) continue;
    const r = await 拉(e);
    if (e.ver === 索引版本(teamId) && !有推送在途(teamId)) return r;
  }
  return fail(503, "同步正忙，请稍后重试；游标未跳过");
}
type 团队索引类型 = Awaited<ReturnType<typeof 团队索引>>;
type 拉取身份 = { accountId: string; owner: boolean; manager: boolean; share: boolean; epoch: number };
async function 拉取前提(tx: Db, accountId: string, teamId: string): Promise<拉取身份> {
  const { owner, manager, share } = await auth(accountId, teamId, undefined, tx);
  const p = await tx.syncPrivacy.findUnique({ where: { teamId } });
  if (p?.stage !== 'ready') fail(409, "请等待老板完成团队范围迁移");
  const epoch = (await tx.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: 'desc' } }))?.epoch ?? 0;
  return { accountId, owner, manager, share, epoch };
}
type 拉出的包 = { seq: number; device: string; eventId: string; meta: 范围元数据; data: string };
/** 一个范围从 after 往后最多 页 包（多一包就 more） */
type 起点 = { key: string; gt: number; only?: number };
/** 这个范围里每条记录从哪个批次之后给（改过归属的非老板从起点给、删了的只给删除那一包） */
async function 范围起点(tx: Db, teamId: string, c: 拉取身份, scope: 范围组, after: number, e: 团队索引类型): Promise<起点[]> {
  const from = Math.max(0, Math.floor(after) || 0);
  /*
    改过归属（含父链、进出公海）的记录：非老板只从「改归属之后的第一个起点快照」开始拉，
    失权期间（不在本范围时）的历史密文不下发；起点还没补上的记录这一轮先不给，游标不受影响。
    老板本来就看全队，照旧给全部历史。
  */
  /*
    开了互看（2026-10-20）：业务员能读全队客户，同事客户的整段历史本来就在开关放行的范围里，和老板一样从头给，
    不按改归属的起点截——否则老板转给另一位业务员、没有业务员看得到过的客户，要等老板那台补完起点才拉得到
  */
  // 主管（2026-10-20）同理：刚被设成主管，全队客户从头给
  const 截 = !(c.owner || c.share || c.manager);
  const starts: 起点[] = [];
  for (const r of scope.records) {
    const key = 行键(r.t, r.k);
    // 这条记录最新的批次都不比游标新：没什么可给的，不用再查起点（2026-10-21：老板一轮拉上千个范围，绝大多数在这里就结束）
    if ((e.heads.get(key) ?? 0) <= from) continue;
    const threshold = 截 ? (e.归.get(key)?.routeSeq ?? 0) : 0;
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
  return starts;
}
const 起点条件 = (x: 起点) => (x.only ? { recordKey: x.key, id: x.only } : { recordKey: x.key, id: { gt: x.gt } });
type 批次行 = { id: number; device: string; eventId: string; metadata: string; digest: string };
const 读密文 = (b: 批次行): 拉出的包 => {
  let data: string; try { data = fs.readFileSync(file(b.digest), 'utf8'); } catch { return fail(503, "范围密文暂不可读，请稍后重试；游标未跳过"); }
  if (sha(data) !== b.digest) fail(503, "范围密文校验失败；游标未跳过");
  return { seq: b.id, device: b.device, eventId: b.eventId, meta: JSON.parse(b.metadata) as 范围元数据, data };
};
/** 一个范围从 after 往后最多 页 包（多一包就 more） */
async function 范围批次(tx: Db, teamId: string, c: 拉取身份, scope: 范围组, after: number, e: 团队索引类型, 页: number): Promise<{ more: boolean; batches: 拉出的包[] }> {
  const starts = await 范围起点(tx, teamId, c, scope, after, e);
  const batches = [];
  // 避开 SQLite 的变量个数上限，各分块取最早 页+1 条，再整体截到 页。
  for (let i = 0; i < starts.length; i += 200) batches.push(...await tx.syncScopedBatch.findMany({ where: { teamId, OR: starts.slice(i, i + 200).map(起点条件) }, orderBy: { id: 'asc' }, take: 页 + 1 }));
  batches.sort((a, b) => a.id - b.id);
  return { more: batches.length > 页, batches: batches.slice(0, 页).map(读密文) };
}
/* ---------------- 跨成员查重（2026-10-19，lib/sync/dedupe.ts） ---------------- */

/**
 * 各台上报自己库里客户的查重索引。只收这台看得到的客户（老板全部、成员本人 + 公海）：
 * 看不到的不收，免得拿一份过期的副本盖掉负责人那台报的。不是当前钥匙编号的整批不收（换钥匙后旧哈希对不上）。
 * 同一位客户整份替换：号码改了，旧哈希跟着没了
 */
export async function 收查重索引(accountId: string, teamId: string, device: string, entries: unknown): Promise<{ stored: number; skipped: string[] }> {
  const { owner, manager, share } = await auth(accountId, teamId, device);
  if (!Array.isArray(entries) || entries.length > 查重单次上限) fail(400, "查重索引格式不对");
  const epoch = await 当前编号(teamId);
  const 收: 查重条目[] = [];
  for (const e of entries as Partial<查重条目>[]) {
    if (!e || typeof e.k !== "string" || !/^[\w-]{1,100}$/.test(e.k) || e.epoch !== epoch) fail(400, "查重索引格式不对");
    if (!Array.isArray(e.hashes) || e.hashes.length > 查重一问上限 || !e.hashes.every((h) => typeof h === "string" && 查重哈希格式.test(h))) fail(400, "查重索引格式不对");
    if (typeof e.label !== "string" || e.label.length > 4000) fail(400, "查重索引格式不对");
    收.push(e as 查重条目);
  }
  const rows = await 查重用的行(teamId, 收.map((e) => e.k));
  let stored = 0; const skipped: string[] = [];
  await control.$transaction(async (tx) => {
    for (const e of 收) {
      const r = rows.get(行键("Customer", e.k));
      if (!r || r.deleted || !范围可读(算范围(r, rows), accountId, owner, share || manager)) { skipped.push(e.k); continue; }
      await tx.syncDedupeKey.deleteMany({ where: { teamId, recordKey: e.k } });
      if (e.hashes.length) await tx.syncDedupeKey.createMany({ data: [...new Set(e.hashes)].map((hash) => ({ teamId, recordKey: e.k, hash, epoch, label: e.label })) });
      stored++;
    }
    // 开互看后几十台同时报全队客户的查重索引（2026-10-21 压测）：写事务在 SQLite 上排队，默认 2 秒等不到就 P2028 → 503
  }, { maxWait: 15_000, timeout: 60_000 });
  return { stored, skipped };
}

/**
 * 录入前问一下：这几样哈希是不是同事名下的客户。只回问的人**看不到**的（看得到的本机自己就查到了），
 * 已删的、换钥匙前的不回。只给客户 id、负责人（用户 id，名字由本机同事名单取）、封好的客户名
 */
export async function 查查重(accountId: string, teamId: string, hashes: unknown): Promise<{ hits: 查重命中[] }> {
  const { owner, manager, share } = await auth(accountId, teamId);
  if (!Array.isArray(hashes) || hashes.length > 查重一问上限 || !hashes.every((h) => typeof h === "string" && 查重哈希格式.test(h))) fail(400, "查重请求格式不对");
  if (!hashes.length) return { hits: [] };
  const epoch = await 当前编号(teamId);
  const 撞 = await control.syncDedupeKey.findMany({ where: { teamId, epoch, hash: { in: hashes as string[] } }, select: { recordKey: true, label: true } });
  const rows = await 查重用的行(teamId, 撞.map((x) => x.recordKey));
  const hits: 查重命中[] = [];
  for (const x of 撞) {
    if (hits.some((h) => h.k === x.recordKey)) continue;
    const r = rows.get(行键("Customer", x.recordKey));
    if (!r || r.deleted) continue;
    if (范围可读(算范围(r, rows), accountId, owner, share || manager)) continue;
    hits.push({ k: x.recordKey, owner: r.fields.salesOwnerId ?? r.fields.channelOwnerId ?? "", label: x.label });
  }
  return { hits };
}

/** 判这几位客户归谁要用到的索引行：客户本身 + 它在不在公海 */
async function 查重用的行(teamId: string, ids: string[]): Promise<Map<string, 范围索引>> {
  const keys = [...new Set(ids)].flatMap((k) => [行键("Customer", k), 行键("CustomerPool", k)]);
  const 出 = new Map<string, 范围索引>();
  for (let i = 0; i < keys.length; i += 500) {
    for (const r of await control.syncScopedRecord.findMany({ where: { teamId, key: { in: keys.slice(i, i + 500) } } })) 出.set(r.key, JSON.parse(r.metadata) as 范围索引);
  }
  return 出;
}
