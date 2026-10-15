/**
 * 我的名字：本机「我」那一行 User.name 和云端账号名对上（2026-10-15，0.46.17 实测修）。
 *
 * 原来云端账号名注册时填了就改不了，桌面端设置里改的只是本机那一行：
 *   - 建团队 / 加入 / 电脑之间连接时 改身份 拿云端名字把本机改过的名字盖回注册名（已在 改身份 里修：本机改过的留着）；
 *   - 手机「我的」、电脑 / 手机授权框、运营台一直显示注册名。
 * 现在云端有了改名接口（/api/account/name），桌面端改名时一并改云端；这里管「两边不一样时听谁的」。
 *
 * **以人最后一次改的为准**，判断靠记账（和登录、启动时对名字是同一本账，见 synced-name.ts）：
 *   上次 = desktop.syncedName，上一次两边对上时的名字。
 *   本机 ≠ 上次（而且不是模板默认名）→ 是人在这台电脑上改的，云端还没跟上（当时断网）→ 推给云端。
 *   本机 = 上次 或者还是模板默认名  → 本机没人动过，云端变了就是别处改的（另一台电脑）→ 本机跟云端。
 * 两边都改过（两台电脑都断着网各改一次）算本机赢：这种情况在团队里会先被 User 行的同步（按改动时间）摆平，
 * 同步过来的名字再推给云端；不在团队里的两台本来就各是各的库。
 *
 * 云端调用走传进来的 传输（lib/sync/client.ts 的 调云）：不在这里 import client，免得和 改身份 那边绕成环。
 */
import { prisma } from "@/lib/prisma";
import { invalidateSettingsCache } from "@/lib/settings";
import { 读 as 读云端凭据, 记名字 as 记云端凭据名字 } from "./cloud";
import { 本机我 } from "./me";
import { 同步名字键, 是模板名字 } from "./synced-name";

type 传输 = (方法: "GET" | "POST", 路径: string, body?: unknown) => Promise<{ 状态: number; json: Record<string, unknown> }>;

async function 读上次(): Promise<string | null> {
  const r = await prisma.setting.findUnique({ where: { key: 同步名字键 } }).catch(() => null);
  if (!r) return null;
  try {
    const v = JSON.parse(r.value) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** 两边对上了：记账（上次 = 这个名字）、.cloud.json 里的名字也换成它（建团队时 改身份 拿的就是它） */
async function 记对上(名字: string) {
  const value = JSON.stringify(名字);
  await prisma.setting.upsert({ where: { key: 同步名字键 }, create: { key: 同步名字键, value }, update: { value } });
  invalidateSettingsCache();
  记云端凭据名字(名字);
}

/** 把名字推给云端。成功就记账；推不上（断网、云端还没这个接口）不报错，下次 对齐我的名字 再推 */
export async function 云端跟着改名(云: 传输, 名字: string): Promise<boolean> {
  if (!读云端凭据()?.token) return false;
  const r = await 云("POST", "/api/account/name", { name: 名字 }).catch(() => null);
  if (!r || r.状态 !== 200 || typeof r.json.name !== "string") return false;
  await 记对上(String(r.json.name));
  return true;
}

export type 对齐结果 = "一样" | "推了" | "跟了云端" | "没对上";

/**
 * 两边对一次（建团队 / 加入 / 电脑连接之前，登录之后）。连不上云端就什么都不动，返回「没对上」。
 * 跟云端改本机那一行时：开了同步的库里触发器会把它记成我的改动、同步给团队——就该这样，那是我自己的行。
 */
export async function 对齐我的名字(云: 传输): Promise<对齐结果> {
  const c = 读云端凭据();
  if (!c?.token) return "没对上";
  const 我 = await 本机我(prisma);
  const 行 = 我 ? await prisma.user.findUnique({ where: { id: 我.id }, select: { id: true, name: true } }) : null;
  if (!行) return "没对上";
  const r = await 云("GET", "/api/account/name").catch(() => null);
  if (!r || r.状态 !== 200 || typeof r.json.name !== "string") return "没对上";
  const 云端 = r.json.name;
  const 本机 = 行.name.trim();
  if (本机 === 云端) {
    await 记对上(云端);
    return "一样";
  }
  const 上次 = await 读上次();
  const 人改过 = !是模板名字(本机) && 本机 !== 上次;
  if (人改过) return (await 云端跟着改名(云, 本机)) ? "推了" : "没对上";
  if (!云端.trim()) return "没对上";
  await prisma.user.update({ where: { id: 行.id }, data: { name: 云端 } });
  await 记对上(云端);
  return "跟了云端";
}
