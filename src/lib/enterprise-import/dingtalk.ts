/**
 * 钉钉 CRM 适配器：照钉钉开放平台官方接口拉客户、联系人、商机、跟进记录。
 *
 * - 客户：新接口 GET /v1.0/crm/personalCustomers（个人客户 crm_customer_personal、企业客户 crm_customer 各拉一遍）
 * - 联系人：新接口 POST /v1.0/crm/customObjects/contacts/datas/query
 * - 商机：钉钉没有内置商机，客户一般用自定义表单做，POST /v1.0/crm/customObjects/datas/query（要配表单 code）
 * - 跟进记录：只有老接口 POST oapi /topapi/crm/objectdata/followrecord/query
 *
 * 每条数据的 data 是「字段 key → 值」，值有时是串、有时是 {value, extendValue}（有时还整个是 JSON 串）。
 * 先读各对象的字段描述，把 key 换成中文 label；关联到客户 / 商机的列从 extendValue 里取 instanceId，
 * 放进「客户ID」「商机ID」，正好是 clean.ts 按外部ID 认父记录的那两列。负责人 userId 换成名字。
 */
import type { 适配器 } from "./adapter";
import { 接口出错, 最多重试, 退避, 读JSON as 读, 真联网, type 联网 } from "./net";
import type { 原始记录, 实体 } from "./types";

export type 钉钉配置 = {
  appKey: string;
  appSecret: string;
  /** 以谁的身份查（钉钉 CRM 接口都要传操作人 userId，看到的数据 = 这个人能看到的），一般给 CRM 管理员 */
  操作人UserId: string;
  /** 默认个人客户 + 企业客户都拉 */
  客户类型们?: string[];
  /** 商机用的自定义表单 code（PROC-…）；没配就不拉商机 */
  商机表单code?: string;
  基址?: string;
  老基址?: string;
};

type 字段描述 = { 名: string; 指向?: string };
type 钉钉数据 = { 实例ID: string; data: unknown; 负责人们: string[]; 创建人?: string };

const 每页 = 100;
const 跟进每页 = 200;
const 新限流 = new Set(["request.too.frequent", "Throttling", "Throttling.User", "Throttling.Api"]);
const 新令牌失效 = new Set(["InvalidAuthentication", "invalidAuthentication", "Forbidden.AccessTokenExpired"]);
const 老限流 = new Set([90018, 90002, 90006]);
const 老令牌失效 = new Set([40014, 42001, 41001]);
const 说人话: Record<string, string> = {
  "systemError.notPermittedAccess": "应用没有 CRM 读取权限：要在钉钉开发者后台给应用开「CRM 数据读权限」后再试",
  "Forbidden.AccessDenied.AccessTokenPermissionDenied": "应用没有这个接口的权限：要在钉钉开发者后台给应用开 CRM 相关权限",
  "60011": "应用没有这个接口的权限：要在钉钉开发者后台给应用开 CRM 相关权限",
  "60020": "服务器 IP 不在应用白名单里：要在钉钉开发者后台把服务器 IP 加进去",
  "40089": "appKey 或 appSecret 不对",
  invalidClientId: "appKey 不对",
  invalidClientSecret: "appSecret 不对",
  "60121": "操作人 userId 在通讯录里找不到",
};

export class 钉钉适配器 implements 适配器 {
  来源 = "dingtalk" as const;
  private 令牌: { 值: string; 到期: number } | null = null;
  private 上次调用 = 0;
  private 人名 = new Map<string, string>();

  constructor(
    private 配置: 钉钉配置,
    private 网: 联网 = 真联网,
    /** 钉钉 CRM 接口默认 1 秒 1 次，两次调用之间至少隔这么久 */
    private 间隔 = 1100,
  ) {}

  private get 基址() {
    return (this.配置.基址 ?? "https://api.dingtalk.com").replace(/\/+$/, "");
  }
  private get 老基址() {
    return (this.配置.老基址 ?? "https://oapi.dingtalk.com").replace(/\/+$/, "");
  }

  private async 节流() {
    const 差 = this.上次调用 + this.间隔 - this.网.现在();
    if (差 > 0) await this.网.等(差);
    this.上次调用 = this.网.现在();
  }

  private async 取令牌(): Promise<string> {
    if (this.令牌 && this.令牌.到期 > this.网.现在()) return this.令牌.值;
    const res = await this.网.fetch(`${this.基址}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: this.配置.appKey, appSecret: this.配置.appSecret }),
    });
    const j = await 读(res);
    if (!res.ok || typeof j?.accessToken !== "string") {
      throw new 接口出错(`钉钉拿不到访问令牌（HTTP ${res.status}${j?.code ? `，${j.code}` : ""}）：${报错(j)}`);
    }
    const 秒 = typeof j.expireIn === "number" ? j.expireIn : 7200;
    this.令牌 = { 值: j.accessToken, 到期: this.网.现在() + Math.max(60, 秒 - 300) * 1000 };
    return this.令牌.值;
  }

  /** 新接口（api.dingtalk.com）：令牌放请求头，出错时 HTTP 非 2xx + {code, message} */
  private async 调新(动作: string, 方法: "GET" | "POST", 路径: string, 参数: Record<string, string | undefined>, 体?: unknown) {
    let 换过令牌 = false;
    for (let 第几次 = 0; ; 第几次++) {
      await this.节流();
      const url = new URL(this.基址 + 路径);
      for (const [k, v] of Object.entries(参数)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
      const res = await this.网.fetch(url.toString(), {
        method: 方法,
        headers: { "x-acs-dingtalk-access-token": await this.取令牌(), "Content-Type": "application/json" },
        body: 体 === undefined ? undefined : JSON.stringify(体),
      });
      const j = await 读(res);
      const code = typeof j?.code === "string" ? j.code : "";
      // 超 QPS 有时给 403 + Forbidden.AccessDenied.QpsLimitForApi / QpsLimitForAppkeyAndApi，也按限流等
      if ((res.status === 429 || 新限流.has(code) || code.startsWith("Forbidden.AccessDenied.QpsLimit")) && 第几次 < 最多重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      if ((res.status === 401 || 新令牌失效.has(code)) && !换过令牌) {
        换过令牌 = true;
        this.令牌 = null;
        continue;
      }
      if (res.ok && j) return j;
      throw new 接口出错(`钉钉${动作}出错（HTTP ${res.status}${code ? `，${code}` : ""}）：${报错(j)}`);
    }
  }

  /** 老接口（oapi.dingtalk.com）：令牌放 query，HTTP 总是 200，看 errcode */
  private async 调老(动作: string, 路径: string, 体: unknown) {
    let 换过令牌 = false;
    for (let 第几次 = 0; ; 第几次++) {
      await this.节流();
      const url = `${this.老基址}${路径}?access_token=${encodeURIComponent(await this.取令牌())}`;
      const res = await this.网.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(体) });
      const j = await 读(res);
      const code = typeof j?.errcode === "number" ? j.errcode : undefined;
      if ((res.status === 429 || (code !== undefined && 老限流.has(code))) && 第几次 < 最多重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      if (code !== undefined && 老令牌失效.has(code) && !换过令牌) {
        换过令牌 = true;
        this.令牌 = null;
        continue;
      }
      if (res.ok && code === 0) return j as Record<string, unknown>;
      throw new 接口出错(`钉钉${动作}出错（HTTP ${res.status}${code !== undefined ? `，errcode ${code}` : ""}）：${(code !== undefined && 说人话[String(code)]) || String(j?.errmsg ?? "没有返回内容")}`);
    }
  }

  // —— 字段描述 ——

  private async 客户字段(类型: string) {
    const j = await this.调新("读客户字段", "GET", "/v1.0/crm/personalCustomers/objectMeta", { relationType: 类型 });
    return 字段表(j.fields, "referenceTo");
  }
  private async 老字段(动作: string, 路径: string, 体: unknown = {}) {
    const j = await this.调老(动作, 路径, 体);
    return 字段表((j.result as Record<string, unknown> | undefined)?.fields, "reference_to");
  }

  // —— 拉数据（分页） ——

  private async 拉客户(类型: string, dsl?: string): Promise<钉钉数据[]> {
    const 出: 钉钉数据[] = [];
    let nextToken: string | undefined;
    do {
      const j = await this.调新("拉客户", "GET", "/v1.0/crm/personalCustomers", {
        currentOperatorUserId: this.配置.操作人UserId,
        relationType: 类型,
        nextToken,
        maxResults: String(每页),
        queryDsl: dsl,
      });
      for (const v of 数组(j.values)) {
        const p = (v.permission ?? {}) as Record<string, unknown>;
        if (typeof v.instanceId === "string") 出.push({ 实例ID: v.instanceId, data: v.data, 负责人们: 串数组(p.ownerStaffIds) });
      }
      nextToken = j.hasMore ? String(j.nextToken ?? "") || undefined : undefined;
    } while (nextToken);
    return 出;
  }

  private async 拉自定义(动作: string, 路径: string, 附加: Record<string, unknown>, dsl?: string): Promise<钉钉数据[]> {
    const 出: 钉钉数据[] = [];
    let nextToken = "0";
    for (;;) {
      const j = await this.调新(动作, "POST", 路径, {}, {
        currentOperatorUserId: this.配置.操作人UserId,
        nextToken,
        maxResults: 每页,
        ...附加,
        ...(dsl ? { queryDsl: dsl } : {}),
      });
      const r = (j.result ?? {}) as Record<string, unknown>;
      for (const v of 数组(r.values)) {
        const p = (v.permission ?? {}) as Record<string, unknown>;
        if (typeof v.instanceId === "string") 出.push({ 实例ID: v.instanceId, data: v.data, 负责人们: 串数组(p.ownerUserIds ?? p.ownerStaffIds) });
      }
      if (!r.hasMore || !r.nextToken) return 出;
      nextToken = String(r.nextToken);
    }
  }

  private async 拉跟进(dsl?: string): Promise<钉钉数据[]> {
    const 出: 钉钉数据[] = [];
    let cursor = "0";
    for (;;) {
      const j = await this.调老("拉跟进记录", "/topapi/crm/objectdata/followrecord/query", {
        cursor,
        current_operator_userid: this.配置.操作人UserId,
        page_size: 跟进每页,
        ...(dsl ? { query_dsl: dsl } : {}),
      });
      const r = (j.result ?? {}) as Record<string, unknown>;
      for (const v of 数组(r.values)) {
        const p = (v.permission ?? {}) as Record<string, unknown>;
        if (typeof v.instance_id === "string") {
          出.push({ 实例ID: v.instance_id, data: v.data, 负责人们: 串数组(p.owner_userid_list), 创建人: typeof v.creator_userid === "string" ? v.creator_userid : undefined });
        }
      }
      if (!r.has_more || !r.next_cursor) return 出;
      cursor = String(r.next_cursor);
    }
  }

  /** userId → 名字；查不到（没通讯录权限、人已离职）就给 userId 本身，清洗时会报「负责人对不上」 */
  private async 名字(userId: string): Promise<string> {
    const 有 = this.人名.get(userId);
    if (有 !== undefined) return 有;
    let 名 = userId;
    try {
      const j = await this.调老("查成员名字", "/topapi/v2/user/get", { userid: userId });
      const n = (j.result as Record<string, unknown> | undefined)?.name;
      if (typeof n === "string" && n.trim()) 名 = n.trim();
    } catch {
      // 通讯录权限不是必需的，查不到就用 userId
    }
    this.人名.set(userId, 名);
    return 名;
  }

  private async 成记录(实体: 实体, 字段们: Map<string, 字段描述>, d: 钉钉数据, 出处: string): Promise<原始记录> {
    const 字段: Record<string, string> = { 记录ID: d.实例ID };
    for (const f of 字段们.values()) 字段[f.名] = "";
    const data = 解(d.data);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [key, 原值] of Object.entries(data as Record<string, unknown>)) {
        const f = 字段们.get(key);
        const 名 = f?.名 ?? key;
        const { 文本, 指向ID, 指向类型, 人们 } = 钉钉值(原值);
        字段[名] = 人们.length ? (await Promise.all(人们.map((u) => this.名字(u)))).join("、") : 文本;
        const 放 = 父列(实体, 指向类型 ?? f?.指向, this.配置.商机表单code);
        if (放 && 指向ID && !字段[放]) 字段[放] = 指向ID;
      }
    }
    const 负责人 = d.负责人们[0] ?? d.创建人;
    if (负责人 && !字段.负责人) 字段.负责人 = await this.名字(负责人);
    if (实体 === "customer") delete 字段.客户ID;
    if (实体 !== "followup") delete 字段.商机ID;
    return { 实体, 外部ID: d.实例ID, 字段, 出处 };
  }

  async 拉全量() {
    return this.拉变化(null);
  }

  async 拉变化(since: Date | null) {
    const dsl = since ? 改于之后(since.getTime(), this.网.现在()) : undefined;
    const 出: 原始记录[] = [];

    for (const 类型 of this.配置.客户类型们 ?? ["crm_customer_personal", "crm_customer"]) {
      const 字段们 = await this.客户字段(类型);
      for (const d of await this.拉客户(类型, dsl)) 出.push(await this.成记录("customer", 字段们, d, `钉钉 · ${类型 === "crm_customer" ? "企业客户" : "个人客户"}`));
    }

    const 联系人字段 = await this.老字段("读联系人字段", "/topapi/crm/objectmeta/contact/describe");
    for (const d of await this.拉自定义("拉联系人", "/v1.0/crm/customObjects/contacts/datas/query", { objectType: "crm_contact" }, dsl)) {
      出.push(await this.成记录("contact", 联系人字段, d, "钉钉 · 联系人"));
    }

    if (this.配置.商机表单code) {
      const code = this.配置.商机表单code;
      const 商机字段 = await this.老字段("读商机字段", "/topapi/crm/objectmeta/describe", { name: code });
      for (const d of await this.拉自定义("拉商机", "/v1.0/crm/customObjects/datas/query", { name: code }, dsl)) {
        出.push(await this.成记录("opportunity", 商机字段, d, "钉钉 · 商机"));
      }
    }

    const 跟进字段 = await this.老字段("读跟进记录字段", "/topapi/crm/objectmeta/followrecord/describe");
    for (const d of await this.拉跟进(dsl)) 出.push(await this.成记录("followup", 跟进字段, d, "钉钉 · 跟进记录"));
    return 出;
  }
}

// —— 纯函数（契约测试直接测） ——

function 报错(j: Record<string, unknown> | null): string {
  const code = typeof j?.code === "string" ? j.code : "";
  return 说人话[code] || String(j?.message ?? "没有返回内容");
}

const 数组 = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
const 串数组 = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);

/** 字段描述 → key → {中文名, 指向}；label 重了的加 key 区分 */
function 字段表(fields: unknown, 指向键: string): Map<string, 字段描述> {
  const 表 = new Map<string, 字段描述>();
  const 用过 = new Set<string>();
  for (const f of 数组(fields)) {
    const key = typeof f.name === "string" ? f.name : "";
    if (!key) continue;
    let 名 = typeof f.label === "string" && f.label.trim() ? f.label.trim() : key;
    if (用过.has(名)) 名 = `${名}（${key}）`;
    用过.add(名);
    const 指向 = typeof f[指向键] === "string" ? (f[指向键] as string) : undefined;
    表.set(key, { 名, 指向 });
  }
  return 表;
}

/** 串里装的 JSON 拆开；拆不开原样给 */
function 解(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!(s.startsWith("{") || s.startsWith("["))) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** 一个格子的值 → 文本；关联列顺带给出指向的实例 ID 和对象类型；成员列给 userId 们（再换名字） */
export function 钉钉值(原: unknown): { 文本: string; 指向ID?: string; 指向类型?: string; 人们: string[] } {
  const v = 解(原);
  if (v === null || v === undefined) return { 文本: "", 人们: [] };
  if (typeof v === "number" || typeof v === "boolean") return { 文本: v === true ? "是" : v === false ? "否" : String(v), 人们: [] };
  if (typeof v === "string") return { 文本: v.trim(), 人们: [] };
  if (Array.isArray(v)) {
    const 字 = v.map((x) => (x && typeof x === "object" ? 钉钉值(x).文本 : String(x ?? ""))).filter(Boolean);
    return { 文本: 字.join("、"), 人们: [] };
  }
  const o = v as Record<string, unknown>;
  if ("value" in o || "extendValue" in o) {
    const 扩 = 解(o.extendValue);
    const 扩o = 扩 && typeof 扩 === "object" && !Array.isArray(扩) ? (扩 as Record<string, unknown>) : null;
    const 列 = 扩o ? 数组(扩o.list) : 数组(扩);
    const 关联 = 列.find((x) => typeof x.instanceId === "string");
    // 成员列：extendValue 里是 [{userId,name}] / [{emplId,name}]
    const 成员 = 列.filter((x) => typeof (x.userId ?? x.emplId) === "string");
    let 文本 = 钉钉值(o.value).文本;
    if (成员.length && 成员.every((x) => typeof x.name === "string")) 文本 = 成员.map((x) => x.name as string).join("、");
    else if (关联 && 列.some((x) => typeof x.name === "string")) 文本 = 列.map((x) => String(x.name ?? "")).filter(Boolean).join("、");
    else if (扩o && typeof 扩o.label === "string" && !文本) 文本 = 扩o.label;
    const 人们 = 成员.length && !成员.every((x) => typeof x.name === "string") ? 成员.map((x) => String(x.userId ?? x.emplId)) : [];
    return 关联 ? { 文本, 指向ID: 关联.instanceId as string, 指向类型: typeof 关联.bizType === "string" ? 关联.bizType : undefined, 人们 } : { 文本, 人们 };
  }
  for (const k of ["name", "label", "text", "address"]) if (typeof o[k] === "string") return { 文本: (o[k] as string).trim(), 人们: [] };
  return { 文本: "", 人们: [] };
}

/** 指向客户 → 「客户ID」（联系人 / 商机 / 跟进才放），指向商机表单 → 「商机ID」（跟进才放） */
function 父列(子: 实体, 指向: string | undefined, 商机code: string | undefined): "客户ID" | "商机ID" | null {
  if (!指向) return null;
  if (指向.startsWith("crm_customer")) return 子 === "customer" ? null : "客户ID";
  if (商机code && 指向 === 商机code) return 子 === "followup" ? "商机ID" : null;
  return null;
}

/** 增量查询：gmt_modified 在 (since, now] 之间，按修改时间升序 */
export function 改于之后(sinceMs: number, nowMs: number): string {
  return JSON.stringify({
    queryGroupList: [{ logicType: "AND", queryObjectList: [{ filterType: "BETWEEN", fieldId: "gmt_modified", value: [String(sinceMs + 1), String(nowMs)] }] }],
    order: "ASC",
    orderFieldId: "gmt_modified",
  });
}
