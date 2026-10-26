/**
 * 企业版 · 飞书连接（2026-10-26）：设置页「飞书连接」那张卡片背后的事。
 *
 * - 测试连接：拿令牌 → 读一个部门（通讯录权限）→ 列多维表格里的数据表（多维表格权限 + 应用有没有被加进去），
 *   每一步单独说过没过；没过的照飞书的错误码说是哪一种：ID / Secret 不对、没开权限或开了没发版、应用没被加进多维表格、链接不对。
 * - 对表：table_id 不让人手填。贴多维表格链接 → 接口列出所有数据表 → 按表名自动对上 8 张主表，对不上的给下拉选。
 *   存进 Setting `entConn.feishu` 的 表们（导入 / 增量同步读的就是它）；现在还没接的 3 张（联系方式、卡点、项目组员）
 *   先存在 备用表 里，等那几类接上直接用。
 *
 * 只读飞书、不往飞书写。凭据从库里（密文）或环境变量来，和通讯录同步、导入同一份。
 */
import { prisma } from "@/lib/prisma";
import { getSetting, invalidateSettingsCache } from "@/lib/settings";
import { recordAudit, type Actor } from "@/lib/audit";
import { 连接键, 当前联网, 读连接配置 } from "@/lib/enterprise-import/adapter";
import { 飞书适配器, type 飞书表 } from "@/lib/enterprise-import/feishu";
import { 接口出错 } from "@/lib/enterprise-import/net";
import type { 实体 } from "@/lib/enterprise-import/types";

/* ───────────────────────── 8 张主表 ───────────────────────── */

export type 主表槽 = 实体 | "contactMethod" | "blocker" | "projectMember";

/** 槽 → 显示名、对方表名（按这个自动对）、现在导入用不用得上 */
export const 主表们: { 槽: 主表槽; 名: string; 表名: string; 已接: boolean }[] = [
  { 槽: "customer", 名: "客户", 表名: "客户数据库", 已接: true },
  { 槽: "contact", 名: "联系人", 表名: "联系人数据库", 已接: true },
  { 槽: "opportunity", 名: "项目（商机）", 表名: "项目全周期数据库", 已接: true },
  { 槽: "followup", 名: "沟通记录（跟进）", 表名: "沟通记录数据库", 已接: true },
  { 槽: "lead", 名: "线索", 表名: "线索分配后台", 已接: true },
  { 槽: "contactMethod", 名: "联系方式", 表名: "联系方式数据库", 已接: false },
  { 槽: "blocker", 名: "卡点", 表名: "卡点数据库", 已接: false },
  { 槽: "projectMember", 名: "项目组员", 表名: "项目关联组员数据库", 已接: false },
];
const 是槽 = (k: string): k is 主表槽 => 主表们.some((t) => t.槽 === k);

/** 表名只比汉字、字母、数字（去掉 ✅⏸🔍 之类的前缀和空格） */
const 规整 = (s: string) => s.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "").toLowerCase();

export type 数据表 = { tableId: string; 名: string };

/**
 * 按名字自动对：先认一模一样的（规整后），再认去掉「数据库」后一样的 / 加「表」的（客户 / 客户表）。
 * 同一个名字对上两张以上 = 拿不准，留空给人选；「探针-」开头的测试副本不认；一张表只给一个槽。
 */
export function 对上主表(表们: 数据表[]): Record<主表槽, string | null> {
  const 可用 = 表们.filter((t) => !规整(t.名).startsWith("探针"));
  const 出 = Object.fromEntries(主表们.map((t) => [t.槽, null])) as Record<主表槽, string | null>;
  const 用掉 = new Set<string>();
  for (const 主 of 主表们) {
    const 本名 = 规整(主.表名);
    const 短 = 本名.replace(/数据库$/, "");
    for (const 认法 of [[本名], [短, `${短}表`]]) {
      const 中 = 可用.filter((t) => !用掉.has(t.tableId) && 认法.includes(规整(t.名)));
      if (中.length === 1) {
        出[主.槽] = 中[0].tableId;
        用掉.add(中[0].tableId);
      }
      if (中.length) break;
    }
  }
  return 出;
}

/* ───────────────────────── 多维表格链接 ───────────────────────── */

/**
 * 多维表格链接 → app_token。认 https://xxx.feishu.cn/base/<token>?table=… 和直接贴的 token。
 * 知识库（/wiki/）里的多维表格 token 不是这个，要人另开成独立的多维表格再复制链接。
 */
export function 取appToken(链接: string): { ok: true; appToken: string } | { ok: false; 话: string } {
  const s = 链接.trim();
  if (!s) return { ok: false, 话: "没填多维表格链接" };
  const m = s.match(/\/base\/([A-Za-z0-9]+)/);
  if (m) return { ok: true, appToken: m[1] };
  if (/\/wiki\//.test(s)) return { ok: false, 话: "这是知识库里的链接：请在多维表格右上角「…」→「在新标签页打开」，复制地址栏里带 /base/ 的链接" };
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return { ok: true, appToken: s };
  return { ok: false, 话: "认不出这个链接：要打开多维表格，复制地址栏里带 /base/ 的那一串" };
}

/* ───────────────────────── 测试连接 ───────────────────────── */

export type 测试一步 = { 名: string; 通过: boolean; 话: string };
export type 测试结果 = {
  步们: 测试一步[];
  /** 多维表格那一步过了才有 */
  多维表格?: { appToken: string; 表们: 数据表[]; 对上: Record<主表槽, string | null> };
};

const 有值 = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

const 发版话 = "（权限要在开放平台「版本管理与发布」里发一个版本、企业管理员审核通过才生效）";
const 令牌原因: Record<number, string> = {
  10003: "App ID 或 App Secret 不对：到飞书开放平台 → 应用 →「凭证与基础信息」里重新复制",
  10014: "App Secret 不对：到飞书开放平台 → 应用 →「凭证与基础信息」里重新复制",
};
const 通讯录原因: Record<number, string> = {
  99991672: `没开通讯录读取权限，或开了还没发布版本${发版话}`,
  40004: "通讯录权限范围不够：开放平台 → 权限管理 →「通讯录权限范围」选全部成员，再发版",
  41050: "通讯录权限范围不够：开放平台 → 权限管理 →「通讯录权限范围」选全部成员，再发版",
};
const 没加进表 = "应用没被加进这张多维表格：在多维表格右上角「…」→「添加文档应用」，搜应用名加进来（给「可阅读」就够）";
const 多维表格原因: Record<number, string> = {
  99991672: `没开多维表格读取权限，或开了还没发布版本${发版话}`,
  91403: 没加进表,
  1254302: 没加进表,
  1254003: "链接不对，或这张多维表格已经删了：重新打开多维表格复制链接",
  1254040: "链接不对，或这张多维表格已经删了：重新打开多维表格复制链接",
  91402: "链接不对，或这张多维表格已经删了：重新打开多维表格复制链接",
};

/** 错误码有说法就说那句，没有就把飞书原话带上（连不上的那句本身就说清了） */
function 原因(e: unknown, 说法: Record<number, string>): string {
  if (e instanceof 接口出错) return (e.code !== undefined && 说法[e.code]) || e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * 测一次。填 = 页面上刚填、还没存的（App Secret 空着 = 用存着的），不填就全用存着的 / 环境变量。
 * 链接不填就不测多维表格那一步（只用通讯录也行）。
 */
export async function 测试飞书连接(p: { 填?: { appId?: string; appSecret?: string }; 链接?: string } = {}): Promise<测试结果> {
  const c = (await 读连接配置("feishu")) ?? {};
  const appId = [p.填?.appId, c.appId, process.env.ENT_FEISHU_APP_ID].find(有值)?.trim();
  const appSecret = [p.填?.appSecret, c.appSecret, process.env.ENT_FEISHU_APP_SECRET].find(有值)?.trim();
  const 步们: 测试一步[] = [];
  if (!appId || !appSecret) {
    步们.push({ 名: "App ID / Secret", 通过: false, 话: "还没填 App ID 和 App Secret" });
    return { 步们 };
  }
  const a = new 飞书适配器({ appId, appSecret, 表们: [], 基址: 有值(c.基址) ? c.基址 : undefined }, 当前联网());

  try {
    await a.试令牌();
    步们.push({ 名: "App ID / Secret", 通过: true, 话: "对的，拿到了访问令牌" });
  } catch (e) {
    步们.push({ 名: "App ID / Secret", 通过: false, 话: 原因(e, 令牌原因) });
    return { 步们 };
  }

  try {
    await a.试通讯录();
    步们.push({ 名: "通讯录", 通过: true, 话: "读得到部门" });
  } catch (e) {
    步们.push({ 名: "通讯录", 通过: false, 话: 原因(e, 通讯录原因) });
  }

  if (!有值(p.链接)) return { 步们 };
  const t = 取appToken(p.链接);
  if (!t.ok) {
    步们.push({ 名: "多维表格", 通过: false, 话: t.话 });
    return { 步们 };
  }
  try {
    const 表们 = await a.列多维表(t.appToken);
    if (!表们.length) {
      步们.push({ 名: "多维表格", 通过: false, 话: "打开了，但里面一张数据表都没有：链接是不是贴成了别的多维表格" });
      return { 步们 };
    }
    const 对上 = 对上主表(表们);
    const 对上几 = Object.values(对上).filter(Boolean).length;
    步们.push({ 名: "多维表格", 通过: true, 话: `读得到，有 ${表们.length} 张数据表，按名字对上了 ${对上几} / ${主表们.length} 张主表` });
    return { 步们, 多维表格: { appToken: t.appToken, 表们, 对上 } };
  } catch (e) {
    步们.push({ 名: "多维表格", 通过: false, 话: 原因(e, 多维表格原因) });
    return { 步们 };
  }
}

/* ───────────────────────── 存 / 读对表 ───────────────────────── */

type 备用表 = { appToken: string; tableId: string; 名: string };

export type 飞书表概况 = {
  appToken: string | null;
  选: Record<主表槽, 数据表 | null>;
};

export async function 读飞书表配置(): Promise<飞书表概况> {
  const c = (await getSetting<Record<string, unknown>>(连接键("feishu"))) ?? {};
  const 表们 = Array.isArray(c.表们) ? (c.表们 as 飞书表[]) : [];
  const 备用 = (c.备用表 && typeof c.备用表 === "object" ? c.备用表 : {}) as Partial<Record<主表槽, 备用表>>;
  const 选 = Object.fromEntries(主表们.map((t) => [t.槽, null])) as Record<主表槽, 数据表 | null>;
  for (const t of 表们) if (是槽(t.实体) && !选[t.实体]) 选[t.实体] = { tableId: t.tableId, 名: t.名 ?? t.tableId };
  for (const [k, v] of Object.entries(备用)) if (是槽(k) && v?.tableId) 选[k] = { tableId: v.tableId, 名: v.名 };
  const appToken = 有值(c.多维表格) ? c.多维表格 : (表们[0]?.appToken ?? null);
  return { appToken, 选 };
}

/**
 * 存对表：重新列一遍表（选的必须真在这个多维表格里，名字以飞书为准），一张表只能给一个槽。
 * 已接的 5 类写进 表们（同一类原来配过的 关联 / 视图 留着），没接的 3 类写进 备用表；凭据和别的键不动。
 */
export async function 存飞书表(p: { 链接: string; 选: Record<string, string | null | undefined> }, 用户: Actor): Promise<{ ok: true; 概况: 飞书表概况 } | { ok: false; error: string }> {
  const t = 取appToken(p.链接);
  if (!t.ok) return { ok: false, error: t.话 };
  const 选: [主表槽, string][] = Object.entries(p.选).filter((e): e is [主表槽, string] => 是槽(e[0]) && 有值(e[1]));
  if (!选.length) return { ok: false, error: "一张表都没选" };
  const 重了 = 选.map(([, id]) => id).filter((id, i, a) => a.indexOf(id) !== i);
  if (重了.length) return { ok: false, error: "同一张数据表选给了两类，请改一下" };

  const c = (await 读连接配置("feishu")) ?? {};
  const appId = [c.appId, process.env.ENT_FEISHU_APP_ID].find(有值);
  const appSecret = [c.appSecret, process.env.ENT_FEISHU_APP_SECRET].find(有值);
  if (!appId || !appSecret) return { ok: false, error: "先存好 App ID 和 App Secret" };
  let 有的: 数据表[];
  try {
    有的 = await new 飞书适配器({ appId, appSecret, 表们: [], 基址: 有值(c.基址) ? c.基址 : undefined }, 当前联网()).列多维表(t.appToken);
  } catch (e) {
    return { ok: false, error: 原因(e, 多维表格原因) };
  }
  const 名 = new Map(有的.map((x) => [x.tableId, x.名]));
  const 不在 = 选.filter(([, id]) => !名.has(id));
  if (不在.length) return { ok: false, error: `这个多维表格里没有选的表（${不在.map(([k]) => 主表们.find((x) => x.槽 === k)!.名).join("、")}），请重新测试连接再选` };

  const 原 = (await getSetting<Record<string, unknown>>(连接键("feishu"))) ?? {};
  const 原表们 = Array.isArray(原.表们) ? (原.表们 as 飞书表[]) : [];
  const 表们: 飞书表[] = [];
  const 备用: Partial<Record<主表槽, 备用表>> = {};
  for (const [槽, tableId] of 选) {
    const 主 = 主表们.find((x) => x.槽 === 槽)!;
    if (!主.已接) {
      备用[槽] = { appToken: t.appToken, tableId, 名: 名.get(tableId)! };
      continue;
    }
    const 旧 = 原表们.find((x) => x.实体 === 槽);
    表们.push({
      实体: 槽 as 实体,
      appToken: t.appToken,
      tableId,
      名: 名.get(tableId)!,
      ...(旧?.关联 ? { 关联: 旧.关联 } : {}),
      ...(旧?.viewId && 旧.tableId === tableId && 旧.appToken === t.appToken ? { viewId: 旧.viewId } : {}),
    });
  }
  const value = JSON.stringify({ ...原, 多维表格: t.appToken, 表们, 备用表: 备用 });
  await prisma.setting.upsert({ where: { key: 连接键("feishu") }, update: { value }, create: { key: 连接键("feishu"), value } });
  invalidateSettingsCache();
  await recordAudit({
    user: 用户,
    action: "update",
    entity: "EntConn",
    entityId: "feishu",
    summary: `改飞书多维表格对照：${选.map(([k, id]) => `${主表们.find((x) => x.槽 === k)!.名}→${名.get(id)}`).join("、")}`,
  });
  return { ok: true, 概况: await 读飞书表配置() };
}
