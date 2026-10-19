/**
 * 电脑这一侧的跨成员查重（2026-10-19，规则见 lib/sync/dedupe.ts）：
 *   - 报：每轮范围同步之后，把本机看得到的客户的号码 / 邮箱 / 微信号哈希报上去（只报变了的，指纹记在数据目录）
 *   - 问：录入时本机没查到，再问一下服务端是不是同事名下的；只拿回同事是谁 + 客户名
 * 都是锦上添花：断网、服务端旧、范围同步没开，一律当没撞，不挡录入（本机查重照旧）。
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../prisma";
import { 看全部 } from "../team-scope";
import { 封, 拆, 查重哈希 } from "./crypto";
import { 读团队, 范围请求, 全部钥匙, type 团队配置 } from "./client";
import { 客户查重值, 查重键, 查重原文, 查重标签绑定, 查重指纹, 查重单次上限, type 查重种类, type 查重条目, type 查重命中 } from "./dedupe";

type 指纹表 = { teamId: string; d: Record<string, string> };
const 指纹文件 = () => path.join(process.env.CRM_DATA_DIR ?? ".", "scoped-sync-dedupe.json");
function 读指纹(teamId: string): Record<string, string> {
  try {
    const x = JSON.parse(fs.readFileSync(指纹文件(), "utf8")) as 指纹表;
    return x.teamId === teamId && x.d && typeof x.d === "object" ? x.d : {};
  } catch {
    return {};
  }
}
function 写指纹(teamId: string, d: Record<string, string>) {
  const f = 指纹文件();
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ teamId, d } satisfies 指纹表));
  fs.renameSync(`${f}.tmp`, f);
}

/** 一位客户的几样哈希（用现在这把钥匙） */
const 哈希们 = (c: 团队配置, 值: { phone?: string | null; email?: string | null; wechat?: string | null }) =>
  客户查重值(值).map(({ 种, 键 }) => 查重哈希(c.key, 查重原文(c.teamId, 种, 键)));

/**
 * 把本机客户的查重索引报上去：只报指纹变了的（新客户、改了号码 / 名字、换了钥匙）。
 * 服务端没收的（这位不归我看了、服务端还没有这条记录）不记指纹，下一轮再报
 */
export async function 报查重(c: 团队配置): Promise<{ 报: number }> {
  const epoch = c.epoch ?? 0;
  const 旧 = 读指纹(c.teamId);
  const 客户们 = await 看全部(() => prisma.customer.findMany({ select: { id: true, name: true, phone: true, extra: { select: { email: true, wechat: true } } } }));
  const 要报: { e: 查重条目; 指纹: string }[] = [];
  for (const x of 客户们) {
    const hashes = 哈希们(c, { phone: x.phone, email: x.extra?.email, wechat: x.extra?.wechat });
    const 指纹 = 查重指纹(epoch, hashes, x.name);
    if (旧[x.id] === 指纹) continue;
    要报.push({ e: { k: x.id, epoch, hashes, label: 封(x.name, c.key, epoch, 查重标签绑定(c.teamId)) }, 指纹 });
  }
  const 新 = { ...旧 };
  let 报 = 0;
  for (let i = 0; i < 要报.length; i += 查重单次上限) {
    const 段 = 要报.slice(i, i + 查重单次上限);
    const r = await 范围请求(c, "dedupe-put", { device: c.device, entries: 段.map((x) => x.e) });
    if (r.状态 !== 200) break; // 旧服务端 404 / 换钥匙中途 400：下一轮再报
    const 没收 = new Set(Array.isArray(r.json.skipped) ? (r.json.skipped as string[]) : []);
    for (const x of 段) if (!没收.has(x.e.k)) { 新[x.e.k] = x.指纹; 报++; }
  }
  // 本机已经没有的客户（删了、不归我了）指纹也删掉，免得文件越长越大
  const 还在 = new Set(客户们.map((x) => x.id));
  for (const k of Object.keys(新)) if (!还在.has(k)) delete 新[k];
  if (报 || Object.keys(新).length !== Object.keys(旧).length) 写指纹(c.teamId, 新);
  return { 报 };
}

/** 问同事的结果：负责人叫什么、客户叫什么（客户名解不开就空着） */
export type 同事撞到 = { 同事: string; 客户名: string; k: string };

/**
 * 录入前问一下：这个号码 / 邮箱 / 微信号是不是同事名下的客户。本机已有这位（自己看得到）的不算；
 * 没开团队版、范围同步没开、断网、超时（3 秒）都当没撞
 */
export async function 问同事(种: 查重种类, 值: string, 除了?: string): Promise<同事撞到 | null> {
  const c = 读团队();
  if (!c || c.scoped?.stage !== "ready") return null;
  const 键 = 查重键(种, 值);
  if (!键) return null;
  try {
    const r = await Promise.race([
      范围请求(c, "dedupe-find", { hashes: [查重哈希(c.key, 查重原文(c.teamId, 种, 键))] }),
      new Promise<null>((ok) => setTimeout(() => ok(null), 3000)),
    ]);
    if (!r || r.状态 !== 200 || !Array.isArray(r.json.hits)) return null;
    for (const h of r.json.hits as 查重命中[]) {
      if (!h || typeof h.k !== "string" || h.k === 除了) continue;
      if (await 看全部(() => prisma.customer.findUnique({ where: { id: h.k }, select: { id: true } }))) continue;
      const 人 = h.owner ? await 看全部(() => prisma.user.findUnique({ where: { id: h.owner }, select: { name: true } })) : null;
      let 客户名 = "";
      try { 客户名 = String(拆<string>(h.label, 全部钥匙(c), 查重标签绑定(c.teamId)) ?? ""); } catch { /* 换钥匙前封的、坏的：只说同事 */ }
      return { 同事: 人?.name || "同事", 客户名, k: h.k };
    }
    return null;
  } catch {
    return null;
  }
}
