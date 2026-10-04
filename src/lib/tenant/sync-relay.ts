/**
 * 团队同步的中转（云端这一半，2026-10-03，0.46.15 第 5 块）。
 *
 * 我们这里只做三件事：记谁在哪个团队、收一批密文存成文件、按序号发给团队里的别人。
 * **看不到客户**：钥匙只在成员电脑上。我们见到的只有团队编号、谁推的、哪台设备、序号、大小、时间。
 *
 * 新团队「待开通」，运营台开通后才收推送（收费，价格等备案——10-03 拍板）。建团队、入队、看成员不受这一条限制：
 * 人可以先把团队建好、把同事拉进来，等开通了一起开始同步。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { control } from "./control";
import { workspaceDir } from "./clients";
import { 包的编号 } from "@/lib/sync/crypto";

/** 一批最大多少（base64 之后）。一次推送 2000 条改动压缩加密后也就几百 KB；大了多半是出了问题 */
export const 一批上限 = 8 * 1024 * 1024;
/** 一次拉多少批 */
export const 一次拉 = 200;

const 同步目录 = () => process.env.SYNC_DIR ?? path.join(workspaceDir(), "sync");
const 指纹 = (s: string) => createHash("sha256").update(s).digest("hex");
const 安全名 = (id: string) => (/^[a-z0-9]{10,40}$/i.test(id) ? id : null);

type 结果<T> = ({ ok: true } & T) | { ok: false; 状态: number; error: string };
const 错 = (状态: number, error: string) => ({ ok: false as const, 状态, error });

async function 在队里(teamId: string, accountId: string) {
  const m = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId, accountId } } });
  return m && !m.leftAt ? m : null;
}

/** 设备：编号 + 公钥（建团队、加入时一起登记；换钥匙时据此给每台封一份） */
export type 设备 = { device: string; pubKey: string };
const 设备号对 = (d: unknown) => typeof d === "string" && /^[\w-]{4,64}$/.test(d);
const 公钥对 = (k: unknown) => typeof k === "string" && /^[\w-]{40,200}$/.test(k);

/** 登记一台设备。编号已经是别的账号的：不收（冒用的话，被冒用的那台会把这些批次当成自己推的跳过） */
async function 登记设备(teamId: string, accountId: string, d: 设备 | undefined): Promise<string | null> {
  if (!d) return null;
  if (!设备号对(d.device) || !公钥对(d.pubKey)) return "设备信息不对";
  const 已 = await control.syncDevice.findUnique({ where: { teamId_device: { teamId, device: d.device } } });
  if (已 && 已.accountId !== accountId) return "这个设备编号已经被团队里别人用了";
  await control.syncDevice.upsert({ where: { teamId_device: { teamId, device: d.device } }, update: { pubKey: d.pubKey }, create: { teamId, device: d.device, accountId, pubKey: d.pubKey } });
  return null;
}

/** 团队现在用第几把钥匙（没换过 = 0，就是最早邀请码里那把） */
export async function 当前编号(teamId: string): Promise<number> {
  const k = await control.syncKey.findFirst({ where: { teamId }, orderBy: { epoch: "desc" }, select: { epoch: true } });
  return k?.epoch ?? 0;
}

export async function 建团队(accountId: string, name: string, 设备?: 设备): Promise<结果<{ teamId: string; joinSecret: string }>> {
  const 名 = String(name ?? "").trim().slice(0, 40);
  if (!名) return 错(400, "给团队起个名字");
  if (设备 && (!设备号对(设备.device) || !公钥对(设备.pubKey))) return 错(400, "设备信息不对");
  // 一个人建的团队不多于 5 个：挡住脚本刷表，正常人用不完
  if ((await control.syncTeam.count({ where: { ownerAccountId: accountId } })) >= 5) return 错(429, "你已经建了 5 个团队了");
  const joinSecret = randomBytes(16).toString("base64url");
  const t = await control.syncTeam.create({ data: { name: 名, ownerAccountId: accountId, joinSecretHash: 指纹(joinSecret) } });
  await control.syncMember.create({ data: { teamId: t.id, accountId, role: "owner" } });
  await 登记设备(t.id, accountId, 设备);
  return { ok: true, teamId: t.id, joinSecret };
}

export async function 入队(accountId: string, teamId: string, joinSecret: string, 设备?: 设备): Promise<结果<{ teamName: string; active: boolean; epoch: number }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  const 对 = t && typeof joinSecret === "string" && 等长相等(指纹(joinSecret), t.joinSecretHash);
  // 团队不存在和口令不对说同一句：不让人拿这个接口试出哪些团队编号是真的。邀请码换过了，旧的也走这一句
  if (!t || !对) return 错(403, "邀请码不对或已经作废了，找建团队的人要一个新的");
  const 已 = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId } } });
  if (!(已 && !已.leftAt) && (await control.syncMember.count({ where: { teamId: t.id, leftAt: null } })) >= 20) return 错(409, "这个团队已经有 20 个人了");
  const 设备错 = await 登记设备(t.id, accountId, 设备);
  if (设备错) return 错(409, 设备错);
  if (已 && 已.leftAt) await control.syncMember.update({ where: { teamId_accountId: { teamId: t.id, accountId } }, data: { leftAt: null, joinedAt: new Date() } });
  else if (!已) await control.syncMember.create({ data: { teamId: t.id, accountId } });
  return { ok: true, teamName: t.name, active: t.active, epoch: await 当前编号(t.id) };
}

/** 只有建团队的人能做的那几件（移除成员、换邀请码、换钥匙） */
async function 是建的人(teamId: string, accountId: string) {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  return t && t.ownerAccountId === accountId ? t : null;
}

async function 新口令(teamId: string) {
  const joinSecret = randomBytes(16).toString("base64url");
  await control.syncTeam.update({ where: { id: teamId }, data: { joinSecretHash: 指纹(joinSecret) } });
  return joinSecret;
}

/**
 * 移除成员：标记离队、删掉他的设备（换钥匙时不再给他封）、换入队口令（旧邀请码作废，他拿着也回不来）。
 * 接着由建团队的人那台换钥匙（桌面端自动做）——之后的改动他解不开。他电脑上已经有的数据收不回，界面上要说清。
 */
export async function 移除成员(accountId: string, teamId: string, 谁: string): Promise<结果<{ joinSecret: string }>> {
  const t = await 是建的人(teamId, accountId);
  if (!t) return 错(403, "只有建团队的人能移除成员");
  if (谁 === accountId) return 错(400, "不能移除自己；要离开请点「退出团队」");
  const m = await 在队里(t.id, String(谁 ?? ""));
  if (!m) return 错(404, "这个人已经不在团队里了");
  await control.syncMember.update({ where: { teamId_accountId: { teamId: t.id, accountId: m.accountId } }, data: { leftAt: new Date() } });
  await control.syncDevice.deleteMany({ where: { teamId: t.id, accountId: m.accountId } });
  return { ok: true, joinSecret: await 新口令(t.id) };
}

/** 换邀请码：旧码作废（已经在团队里的人不受影响）。桌面端接着换钥匙——码里带着钥匙，码漏了钥匙也就漏了 */
export async function 换口令(accountId: string, teamId: string): Promise<结果<{ joinSecret: string }>> {
  const t = await 是建的人(teamId, accountId);
  if (!t) return 错(403, "只有建团队的人能换邀请码");
  return { ok: true, joinSecret: await 新口令(t.id) };
}

/** 换钥匙要封给哪几台：在册成员登记过的设备 */
export async function 团队设备(accountId: string, teamId: string): Promise<结果<{ epoch: number; devices: { device: string; accountId: string; pubKey: string }[] }>> {
  const t = await 是建的人(teamId, accountId);
  if (!t) return 错(403, "只有建团队的人能换钥匙");
  const 在册 = (await control.syncMember.findMany({ where: { teamId: t.id, leftAt: null }, select: { accountId: true } })).map((m) => m.accountId);
  const devices = await control.syncDevice.findMany({ where: { teamId: t.id, accountId: { in: 在册 } }, select: { device: true, accountId: true, pubKey: true } });
  return { ok: true, epoch: await 当前编号(t.id), devices };
}

/**
 * 换钥匙：收下新一把的钥匙环（旧钥匙们用新钥匙封好）和给每台设备各封的一份。我们一个都解不开。
 * 编号只能是「当前 + 1」：两次换钥匙撞在一起时后到的那次不收，免得两把「新钥匙」各自为政。
 * 只收在册设备的信封：被移除的那台不会有。
 */
export async function 换钥匙(accountId: string, teamId: string, epoch: number, ring: string, envelopes: { device: string; data: string }[]): Promise<结果<{ epoch: number }>> {
  const t = await 是建的人(teamId, accountId);
  if (!t) return 错(403, "只有建团队的人能换钥匙");
  const 现在 = await 当前编号(t.id);
  if (epoch !== 现在 + 1) return 错(409, "钥匙刚被换过了，刷新一下再试");
  if (typeof ring !== "string" || !ring || ring.length > 64 * 1024) return 错(400, "钥匙环不对");
  if (!Array.isArray(envelopes) || envelopes.length > 200) return 错(400, "信封不对");
  const 在册 = (await control.syncMember.findMany({ where: { teamId: t.id, leftAt: null }, select: { accountId: true } })).map((m) => m.accountId);
  const 可封 = new Set((await control.syncDevice.findMany({ where: { teamId: t.id, accountId: { in: 在册 } }, select: { device: true } })).map((d) => d.device));
  const 收 = envelopes.filter((e) => e && 可封.has(String(e.device)) && typeof e.data === "string" && e.data.length < 4096);
  await control.syncKey.create({ data: { teamId: t.id, epoch, ring } });
  if (收.length) await control.syncKeyEnvelope.createMany({ data: 收.map((e) => ({ teamId: t.id, epoch, device: String(e.device), data: e.data })) });
  return { ok: true, epoch };
}

/** 取钥匙：现在是第几把、封给我这台的那一份（没有就是 null）、钥匙环（编号 0 时没有） */
export async function 取钥匙(accountId: string, teamId: string, device: string): Promise<结果<{ epoch: number; envelope: string | null; ring: string | null }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t || !(await 在队里(t.id, accountId))) return 错(403, "你不在这个团队里了");
  const epoch = await 当前编号(t.id);
  if (!epoch) return { ok: true, epoch, envelope: null, ring: null };
  const 我的 = await control.syncDevice.findUnique({ where: { teamId_device: { teamId: t.id, device: String(device ?? "") } } });
  const 信 = 我的 && 我的.accountId === accountId ? await control.syncKeyEnvelope.findUnique({ where: { teamId_epoch_device: { teamId: t.id, epoch, device: 我的.device } } }) : null;
  const 环 = await control.syncKey.findUnique({ where: { teamId_epoch: { teamId: t.id, epoch } } });
  return { ok: true, epoch, envelope: 信?.data ?? null, ring: 环?.ring ?? null };
}

function 等长相等(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function 退队(accountId: string, teamId: string): Promise<结果<object>> {
  const m = await 在队里(String(teamId ?? ""), accountId);
  if (!m) return { ok: true };
  /*
    老板（建团队的人）不能撇下同事自己走：走了以后没人能移除成员、换钥匙，他却还是「建的人」（换钥匙复查低 7）。
    先移除其他人，最后一个走的就是他
  */
  const t = await control.syncTeam.findUnique({ where: { id: m.teamId }, select: { ownerAccountId: true } });
  if (t?.ownerAccountId === accountId && (await control.syncMember.count({ where: { teamId: m.teamId, leftAt: null, accountId: { not: accountId } } })) > 0) {
    return 错(409, "你是老板（建团队的人）：团队里还有同事，先在下面把他们移除，再退出");
  }
  await control.syncMember.update({ where: { teamId_accountId: { teamId: m.teamId, accountId } }, data: { leftAt: new Date() } });
  // 走了的人的设备不再收新钥匙
  await control.syncDevice.deleteMany({ where: { teamId: m.teamId, accountId } });
  return { ok: true };
}

/** 我在的团队，带成员（名字、联系方式、谁是建的人）和开通了没有 */
export async function 我的团队(accountId: string) {
  const ms = await control.syncMember.findMany({ where: { accountId, leftAt: null } });
  const 团队们 = await control.syncTeam.findMany({ where: { id: { in: ms.map((m) => m.teamId) } } });
  const 成员们 = await control.syncMember.findMany({ where: { teamId: { in: 团队们.map((t) => t.id) }, leftAt: null }, orderBy: { joinedAt: "asc" } });
  const 账号们 = await control.account.findMany({ where: { id: { in: [...new Set(成员们.map((m) => m.accountId))] } }, select: { id: true, name: true, email: true, phone: true } });
  const 账 = new Map(账号们.map((a) => [a.id, a]));
  return 团队们.map((t) => ({
    id: t.id,
    name: t.name,
    active: t.active,
    我是建的人: t.ownerAccountId === accountId,
    ownerAccountId: t.ownerAccountId,
    成员: 成员们.filter((m) => m.teamId === t.id).map((m) => ({ accountId: m.accountId, role: m.role, name: 账.get(m.accountId)?.name ?? "（已注销）", contact: 账.get(m.accountId)?.email ?? 账.get(m.accountId)?.phone ?? "", joinedAt: m.joinedAt.toISOString() })),
  }));
}

export async function 收推送(accountId: string, teamId: string, device: string, data: string): Promise<结果<{ seq: number }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t || !(await 在队里(t.id, accountId))) return 错(403, "你不在这个团队里");
  if (!t.active) return 错(402, "团队同步还没开通");
  if (typeof data !== "string" || !data || data.length > 一批上限) return 错(413, "这一批太大了");
  if (typeof device !== "string" || !/^[\w-]{4,64}$/.test(device)) return 错(400, "设备编号不对");
  const 目录 = 安全名(t.id) && path.join(同步目录(), t.id);
  if (!目录) return 错(400, "团队编号不对");
  // 设备编号认账号：同一个设备编号已经是别人登记 / 推过的，就不收——不然冒用的那台推的，被冒用的那台会当成自己推的、一声不响地跳过（复查）
  const 登记 = await control.syncDevice.findUnique({ where: { teamId_device: { teamId: t.id, device } } });
  if ((登记 && 登记.accountId !== accountId) || (await control.syncBatch.findFirst({ where: { teamId: t.id, device, accountId: { not: accountId } }, select: { id: true } }))) {
    return 错(409, "这个设备编号已经被团队里别人用了：退出团队再重新加入，会换一个新的");
  }
  // 用旧钥匙封的不收：团队换过钥匙（移除了人）之后，旧钥匙在被移除的人手上
  let 编号: number;
  try {
    编号 = 包的编号(data);
  } catch {
    return 错(400, "这一批的格式不对");
  }
  const 现在 = await 当前编号(t.id);
  if (编号 < 现在) return 错(409, "团队换过钥匙了，取到新钥匙再推");
  fs.mkdirSync(目录, { recursive: true });
  const b = await control.syncBatch.create({ data: { teamId: t.id, accountId, device, size: data.length } });
  // 先写临时文件再改名：拉的人不会读到写了一半的批次
  const f = path.join(目录, `${b.id}.bin`);
  fs.writeFileSync(`${f}.tmp`, data);
  fs.renameSync(`${f}.tmp`, f);
  return { ok: true, seq: b.id };
}

export async function 给拉取(accountId: string, teamId: string, after: number): Promise<结果<{ batches: { seq: number; device: string; data: string }[]; more: boolean; epoch: number }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  if (!t || !(await 在队里(t.id, accountId))) return 错(403, "你不在这个团队里");
  if (!t.active) return 错(402, "团队同步还没开通");
  const rows = await control.syncBatch.findMany({ where: { teamId: t.id, id: { gt: Math.max(0, Math.floor(Number(after) || 0)) } }, orderBy: { id: "asc" }, take: 一次拉 + 1 });
  const 这批 = rows.slice(0, 一次拉);
  const batches = [];
  for (const r of 这批) {
    try {
      batches.push({ seq: r.id, device: r.device, data: fs.readFileSync(path.join(同步目录(), t.id, `${r.id}.bin`), "utf8") });
    } catch {
      /*
        刚建的批次：记录先有、文件后写（收推送里那两步之间），这时拉到就停在它前面、下一轮再来——
        原来一律跳过，同一次又给了更后面的，拉的人位置越过了它，这一批就永远丢了（复查）。
        建了一分钟还没文件的才是真没了（盘坏了、手动清过）：跳过、继续往后，别让整个团队卡死在这一个序号上
      */
      if (Date.now() - r.createdAt.getTime() < 60_000) return { ok: true, batches, more: false, epoch: await 当前编号(t.id) };
    }
  }
  // 带上现在是第几把钥匙：比本机新，桌面端先去取新钥匙再解这几批
  return { ok: true, batches, more: rows.length > 一次拉, epoch: await 当前编号(t.id) };
}

/** 运营台：开通 / 停用 */
export async function 设开通(teamId: string, on: boolean) {
  await control.syncTeam.update({ where: { id: teamId }, data: { active: on, ...(on ? { activatedAt: new Date() } : {}) } });
}

/** 运营台：所有团队，带人数、批次数、占用 */
export async function 全部团队() {
  const 团队们 = await control.syncTeam.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  const 人 = await control.syncMember.groupBy({ by: ["teamId"], where: { leftAt: null }, _count: { _all: true } });
  const 批 = await control.syncBatch.groupBy({ by: ["teamId"], _count: { _all: true }, _sum: { size: true } });
  const 建的人 = await control.account.findMany({ where: { id: { in: 团队们.map((t) => t.ownerAccountId) } }, select: { id: true, name: true, email: true, phone: true } });
  return 团队们.map((t) => ({
    ...t,
    人数: 人.find((x) => x.teamId === t.id)?._count._all ?? 0,
    批次: 批.find((x) => x.teamId === t.id)?._count._all ?? 0,
    字节: 批.find((x) => x.teamId === t.id)?._sum.size ?? 0,
    建的人: 建的人.find((a) => a.id === t.ownerAccountId) ?? null,
  }));
}
