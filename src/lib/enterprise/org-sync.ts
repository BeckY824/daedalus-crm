/**
 * 企业版 · 飞书 / 钉钉通讯录 → 组织架构（2026-10-26）：部门、成员、直属上级、业务角色，单向，每小时一次。
 *
 * 一次同步 = 适配器把整本通讯录拉完（拉的过程中出错 = 一行不写）→ 在内存里排好要怎么改 → 一个事务写进去（连同这次的状态），
 * 中途出错整个回滚，下次再从头来。只读通讯录，不往飞书 / 钉钉写任何东西。
 *
 * 规矩：
 * - 部门：按上游的树建 / 改名 / 挪；超过 3 层的并到第 3 层那个祖先里，进报告。上游删了的部门：空了才删，还有人就留着、进报告。
 *   第一次同步时，同一级同名的现有部门直接认领，不重复建。
 * - 人：先按上次认过的对照，再按邮箱（不分大小写）认现有账号；都认不出就建一个账号（普通销售、不能登录，要在用户管理里设密码）。
 *   上游离职的只进报告，不在这里停用（停用走离职交接，客户要交给谁得有人定）。
 * - 直属上级：上游给了就用；会绕成环的不设，进报告。上游没给就不动这边的。
 * - 业务角色：角色对照（职务 → 业务角色）> 部门负责人 = 销售管理 > 销售。这边手动改过的（和上次同步给的不一样）不覆盖；
 *   总管理 / 管理员和老板（账号管理员）的角色从来不动——那两级只有老板能给。
 *
 * 凭据和导入同一份：Setting `entConn.<来源>`，没存就看环境变量（ENT_FEISHU_APP_ID / ENT_FEISHU_APP_SECRET，
 * ENT_DINGTALK_APP_KEY / ENT_DINGTALK_APP_SECRET）。状态和对照表存 Setting `entOrgSync.<来源>`。
 * 企业版开关关着时什么都不做。
 */
import { prisma } from "@/lib/prisma";
import { encryptSecret, getSetting, invalidateSettingsCache, maskSecret } from "@/lib/settings";
import { recordAudit, type Actor } from "@/lib/audit";
import { 企业版 } from "@/lib/enterprise/switch";
import { 忘掉企业版范围 } from "@/lib/enterprise/visibility";
import { 建组织, 上级设置问题, 推业务角色 } from "@/lib/enterprise/org-core";
import { 是业务角色, 部门最多层数, 角色名, type 业务角色 } from "@/lib/sync/dept-policy";
import { 连接键, 当前联网, 读连接配置 } from "@/lib/enterprise-import/adapter";
import { 飞书适配器 } from "@/lib/enterprise-import/feishu";
import { 钉钉适配器 } from "@/lib/enterprise-import/dingtalk";
import { 真联网 } from "@/lib/enterprise-import/net";
import type { 通讯录, 通讯录部门 } from "@/lib/enterprise-import/types";

export type 通讯录来源 = "feishu" | "dingtalk";
export const 通讯录来源们: 通讯录来源[] = ["feishu", "dingtalk"];
export const 通讯录来源名: Record<通讯录来源, string> = { feishu: "飞书", dingtalk: "钉钉" };
export type 通讯录结果类别 = "成功" | "没变化" | "没接" | "出错" | "跳过";

export type 通讯录设置 = {
  开: boolean;
  /** 开同步的人：定时同步写操作日志时记在他名下 */
  开的人Id: string | null;
  上次: { 时间: string; 结果: 通讯录结果类别; 话: string; 报告?: string[] } | null;
  /** 上游职务 → 业务角色（客户自定义的职务名在这里对到默认权限表的角色上） */
  角色对照: Record<string, 业务角色>;
  /** 上次见过的职务（设置页列出来给人对照） */
  职务们: string[];
  /** 上游部门 ID → EntDept.id */
  部门对照: Record<string, string>;
  /** 上游人 ID → User.id */
  人对照: Record<string, string>;
  /** 上次同步给每个人的业务角色：这边的和它不一样 = 有人手动改过，不覆盖 */
  给过: Record<string, 业务角色>;
  /** 多久同步一次：默认每小时，可改半小时 */
  间隔分钟?: 通讯录间隔;
};

export type 通讯录间隔 = 60 | 30;
export const 通讯录间隔们: 通讯录间隔[] = [60, 30];
const 默认: 通讯录设置 = { 开: false, 开的人Id: null, 上次: null, 角色对照: {}, 职务们: [], 部门对照: {}, 人对照: {}, 给过: {}, 间隔分钟: 60 };
export const 通讯录键 = (源: 通讯录来源) => `entOrgSync.${源}`;
/** 每小时一次：离上次满 55 分钟（钟每 5 分钟走一下）；选了半小时的满 25 分钟 */
export const 通讯录间隔毫秒 = 55 * 60_000;
const 间隔毫秒 = (s: Pick<通讯录设置, "间隔分钟">) => (s.间隔分钟 === 30 ? 25 * 60_000 : 通讯录间隔毫秒);
/** 角色对照只能给到这些：总管理 / 管理员只有老板在组织页手动给 */
export const 对照能给的角色 = (r: unknown): r is 业务角色 => 是业务角色(r) && r !== "director" && r !== "admin";
/** 同步建的账号的密码占位：不是 bcrypt 串，登录永远对不上，要管理员在用户管理里设密码 */
const 不能登录 = "!通讯录同步建的账号-请在用户管理里设密码";

export async function 读通讯录设置(源: 通讯录来源): Promise<通讯录设置> {
  return { ...默认, ...((await getSetting<Partial<通讯录设置>>(通讯录键(源))) ?? {}) };
}

async function 存设置(源: 通讯录来源, s: 通讯录设置, db: Pick<typeof prisma, "setting"> = prisma) {
  const value = JSON.stringify(s);
  await db.setting.upsert({ where: { key: 通讯录键(源) }, update: { value }, create: { key: 通讯录键(源), value } });
}

async function 改设置(源: 通讯录来源, 改: Partial<通讯录设置>): Promise<通讯录设置> {
  const s = { ...(await 读通讯录设置(源)), ...改 };
  await 存设置(源, s);
  invalidateSettingsCache();
  return s;
}

/** 开 / 关；开的时候记下是谁开的 */
export async function 开关通讯录同步(源: 通讯录来源, 开: boolean, 用户: Actor): Promise<通讯录设置> {
  const s = await 改设置(源, 开 ? { 开, 开的人Id: 用户.id } : { 开 });
  await recordAudit({ user: 用户, action: "update", entity: "EntOrgSync", entityId: 源, summary: `${开 ? "打开" : "关掉"}${通讯录来源名[源]}通讯录同步` });
  return s;
}

/** 改同步间隔（每小时 / 每半小时） */
export async function 存通讯录间隔(源: 通讯录来源, 分钟: number, 用户: Actor): Promise<通讯录设置> {
  const 间隔分钟: 通讯录间隔 = 分钟 === 30 ? 30 : 60;
  const s = await 改设置(源, { 间隔分钟 });
  await recordAudit({ user: 用户, action: "update", entity: "EntOrgSync", entityId: 源, summary: `${通讯录来源名[源]}通讯录改成${间隔分钟 === 30 ? "每半小时" : "每小时"}同步一次` });
  return s;
}

/** 存角色对照：职务名去空格，只留能给的角色 */
export async function 存角色对照(源: 通讯录来源, 对照: Record<string, string>, 用户: Actor): Promise<通讯录设置> {
  const 规整: Record<string, 业务角色> = {};
  for (const [k, v] of Object.entries(对照)) if (k.trim() && 对照能给的角色(v)) 规整[k.trim()] = v;
  const s = await 改设置(源, { 角色对照: 规整 });
  await recordAudit({ user: 用户, action: "update", entity: "EntOrgSync", entityId: 源, summary: `改${通讯录来源名[源]}职务对照`, detail: 规整 });
  return s;
}

/* ───────────────────────── 凭据 ───────────────────────── */

const 有值 = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** 每个来源设置页要填的凭据；密 = 只写不回显 */
export const 凭据字段: Record<通讯录来源, { 键: string; 名: string; 密?: boolean; env: string }[]> = {
  feishu: [
    { 键: "appId", 名: "App ID", env: "ENT_FEISHU_APP_ID" },
    { 键: "appSecret", 名: "App Secret", 密: true, env: "ENT_FEISHU_APP_SECRET" },
  ],
  dingtalk: [
    { 键: "appKey", 名: "AppKey", env: "ENT_DINGTALK_APP_KEY" },
    { 键: "appSecret", 名: "AppSecret", 密: true, env: "ENT_DINGTALK_APP_SECRET" },
    { 键: "操作人UserId", 名: "操作人 userId", env: "ENT_DINGTALK_OPERATOR" },
  ],
};

export type 凭据概况 = {
  /** 明文字段原样给，密的只给掩码（****尾 4 位）；来自环境变量的标 env */
  字段: { 键: string; 名: string; 密: boolean; 值: string; 已填: boolean; 来自环境变量: boolean }[];
  齐了: boolean;
};

export async function 读凭据概况(源: 通讯录来源): Promise<凭据概况> {
  const c = (await 读连接配置(源)) ?? {};
  const 字段 = 凭据字段[源].map((f) => {
    const 库里 = 有值(c[f.键]) ? (c[f.键] as string) : null;
    const 环境 = 库里 ? null : 有值(process.env[f.env]) ? process.env[f.env]! : null;
    const v = 库里 ?? 环境;
    return { 键: f.键, 名: f.名, 密: !!f.密, 值: !v ? "" : f.密 ? maskSecret(v) : v, 已填: !!v, 来自环境变量: !库里 && !!环境 };
  });
  // 钉钉的操作人可以不填（只有部分接口要），齐不齐只看 key + secret
  const 齐了 = 字段.filter((f) => f.键 !== "操作人UserId").every((f) => f.已填);
  return { 字段, 齐了 };
}

/** 存凭据：密的字段空着 = 不改，存的是密文（库里看不到明文）；和导入共用同一份连接配置，别的键（表们、基址）原样留着 */
export async function 存通讯录凭据(源: 通讯录来源, 填: Record<string, string>, 用户: Actor): Promise<凭据概况> {
  const 原 = (await getSetting<Record<string, unknown>>(连接键(源))) ?? {};
  const 原明 = (await 读连接配置(源)) ?? {};
  const 新 = { ...原 };
  const 改了: string[] = [];
  for (const f of 凭据字段[源]) {
    const v = typeof 填[f.键] === "string" ? 填[f.键].trim() : undefined;
    if (v === undefined || (f.密 && v === "")) continue;
    if (v === (原明[f.键] ?? "")) continue;
    if (v === "") delete 新[f.键];
    else 新[f.键] = f.密 ? encryptSecret(v) : v;
    改了.push(f.名);
  }
  const value = JSON.stringify(新);
  await prisma.setting.upsert({ where: { key: 连接键(源) }, update: { value }, create: { key: 连接键(源), value } });
  invalidateSettingsCache();
  // 留痕只写改了哪几项，不写值
  if (改了.length) await recordAudit({ user: 用户, action: "update", entity: "EntConn", entityId: 源, summary: `改${通讯录来源名[源]}连接凭据：${改了.join("、")}` });
  return 读凭据概况(源);
}

/** 按凭据建适配器；没配返回 null */
async function 建适配器(源: 通讯录来源): Promise<{ 拉通讯录(): Promise<通讯录> } | null> {
  const c = (await 读连接配置(源)) ?? {};
  const 网 = 当前联网();
  if (源 === "feishu") {
    const appId = 有值(c.appId) ? c.appId : process.env.ENT_FEISHU_APP_ID;
    const appSecret = 有值(c.appSecret) ? c.appSecret : process.env.ENT_FEISHU_APP_SECRET;
    if (!有值(appId) || !有值(appSecret)) return null;
    return new 飞书适配器({ appId, appSecret, 表们: [], 基址: 有值(c.基址) ? c.基址 : undefined }, 网);
  }
  const appKey = 有值(c.appKey) ? c.appKey : process.env.ENT_DINGTALK_APP_KEY;
  const appSecret = 有值(c.appSecret) ? c.appSecret : process.env.ENT_DINGTALK_APP_SECRET;
  if (!有值(appKey) || !有值(appSecret)) return null;
  const 操作人UserId = 有值(c.操作人UserId) ? c.操作人UserId : (process.env.ENT_DINGTALK_OPERATOR ?? "");
  return new 钉钉适配器(
    { appKey, appSecret, 操作人UserId, 基址: 有值(c.基址) ? c.基址 : undefined, 老基址: 有值(c.老基址) ? c.老基址 : undefined },
    网,
    网 === 真联网 ? undefined : 0,
  );
}

/* ───────────────────────── 排计划（纯内存） ───────────────────────── */

type 现有 = {
  部门: { id: string; name: string; parentId: string | null; sort: number }[];
  成员: { userId: string; deptId: string | null; bizRole: string; managerId: string | null; line: string | null; dottedManagerId: string | null }[];
  用户: { id: string; email: string; name: string; role: string; active: boolean }[];
};

type 部门计划 = { 外部ID: string; id: string | null; name: string; 上级外部ID: string | null; sort: number };
type 人计划 = {
  外部ID: string;
  userId: string | null;
  新建?: { email: string; name: string; title: string };
  deptExt: string | null;
  上级外部ID: string | null;
  bizRole: 业务角色 | null;
};

/** 上游每个部门在第几层（根下面 = 1）；断链的当挂在根上，成环的截断 */
function 算层数(部门们: 通讯录部门[]): Map<string, number> {
  const by = new Map(部门们.map((d) => [d.外部ID, d]));
  const 层 = new Map<string, number>();
  const 深 = (id: string, 路: Set<string>): number => {
    const 有 = 层.get(id);
    if (有 !== undefined) return 有;
    const d = by.get(id)!;
    const p = d.上级外部ID;
    const n = p && by.has(p) && !路.has(p) ? 深(p, new Set(路).add(id)) + 1 : 1;
    层.set(id, n);
    return n;
  };
  for (const d of 部门们) 深(d.外部ID, new Set([d.外部ID]));
  return 层;
}

/** 超过 3 层的部门 → 它第 3 层的那个祖先 */
function 并到第三层(部门们: 通讯录部门[], 层: Map<string, number>): Map<string, string> {
  const by = new Map(部门们.map((d) => [d.外部ID, d]));
  const 归 = new Map<string, string>();
  for (const d of 部门们) {
    let cur = d;
    for (let i = 0; (层.get(cur.外部ID) ?? 1) > 部门最多层数 && i < 1000; i++) cur = by.get(cur.上级外部ID!)!;
    归.set(d.外部ID, cur.外部ID);
  }
  return 归;
}

/* ───────────────────────── 同步一次 ───────────────────────── */

export type 通讯录一次结果 = { 结果: 通讯录结果类别; 话: string; 报告: string[] };

const 在同步 = new Set<通讯录来源>();

export async function 同步通讯录(源: 通讯录来源, opts: { 用户?: Actor; 现在?: Date } = {}): Promise<通讯录一次结果> {
  if (!企业版()) return { 结果: "跳过", 话: "不是企业版", 报告: [] };
  if (在同步.has(源)) return { 结果: "跳过", 话: "上一次还没同步完", 报告: [] };
  在同步.add(源);
  const 现在 = opts.现在 ?? new Date();
  const 名 = 通讯录来源名[源];
  try {
    const 适配器 = await 建适配器(源);
    if (!适配器) return await 记上次(源, 现在, "没接", `${名}还没接：要在${名}开放平台建应用、开通讯录读取权限，把 App ID / App Secret 存进来`);
    let 本: 通讯录;
    try {
      本 = await 适配器.拉通讯录();
    } catch (e) {
      return await 记上次(源, 现在, "出错", `拉${名}通讯录出错，这次一行没写，下次再试：${e instanceof Error ? e.message : String(e)}`);
    }
    const s = await 读通讯录设置(源);
    const 用户 = opts.用户 ?? (await 记名的人(s.开的人Id));
    try {
      const r = await 写进去(源, s, 本, 现在);
      if (用户 && r.结果 === "成功") {
        await recordAudit({ user: 用户, action: "sync", entity: "EntOrgSync", entityId: 源, summary: `同步${名}通讯录：${r.话}`, detail: { 报告: r.报告 } });
      }
      if (r.结果 === "成功") 忘掉企业版范围();
      return r;
    } catch (e) {
      console.error(`[企业版通讯录] ${源}`, e);
      return await 记上次(源, 现在, "出错", `写组织架构出错，已整个撤回，下次再试：${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    在同步.delete(源);
  }
}

async function 记上次(源: 通讯录来源, 现在: Date, 结果: 通讯录结果类别, 话: string, 报告: string[] = []): Promise<通讯录一次结果> {
  await 改设置(源, { 上次: { 时间: 现在.toISOString(), 结果, 话, 报告 } });
  return { 结果, 话, 报告 };
}

async function 记名的人(id: string | null): Promise<Actor | null> {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
  return u ?? null;
}

async function 写进去(源: 通讯录来源, s: 通讯录设置, 本: 通讯录, 现在: Date): Promise<通讯录一次结果> {
  const 名 = 通讯录来源名[源];
  const 报告: string[] = [];
  return prisma.$transaction(
    async (tx) => {
      const 有: 现有 = {
        部门: await tx.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } }),
        成员: await tx.entMember.findMany({ select: { userId: true, deptId: true, bizRole: true, managerId: true, line: true, dottedManagerId: true } }),
        用户: await tx.user.findMany({ select: { id: true, email: true, name: true, role: true, active: true } }),
      };
      const 部门有 = new Map(有.部门.map((d) => [d.id, d]));
      const 用户有 = new Map(有.用户.map((u) => [u.id, u]));
      const 成员有 = new Map(有.成员.map((m) => [m.userId, m]));
      let 改了 = 0;

      /* —— 部门 —— */
      const 层 = 算层数(本.部门们);
      const 归 = 并到第三层(本.部门们, 层);
      const 部门对照: Record<string, string> = {};
      const 认领了 = new Set<string>();
      const 留的 = 本.部门们
        .filter((d) => 归.get(d.外部ID) === d.外部ID)
        .sort((a, b) => (层.get(a.外部ID)! - 层.get(b.外部ID)!) || a.排序 - b.排序);
      for (const d of 本.部门们) {
        if (归.get(d.外部ID) !== d.外部ID) 报告.push(`部门「${d.名}」在第 ${层.get(d.外部ID)} 层，这边最多 ${部门最多层数} 层，里面的人并到上面的部门`);
      }
      for (const d of 留的) {
        const 上级外部 = d.上级外部ID && 归.has(d.上级外部ID) ? 归.get(d.上级外部ID)! : null;
        const parentId = 上级外部 ? (部门对照[上级外部] ?? null) : null;
        const name = d.名.trim().slice(0, 40) || "未命名部门";
        let id = s.部门对照[d.外部ID];
        if (id && !部门有.has(id)) id = undefined as unknown as string;
        if (!id) {
          const 同名 = 有.部门.find((x) => !认领了.has(x.id) && !Object.values(s.部门对照).includes(x.id) && x.name === name && (x.parentId ?? null) === parentId);
          if (同名) id = 同名.id;
        }
        if (id) {
          const 原 = 部门有.get(id)!;
          if (原.name !== name || (原.parentId ?? null) !== parentId || 原.sort !== d.排序) {
            await tx.entDept.update({ where: { id }, data: { name, parentId, sort: d.排序 } });
            改了++;
          }
        } else {
          id = (await tx.entDept.create({ data: { name, parentId, sort: d.排序 } })).id;
          改了++;
        }
        认领了.add(id);
        部门对照[d.外部ID] = id;
      }
      for (const [ext, to] of 归) if (ext !== to && 部门对照[to]) 部门对照[ext] = 部门对照[to];

      /* —— 人 —— */
      const 按邮箱 = new Map(有.用户.map((u) => [u.email.toLowerCase(), u.id]));
      const 人对照: Record<string, string> = {};
      const 职务们 = new Set<string>();
      const 计划们: 人计划[] = [];
      let 新建数 = 0;
      const 要建的邮箱 = new Set<string>();
      for (const p of 本.人们) {
        const 职务 = p.职务?.trim() ?? "";
        if (职务) 职务们.add(职务);
        let uid: string | null = s.人对照[p.外部ID] && 用户有.has(s.人对照[p.外部ID]) ? s.人对照[p.外部ID] : null;
        const 邮箱 = p.邮箱?.trim().toLowerCase();
        // 上游没给邮箱的，按上次建号用的兜底邮箱认（人对照丢了也不会每次撞唯一键）
        const 兜底邮箱 = `${源}-${p.外部ID}@contacts.invalid`.toLowerCase();
        if (!uid) uid = 按邮箱.get(邮箱 || 兜底邮箱) ?? null;
        if (p.离职) {
          if (uid && 用户有.get(uid)?.active) 报告.push(`${p.名} 在${名}已离职，这边账号还开着：要停用请走离职交接`);
          if (uid) 人对照[p.外部ID] = uid;
          continue;
        }
        const deptExt = p.部门外部IDs.find((x) => 部门对照[x]) ?? null;
        // 上游两个人填了同一个新邮箱：第二个用兜底邮箱建，别撞唯一键让整次同步失败
        let 新邮箱 = 邮箱 || 兜底邮箱;
        if (!uid && 要建的邮箱.has(新邮箱)) {
          报告.push(`${p.名} 和别人在${名}填了同一个邮箱 ${新邮箱}，先用 ${兜底邮箱} 建了账号`);
          新邮箱 = 兜底邮箱;
        }
        if (!uid) 要建的邮箱.add(新邮箱);
        计划们.push({
          外部ID: p.外部ID,
          userId: uid,
          新建: uid ? undefined : { email: 新邮箱,  name: p.名.trim() || p.外部ID, title: 职务 || "销售" },
          deptExt,
          上级外部ID: p.上级外部ID ?? null,
          bizRole: null,
        });
        // 业务角色
        // 现有的人：没有 EntMember 行的按账号角色推（和组织页一致）
        const 现角色 = uid ? (成员有.get(uid)?.bizRole ?? 推业务角色(用户有.get(uid)?.role)) : undefined;
        const 老板 = uid ? 用户有.get(uid)?.role === "ADMIN" : false;
        const 总管级 = 现角色 === "director" || 现角色 === "admin";
        const 手动改过 = !!uid && s.给过[uid] !== undefined && 现角色 !== s.给过[uid];
        // 第一次同步认到的现有账号：只有职务对照（管理员明确配的）能改它的角色，别的保持原样
        const 第一次认到 = !!uid && s.给过[uid] === undefined;
        const 对上的 = 职务 ? s.角色对照[职务] : undefined;
        const 这个 = 计划们[计划们.length - 1];
        if (老板 || 总管级 || 手动改过) continue;
        if (对上的 && 对照能给的角色(对上的)) 这个.bizRole = 对上的;
        else if (第一次认到) continue;
        else 这个.bizRole = p.是负责人 ? "sales_mgr" : "sales";
      }

      // 先把要建的账号建出来，拿到 id
      for (const p of 计划们) {
        if (p.userId) {
          人对照[p.外部ID] = p.userId;
          continue;
        }
        const n = p.新建!;
        const u = await tx.user.create({ data: { email: n.email, name: n.name, title: n.title, role: "SALES", password: 不能登录 } });
        p.userId = u.id;
        人对照[p.外部ID] = u.id;
        用户有.set(u.id, { id: u.id, email: u.email, name: u.name, role: u.role, active: true });
        新建数++;
        改了++;
      }

      /* —— 部门、角色先落到组织里，再一个个设上级（设一个查一次环） —— */
      const 目标: Map<string, { deptId: string | null; bizRole: string; managerId: string | null; line: string | null; dottedManagerId: string | null }> = new Map(
        有.成员.map((m) => [m.userId, { deptId: m.deptId, bizRole: m.bizRole, managerId: m.managerId, line: m.line, dottedManagerId: m.dottedManagerId }]),
      );
      const 给过 = { ...s.给过 };
      for (const p of 计划们) {
        const uid = p.userId!;
        const 原 = 目标.get(uid);
        const deptId = p.deptExt ? 部门对照[p.deptExt] : (原?.deptId ?? null);
        const bizRole = p.bizRole ?? 原?.bizRole ?? 推业务角色(用户有.get(uid)?.role);
        if (p.bizRole) 给过[uid] = p.bizRole;
        // 第一次认到、没动它的：记下当时的角色，下次才分得清是不是有人手动改过
        else if (给过[uid] === undefined && 是业务角色(bizRole)) 给过[uid] = bizRole;
        目标.set(uid, { deptId, bizRole, managerId: 原?.managerId ?? null, line: 原?.line ?? null, dottedManagerId: 原?.dottedManagerId ?? null });
      }
      const 部门后 = await tx.entDept.findMany({ select: { id: true, name: true, parentId: true, sort: true } });
      const 用户们 = [...用户有.values()];
      for (const p of 计划们) {
        if (!p.上级外部ID) continue;
        const uid = p.userId!;
        const 上级 = 人对照[p.上级外部ID] ?? null;
        const 现 = 目标.get(uid)!;
        if (!上级 || 上级 === 现.managerId) continue;
        const org = 建组织(用户们, [...目标].map(([userId, m]) => ({ userId, ...m })), 部门后);
        const 问题 = 上级设置问题(org, uid, 上级, "直属");
        if (问题) {
          报告.push(`${用户有.get(uid)?.name ?? uid} 的直属上级没设成 ${用户有.get(上级)?.name ?? 上级}：${问题}`);
          continue;
        }
        现.managerId = 上级;
      }

      /* —— 写成员 —— */
      for (const p of 计划们) {
        const uid = p.userId!;
        const m = 目标.get(uid)!;
        const 原 = 成员有.get(uid);
        if (原 && 原.deptId === m.deptId && 原.bizRole === m.bizRole && 原.managerId === m.managerId) continue;
        await tx.entMember.upsert({
          where: { userId: uid },
          update: { deptId: m.deptId, bizRole: m.bizRole, managerId: m.managerId },
          create: { userId: uid, deptId: m.deptId, bizRole: m.bizRole, managerId: m.managerId },
        });
        改了++;
      }

      /* —— 上游删了的部门：空了才删 —— */
      const 现部门对照值 = new Set(Object.values(部门对照));
      for (const [ext, id] of Object.entries(s.部门对照)) {
        if (部门对照[ext] || 现部门对照值.has(id) || !部门有.has(id)) continue;
        const 还有人 = [...目标.values()].some((m) => m.deptId === id);
        const 还有下级 = 部门后.some((d) => d.parentId === id);
        if (还有人 || 还有下级) {
          报告.push(`部门「${部门有.get(id)!.name}」${名}那边删了，这边${还有人 ? "还有人" : "还有下级部门"}，先留着`);
          部门对照[ext] = id;
          continue;
        }
        await tx.entDept.delete({ where: { id } });
        改了++;
      }

      const 话 = 改了
        ? `部门 ${留的.length} 个、成员 ${计划们.length} 人${新建数 ? `，新建 ${新建数} 个账号（还不能登录，要在用户管理里设密码）` : ""}${报告.length ? `，${报告.length} 条要看` : ""}`
        : `没变化${报告.length ? `，${报告.length} 条要看` : ""}`;
      const 结果: 通讯录结果类别 = 改了 ? "成功" : "没变化";
      const 新设置: 通讯录设置 = {
        ...s,
        部门对照,
        人对照,
        给过,
        职务们: [...职务们].sort(),
        上次: { 时间: 现在.toISOString(), 结果, 话, 报告 },
      };
      await 存设置(源, 新设置, tx);
      return { 结果, 话, 报告 };
    },
    { timeout: 120_000, maxWait: 10_000 },
  ).finally(() => invalidateSettingsCache());
}

/* ───────────────────────── 定时 ───────────────────────── */

export function 通讯录到点了(s: 通讯录设置, 现在: Date): boolean {
  if (!s.开) return false;
  return !s.上次 || 现在.getTime() - new Date(s.上次.时间).getTime() >= 间隔毫秒(s);
}

/** 定时钟（enterprise-import/sync.ts 的 定时扫一遍）每 5 分钟调一次：开着、到点了的来源同步一次 */
export async function 定时同步通讯录(现在 = new Date()): Promise<void> {
  if (!企业版()) return;
  for (const 源 of 通讯录来源们) {
    try {
      if (通讯录到点了(await 读通讯录设置(源), 现在)) await 同步通讯录(源, { 现在 });
    } catch (e) {
      console.error(`[企业版通讯录] ${源}`, e);
    }
  }
}

export { 角色名 };
