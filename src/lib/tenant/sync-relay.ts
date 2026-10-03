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

export async function 建团队(accountId: string, name: string): Promise<结果<{ teamId: string; joinSecret: string }>> {
  const 名 = String(name ?? "").trim().slice(0, 40);
  if (!名) return 错(400, "给团队起个名字");
  // 一个人建的团队不多于 5 个：挡住脚本刷表，正常人用不完
  if ((await control.syncTeam.count({ where: { ownerAccountId: accountId } })) >= 5) return 错(429, "你已经建了 5 个团队了");
  const joinSecret = randomBytes(16).toString("base64url");
  const t = await control.syncTeam.create({ data: { name: 名, ownerAccountId: accountId, joinSecretHash: 指纹(joinSecret) } });
  await control.syncMember.create({ data: { teamId: t.id, accountId, role: "owner" } });
  return { ok: true, teamId: t.id, joinSecret };
}

export async function 入队(accountId: string, teamId: string, joinSecret: string): Promise<结果<{ teamName: string; active: boolean }>> {
  const t = await control.syncTeam.findUnique({ where: { id: String(teamId ?? "") } });
  const 对 = t && typeof joinSecret === "string" && 等长相等(指纹(joinSecret), t.joinSecretHash);
  // 团队不存在和口令不对说同一句：不让人拿这个接口试出哪些团队编号是真的
  if (!t || !对) return 错(403, "邀请码不对，或者这个团队已经不在了");
  const 已 = await control.syncMember.findUnique({ where: { teamId_accountId: { teamId: t.id, accountId } } });
  if (已 && !已.leftAt) return { ok: true, teamName: t.name, active: t.active };
  if ((await control.syncMember.count({ where: { teamId: t.id, leftAt: null } })) >= 20) return 错(409, "这个团队已经有 20 个人了");
  if (已) await control.syncMember.update({ where: { teamId_accountId: { teamId: t.id, accountId } }, data: { leftAt: null, joinedAt: new Date() } });
  else await control.syncMember.create({ data: { teamId: t.id, accountId } });
  return { ok: true, teamName: t.name, active: t.active };
}

function 等长相等(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function 退队(accountId: string, teamId: string): Promise<结果<object>> {
  const m = await 在队里(String(teamId ?? ""), accountId);
  if (!m) return { ok: true };
  await control.syncMember.update({ where: { teamId_accountId: { teamId: m.teamId, accountId } }, data: { leftAt: new Date() } });
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
  // 设备编号认账号：同一个设备编号已经是别人推过的，就不收——不然冒用的那台推的，被冒用的那台会当成自己推的、一声不响地跳过（复查）
  if (await control.syncBatch.findFirst({ where: { teamId: t.id, device, accountId: { not: accountId } }, select: { id: true } })) {
    return 错(409, "这个设备编号已经被团队里别人用了：退出团队再重新加入，会换一个新的");
  }
  fs.mkdirSync(目录, { recursive: true });
  const b = await control.syncBatch.create({ data: { teamId: t.id, accountId, device, size: data.length } });
  // 先写临时文件再改名：拉的人不会读到写了一半的批次
  const f = path.join(目录, `${b.id}.bin`);
  fs.writeFileSync(`${f}.tmp`, data);
  fs.renameSync(`${f}.tmp`, f);
  return { ok: true, seq: b.id };
}

export async function 给拉取(accountId: string, teamId: string, after: number): Promise<结果<{ batches: { seq: number; device: string; data: string }[]; more: boolean }>> {
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
      if (Date.now() - r.createdAt.getTime() < 60_000) return { ok: true, batches, more: false };
    }
  }
  return { ok: true, batches, more: rows.length > 一次拉 };
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
