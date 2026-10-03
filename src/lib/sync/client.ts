/**
 * 团队同步的桌面端这一头（2026-10-03，0.46.15 第 5 块）：建团队、凭邀请码加入、同步一轮（先推后拉）、退出。
 *
 * 团队的东西记在 `$CRM_DATA_DIR/.team.json`（0600，和 .cloud.json 一个做法）：团队编号、入队口令、**钥匙**、本机设备编号。
 * 钥匙只在这里和邀请码里，我们的服务器见不到。丢了钥匙：云上密文作废，但每个人电脑上都有全量，任何一个人重建团队即可。
 *
 * 只在桌面端本地模式、登录了云端账号时能用。和云端说话用那枚设备令牌（.cloud.json 里的 dk_…）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma";
import { 本地模式, 读 as 读云端凭据, 云端地址 } from "../desktop/cloud";
import { 团队身份id } from "../desktop/me";
import { 改身份, 建同步表, 装触发器, 卸触发器, 记全量, 待推, 记已推, 回放, 装了吗 } from "./local";
import { 封, 拆, 新钥匙 } from "./crypto";

export type 团队配置 = {
  teamId: string;
  teamName: string;
  joinSecret: string;
  key: string;
  device: string;
  /** 拉到第几批了 */
  pulled: number;
  lastSyncAt?: string;
  lastError?: string | null;
  /** 上一轮做了什么，给界面那一行说话 */
  last?: { 推: number; 拉: number; 撞: number };
};

type 结果<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function 配置文件(): string {
  const dir = process.env.CRM_DATA_DIR;
  if (!dir) throw new Error("没有 CRM_DATA_DIR");
  return path.join(dir, ".team.json");
}
export function 读团队(): 团队配置 | null {
  try {
    const c = JSON.parse(fs.readFileSync(配置文件(), "utf8")) as 团队配置;
    return c.teamId && c.key && c.device ? c : null;
  } catch {
    return null;
  }
}
function 写团队(c: 团队配置) {
  fs.writeFileSync(配置文件(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

/* ---------------- 和云端说话：默认走 HTTP，测试里换成直接调中转 ---------------- */
export type 传输 = (方法: "GET" | "POST", 路径: string, body?: unknown) => Promise<{ 状态: number; json: Record<string, unknown> }>;
const HTTP: 传输 = async (方法, 路径, body) => {
  const c = 读云端凭据();
  if (!c) return { 状态: 401, json: { error: "还没登录云端账号" } };
  try {
    const r = await fetch(`${云端地址()}${路径}`, {
      method: 方法,
      headers: { Authorization: `Bearer ${c.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    return { 状态: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { 状态: 0, json: { error: "连不上云端，检查一下网络" } };
  }
};
let 云: 传输 = HTTP;
/** 测试用：换掉和云端说话的方式 */
export function 设传输(t: 传输 | null) {
  云 = t ?? HTTP;
}

/* ---------------- 邀请码：团队编号 + 入队口令 + 钥匙 ---------------- */
export const 邀请码 = (c: Pick<团队配置, "teamId" | "joinSecret" | "key">) => `DT1.${c.teamId}.${c.joinSecret}.${c.key}`;
export function 解邀请码(s: string): { teamId: string; joinSecret: string; key: string } | null {
  const m = /^DT1\.([a-z0-9]+)\.([\w-]+)\.([\w-]{43})$/i.exec(String(s ?? "").trim());
  return m ? { teamId: m[1], joinSecret: m[2], key: m[3] } : null;
}

function 能用(): 结果<{ accountId: string; contact: string; name: string }> {
  if (!本地模式()) return { ok: false, error: "团队同步只在桌面端用" };
  const c = 读云端凭据();
  if (!c?.accountId) return { ok: false, error: "先登录云端账号" };
  return { ok: true, accountId: c.accountId, contact: c.contact, name: c.name };
}

/**
 * 本机开同步：改身份（必须在装触发器之前）→ 建表 → 装触发器 → 本机已有的整份记成新建。
 * 已经装过（重新加入另一个团队）：只换团队，不再改身份、不再记全量——日志里已经有了
 */
async function 本机开同步(我: { accountId: string; contact: string; name: string }, 加入别人的: boolean) {
  if (await 装了吗(prisma)) return;
  await 改身份(prisma, 团队身份id(我.accountId), { email: 我.contact, name: 我.name || 我.contact.split("@")[0] });
  await 建同步表(prisma);
  await 装触发器(prisma);
  // 加入别人团队的不推业务配置：团队的模版、币种以建团队的人为准（见 记全量）
  await 记全量(prisma, { 不含设置: 加入别人的 });
}

export async function 建团队(名字: string): Promise<结果<{ 邀请码: string }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: false, error: "这台电脑已经在一个团队里了，先退出" };
  const r = await 云("POST", "/api/sync/team", { name: 名字 });
  if (r.状态 !== 200 || !r.json.teamId) return { ok: false, error: String(r.json.error ?? "建不了团队") };
  await 本机开同步(我, false);
  const c: 团队配置 = { teamId: String(r.json.teamId), teamName: 名字.trim(), joinSecret: String(r.json.joinSecret), key: 新钥匙(), device: `d${randomBytes(6).toString("hex")}`, pulled: 0, lastError: null };
  写团队(c);
  return { ok: true, 邀请码: 邀请码(c) };
}

export async function 加入团队(码: string): Promise<结果<{ teamName: string; active: boolean }>> {
  const 我 = 能用();
  if (!我.ok) return 我;
  if (读团队()) return { ok: false, error: "这台电脑已经在一个团队里了，先退出" };
  const 解 = 解邀请码(码);
  if (!解) return { ok: false, error: "邀请码不对：要整段复制，从 DT1. 开头" };
  const r = await 云("POST", "/api/sync/join", { teamId: 解.teamId, joinSecret: 解.joinSecret });
  if (r.状态 !== 200) return { ok: false, error: String(r.json.error ?? "加入不了") };
  await 本机开同步(我, true);
  写团队({ ...解, teamName: String(r.json.teamName ?? ""), device: `d${randomBytes(6).toString("hex")}`, pulled: 0, lastError: null });
  return { ok: true, teamName: String(r.json.teamName ?? ""), active: !!r.json.active };
}

/** 退出团队：本机数据全留着，只是不再推拉；触发器卸掉（日志表留着，以后再进团队不用重记全量） */
export async function 退出团队(): Promise<结果> {
  // 正在跑的那一轮先跑完：不然它跑到最后把 .team.json 写回来，界面上还「在团队里」、触发器却已经卸了（复查）
  if (在跑) await 在跑.catch(() => undefined);
  const c = 读团队();
  if (!c) return { ok: true };
  await 云("POST", "/api/sync/leave", { teamId: c.teamId });
  await 卸触发器(prisma);
  fs.rmSync(配置文件(), { force: true });
  触发器对过 = false;
  return { ok: true };
}

let 在跑: Promise<结果<{ 推: number; 拉: number; 撞: number }>> | null = null;
let 触发器对过 = false;

/**
 * 同步一轮：先推后拉（推的时候本机字段钟编好，拉回来的更早的改动就盖不掉本机刚改的）。
 * 同一时间只跑一轮：壳 30 秒一戳、人点「立即同步」，撞上了就等前一轮的结果。
 */
export function 同步一轮(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  if (!在跑) 在跑 = 跑一轮().finally(() => { 在跑 = null; });
  return 在跑;
}

async function 跑一轮(): Promise<结果<{ 推: number; 拉: number; 撞: number }>> {
  const c = 读团队();
  if (!c) return { ok: false, error: "没有加入团队" };
  // 写之前重读：这一轮跑着的时候人退出了（文件没了）或换了团队，就别把旧配置写回去
  const 记 = (x: Partial<团队配置>) => {
    const 现 = 读团队();
    if (现?.teamId === c.teamId) 写团队({ ...现, ...x });
  };
  try {
    // 每个进程第一轮重装一次触发器：迁移加了列之后老触发器里的列名不全（探针结论）
    if (!触发器对过) {
      await 建同步表(prisma);
      await 装触发器(prisma);
      触发器对过 = true;
    }
    let 推 = 0;
    for (;;) {
      const { 改动, 到 } = await 待推(prisma, c.device);
      if (!改动.length) break;
      const r = await 云("POST", "/api/sync/push", { teamId: c.teamId, device: c.device, data: 封(改动, c.key) });
      if (r.状态 !== 200) {
        const 话 = String(r.json.error ?? `推送失败（${r.状态}）`);
        记({ lastError: 话, lastSyncAt: new Date().toISOString() });
        return { ok: false, error: 话 };
      }
      await 记已推(prisma, 到);
      推 += 改动.length;
    }
    let 拉 = 0, 撞 = 0, 拉到 = c.pulled;
    for (;;) {
      const r = await 云("GET", `/api/sync/pull?teamId=${encodeURIComponent(c.teamId)}&after=${拉到}`);
      if (r.状态 !== 200) {
        const 话 = String(r.json.error ?? `拉取失败（${r.状态}）`);
        记({ pulled: 拉到, lastError: 话, lastSyncAt: new Date().toISOString() });
        return { ok: false, error: 话 };
      }
      const 批们 = (r.json.batches as { seq: number; device: string; data: string }[]) ?? [];
      for (const b of 批们) {
        if (b.device !== c.device) {
          const 结果 = await 回放(prisma, 拆(b.data, c.key), c.device);
          拉 += 结果.应用;
          撞 += 结果.撞;
        }
        拉到 = b.seq;
        记({ pulled: 拉到 }); // 每批记一次：中途断了下一轮从这里接着拉，不重复回放
      }
      if (!r.json.more) break;
    }
    记({ pulled: 拉到, lastError: null, lastSyncAt: new Date().toISOString(), last: { 推, 拉, 撞 } });
    return { ok: true, 推, 拉, 撞 };
  } catch (e) {
    const 话 = e instanceof Error && /authenticate|版本|钥匙/.test(e.message) ? "解不开别人推来的改动：邀请码里的钥匙不对，请找建团队的人重新要一份" : `同步出错：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    记({ lastError: 话, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: 话 };
  }
}

/** 设置 → 团队要的：本机的团队、上次同步、出错原因，以及云端那边的成员和开通状态 */
export async function 团队状态() {
  const c = 读团队();
  if (!c) return { 在团队: false as const, 能用: 能用().ok };
  const r = await 云("GET", "/api/sync/team");
  const 团 = ((r.json.teams as { id: string; name: string; active: boolean; 我是建的人: boolean; 成员: { accountId: string; name: string; contact: string; role: string }[] }[]) ?? []).find((t) => t.id === c.teamId);
  return {
    在团队: true as const,
    teamName: 团?.name ?? c.teamName,
    active: 团?.active ?? null,
    我是建的人: 团?.我是建的人 ?? false,
    成员: 团?.成员 ?? [],
    邀请码: 邀请码(c),
    lastSyncAt: c.lastSyncAt ?? null,
    lastError: c.lastError ?? (r.状态 === 200 ? null : String(r.json.error ?? "")),
    last: c.last ?? null,
  };
}
