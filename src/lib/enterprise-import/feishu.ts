/**
 * 飞书适配器：从飞书多维表格拉客户、联系人、商机、跟进记录（一类一张表，客户在配置里指好）。
 *
 * 照飞书开放平台的接口（2026-10-24 核对）：
 *   令牌   POST /open-apis/auth/v3/tenant_access_token/internal  {app_id, app_secret} → tenant_access_token、expire（秒）
 *   字段   GET  /open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields   → 列名和类型（认日期、人员、关联列）
 *   记录   POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search?page_size=500
 *          → items[{record_id, fields, last_modified_time(毫秒)}]、has_more、page_token
 *
 * 出来的 原始记录：外部ID = record_id，字段里补「记录ID」；关联列（单向 / 双向关联）只给 record_id、不带表名，
 * 指向哪一类看配置的 关联，没配看列名（带「商机」算商机、带「客户」算客户），落成「客户ID」「商机ID」，
 * 正好是 clean.ts 按外部ID 认父记录的那两列。人员列给名字（没名字给邮箱），日期给北京时间。
 *
 * 增量：多维表格按修改时间筛要表里有「修改时间」列，不一定有，所以拉全表、按 last_modified_time 在这边筛，
 * 没变的本来也靠指纹跳过。权限：应用要开「查看多维表格」，并被加进这几张多维表格。
 */
import type { 适配器, 现有列 } from "./adapter";
import { 接口出错, 最多重试, 退避, 对方出错, 连不上重试, 北京时间串, 读JSON, 请求, 真联网, type 联网 } from "./net";
import { 实体名, type 原始记录, type 实体, type 通讯录, type 通讯录部门, type 通讯录人 } from "./types";

export type 飞书表 = {
  实体: 实体;
  appToken: string;
  tableId: string;
  viewId?: string;
  /** 表的叫法，报问题时说「飞书 · 客户表」；不填用实体名 */
  名?: string;
  /** 关联列指向哪一类：{ "所属客户": "customer" }。不填按列名猜 */
  关联?: Record<string, 实体>;
};

export type 飞书配置 = {
  appId: string;
  appSecret: string;
  表们: 飞书表[];
  /** 国际版 Lark 换成 https://open.larksuite.com */
  基址?: string;
};

/** 字段类型（飞书 type）：只认要特殊处理的几种 */
const 日期类 = new Set([5, 1001, 1002]);
const 关联类 = new Set([18, 21]);
const 文本类 = 1;

const 令牌失效 = new Set([99991661, 99991663, 99991668]);
const 限流 = new Set([1254290, 99991400]);
const 说人话: Record<number, string> = {
  99991672: "应用没开多维表格的读取权限（开放平台 → 权限管理 → 查看、评论、编辑和管理多维表格）",
  91403: "应用没被加进这张多维表格（多维表格右上角「…」→ 添加文档应用）",
  1254302: "应用没被加进这张多维表格（多维表格右上角「…」→ 添加文档应用）",
  10003: "App ID 或 App Secret 不对",
  10014: "App Secret 不对",
};

type 飞书记录 = { record_id: string; fields?: Record<string, unknown>; last_modified_time?: number };

export class 飞书适配器 implements 适配器 {
  来源 = "feishu" as const;
  private 令牌: { 值: string; 到期: number } | null = null;
  private 列们: 现有列 = {};

  constructor(
    private 配置: 飞书配置,
    private 网: 联网 = 真联网,
  ) {}

  private get 基址() {
    return (this.配置.基址 ?? "https://open.feishu.cn").replace(/\/+$/, "");
  }

  private async 取令牌(): Promise<string> {
    if (this.令牌 && this.令牌.到期 > this.网.现在()) return this.令牌.值;
    let res: Response;
    let j: Record<string, unknown> | null;
    let code: number | undefined;
    // 拿令牌的接口也会限流（一个应用每秒有上限），和别的接口一样退避重试
    for (let 第几次 = 0; ; 第几次++) {
      res = await 请求(this.网, "飞书", `${this.基址}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: this.配置.appId, app_secret: this.配置.appSecret }),
      });
      j = await 读JSON(res, "飞书");
      code = typeof j?.code === "number" ? j.code : undefined;
      if ((res.status === 429 || (code !== undefined && 限流.has(code))) && 第几次 < 最多重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      if (对方出错(res.status) && 第几次 < 连不上重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      break;
    }
    if (!res.ok || code !== 0 || typeof j?.tenant_access_token !== "string") {
      throw new 接口出错(`飞书拿不到访问令牌（HTTP ${res.status}${code !== undefined ? `，code ${code}` : ""}）：${(code !== undefined && 说人话[code]) || String(j?.msg ?? "没有返回内容")}`, code);
    }
    // 提前 5 分钟换新的，免得拉到一半过期
    const 秒 = typeof j.expire === "number" ? j.expire : 7200;
    this.令牌 = { 值: j.tenant_access_token, 到期: this.网.现在() + Math.max(60, 秒 - 300) * 1000 };
    return this.令牌.值;
  }

  /** 调一个接口：限流退避重试，对方 5xx 再试两回，令牌失效换一次，其余报错说清是哪张表、为什么。话 = 这类接口自己的错误码说明 */
  private async 调(动作: string, 方法: "GET" | "POST", 路径: string, 参数: Record<string, string | undefined>, 体?: unknown, 话: Record<number, string> = 说人话) {
    let 换过令牌 = false;
    for (let 第几次 = 0; ; 第几次++) {
      const url = new URL(this.基址 + 路径);
      for (const [k, v] of Object.entries(参数)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
      const res = await 请求(this.网, "飞书", url.toString(), {
        method: 方法,
        headers: { Authorization: `Bearer ${await this.取令牌()}`, "Content-Type": "application/json; charset=utf-8" },
        body: 体 === undefined ? undefined : JSON.stringify(体),
      });
      const j = await 读JSON(res, "飞书");
      const code = typeof j?.code === "number" ? j.code : undefined;
      if ((res.status === 429 || (code !== undefined && 限流.has(code))) && 第几次 < 最多重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      if (对方出错(res.status) && 第几次 < 连不上重试) {
        await this.网.等(退避(第几次));
        continue;
      }
      if (code !== undefined && 令牌失效.has(code) && !换过令牌) {
        换过令牌 = true;
        this.令牌 = null;
        continue;
      }
      if (res.ok && code === 0) return (j?.data ?? {}) as Record<string, unknown>;
      throw new 接口出错(`飞书${动作}出错（HTTP ${res.status}${code !== undefined ? `，code ${code}` : ""}）：${(code !== undefined && 话[code]) || String(j?.msg ?? "没有返回内容")}`, code);
    }
  }

  private async 字段类型(表: 飞书表): Promise<Map<string, number>> {
    const 类型 = new Map<string, number>();
    let page_token: string | undefined;
    do {
      const d = await this.调(`读「${表名(表)}」的列`, "GET", `${表路径(表)}/fields`, { page_size: "100", page_token });
      for (const f of (d.items as { field_name?: string; type?: number }[] | undefined) ?? []) {
        if (f.field_name && typeof f.type === "number") 类型.set(f.field_name, f.type);
      }
      page_token = d.has_more ? String(d.page_token ?? "") || undefined : undefined;
    } while (page_token);
    return 类型;
  }

  private async 拉表(表: 飞书表, since: Date | null): Promise<原始记录[]> {
    const 类型 = await this.字段类型(表);
    const 列 = (this.列们[表.实体] ??= new Set());
    for (const k of Object.keys(飞书成记录(表, 类型, { record_id: "" }).字段)) 列.add(k);
    const 出: 原始记录[] = [];
    let page_token: string | undefined;
    do {
      const d = await this.调(
        `拉「${表名(表)}」`,
        "POST",
        `${表路径(表)}/records/search`,
        { page_size: "500", page_token },
        { ...(表.viewId ? { view_id: 表.viewId } : {}), automatic_fields: true },
      );
      for (const it of (d.items as 飞书记录[] | undefined) ?? []) {
        if (!it?.record_id) continue;
        if (since && typeof it.last_modified_time === "number" && it.last_modified_time <= since.getTime()) continue;
        出.push(飞书成记录(表, 类型, it));
      }
      page_token = d.has_more ? String(d.page_token ?? "") || undefined : undefined;
    } while (page_token);
    return 出;
  }

  async 拉全量() {
    return this.拉变化(null);
  }

  async 拉变化(since: Date | null) {
    const 出: 原始记录[] = [];
    this.列们 = {};
    for (const 表 of this.配置.表们) 出.push(...(await this.拉表(表, since)));
    return 出;
  }

  现有列() {
    return this.列们;
  }

  /**
   * 拉通讯录（组织架构同步用）：
   *   部门 GET /open-apis/contact/v3/departments/0/children?fetch_child=true → 根下所有部门（含子孙）
   *   人   GET /open-apis/contact/v3/users/find_by_department?department_id=… → 每个部门的直属成员（根「0」也拉一遍）
   * ID 一律要 open_id / open_department_id。应用要开「获取通讯录基本信息」「获取部门基础信息」等读权限，
   * 通讯录权限范围要包含这些部门（范围外的部门拉不到）。一个人在几个部门会出现几次，按 open_id 去重。
   */
  async 拉通讯录(): Promise<通讯录> {
    const 部门们: 通讯录部门[] = [];
    const 负责人 = new Set<string>();
    let page_token: string | undefined;
    do {
      const d = await this.调("拉部门", "GET", "/open-apis/contact/v3/departments/0/children", { fetch_child: "true", department_id_type: "open_department_id", user_id_type: "open_id", page_size: "50", page_token }, undefined, 通讯录话);
      for (const it of (d.items as 飞书部门[] | undefined) ?? []) {
        const id = it?.open_department_id;
        if (!id) continue;
        const 上级 = it.parent_department_id && it.parent_department_id !== "0" ? it.parent_department_id : null;
        部门们.push({ 外部ID: id, 名: String(it.name ?? "").trim() || id, 上级外部ID: 上级, 排序: Number(it.order) || 0 });
        if (it.leader_user_id) 负责人.add(it.leader_user_id);
      }
      page_token = d.has_more ? String(d.page_token ?? "") || undefined : undefined;
    } while (page_token);

    const 人们 = new Map<string, 通讯录人>();
    for (const 部门ID of ["0", ...部门们.map((x) => x.外部ID)]) {
      let pt: string | undefined;
      do {
        const d = await this.调("拉部门成员", "GET", "/open-apis/contact/v3/users/find_by_department", { department_id: 部门ID, department_id_type: "open_department_id", user_id_type: "open_id", page_size: "50", page_token: pt }, undefined, 通讯录话);
        for (const u of (d.items as 飞书人[] | undefined) ?? []) {
          if (!u?.open_id || 人们.has(u.open_id)) continue;
          const 邮箱 = (u.enterprise_email || u.email || "").trim();
          人们.set(u.open_id, {
            外部ID: u.open_id,
            名: String(u.name ?? "").trim() || u.open_id,
            ...(邮箱 ? { 邮箱 } : {}),
            ...(u.job_title?.trim() ? { 职务: u.job_title.trim() } : {}),
            部门外部IDs: (u.department_ids ?? []).filter((x) => typeof x === "string" && x && x !== "0"),
            ...(u.leader_user_id ? { 上级外部ID: u.leader_user_id } : {}),
            是负责人: 负责人.has(u.open_id),
            离职: u.status?.is_resigned === true,
          });
        }
        pt = d.has_more ? String(d.page_token ?? "") || undefined : undefined;
      } while (pt);
    }
    return { 部门们, 人们: [...人们.values()] };
  }

  /* ── 测试连接用：每步只拉一点，失败的错误码带在 接口出错.code 上 ── */

  /** 拿一次令牌：App ID / Secret 对不对 */
  async 试令牌(): Promise<void> {
    await this.取令牌();
  }

  /** 拉一个部门：通讯录权限开没开、发没发版 */
  async 试通讯录(): Promise<void> {
    await this.调("读通讯录", "GET", "/open-apis/contact/v3/departments/0/children", { department_id_type: "open_department_id", page_size: "1" }, undefined, 通讯录话);
  }

  /** 一个多维表格里的所有数据表：GET /open-apis/bitable/v1/apps/:app_token/tables */
  async 列多维表(appToken: string): Promise<{ tableId: string; 名: string }[]> {
    const 表们: { tableId: string; 名: string }[] = [];
    let page_token: string | undefined;
    do {
      const d = await this.调("列数据表", "GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { page_size: "100", page_token });
      for (const t of (d.items as { table_id?: string; name?: string }[] | undefined) ?? []) {
        if (t?.table_id) 表们.push({ tableId: t.table_id, 名: String(t.name ?? "").trim() || t.table_id });
      }
      page_token = d.has_more ? String(d.page_token ?? "") || undefined : undefined;
    } while (page_token);
    return 表们;
  }
}

type 飞书部门 = { open_department_id?: string; name?: string; parent_department_id?: string; order?: string | number; leader_user_id?: string };
type 飞书人 = { open_id?: string; name?: string; email?: string; enterprise_email?: string; job_title?: string; leader_user_id?: string; department_ids?: string[]; status?: { is_resigned?: boolean } };

const 通讯录话: Record<number, string> = {
  ...说人话,
  99991672: "应用没开通讯录读取权限（开放平台 → 权限管理 → 获取通讯录基本信息、获取部门基础信息、获取用户邮箱、获取用户直属上级）",
  40004: "通讯录权限范围不含这个部门（开放平台 → 权限管理 → 通讯录权限范围，选全部成员）",
  41050: "通讯录权限范围不含这个人（开放平台 → 权限管理 → 通讯录权限范围，选全部成员）",
};

const 表名 = (表: 飞书表) => 表.名 ?? `${实体名[表.实体]}表`;
/** appToken / tableId 是客户填的，编码了再拼，带了 / ? # 也不会拼到别的接口上 */
const 表路径 = (表: 飞书表) => `/open-apis/bitable/v1/apps/${encodeURIComponent(表.appToken)}/tables/${encodeURIComponent(表.tableId)}`;

/** 子记录才挂父：联系人 / 商机 / 跟进挂客户，跟进还挂商机（客户表里的「上级客户」之类不当父） */
function 父列(子: 实体, 父: 实体): "客户ID" | "商机ID" | null {
  if (父 === "customer" && (子 === "contact" || 子 === "opportunity" || 子 === "followup")) return "客户ID";
  if (父 === "opportunity" && 子 === "followup") return "商机ID";
  return null;
}

function 猜指向(列名: string): 实体 | null {
  if (列名.includes("商机")) return "opportunity";
  if (列名.includes("客户") || 列名.includes("公司")) return "customer";
  return null;
}

/** 关联列的值：新接口 {link_record_ids:[…]}，老接口 [{record_ids:[…], text}] */
function 关联ID(v: unknown): string[] {
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { link_record_ids?: unknown }).link_record_ids)) {
    return ((v as { link_record_ids: unknown[] }).link_record_ids).filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(v)) {
    return v.flatMap((x) => (x && typeof x === "object" && Array.isArray((x as { record_ids?: unknown }).record_ids) ? (x as { record_ids: unknown[] }).record_ids : [])).filter((x): x is string => typeof x === "string");
  }
  return [];
}

function 像关联(v: unknown): boolean {
  if (v && typeof v === "object" && !Array.isArray(v) && "link_record_ids" in v) return true;
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && "record_ids" in x);
}

/** 飞书一格的值 → 字符串（文本段拼起来、人员给名字、日期给北京时间、多选用顿号连） */
export function 飞书值(v: unknown, 类型?: number): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return 类型 !== undefined && 日期类.has(类型) ? 北京时间串(v) : String(v);
  if (typeof v === "boolean") return v ? "是" : "否";
  if (Array.isArray(v)) {
    const 段 = v.map((x) => 飞书值(x, 类型)).filter(Boolean);
    // 文本列是一串富文本段（文字、@人、链接），直接拼；其余（多选、人员、附件）用顿号
    const 是文本段 = 类型 === 文本类 || v.every((x) => x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string" && "text" in x);
    return 是文本段 ? 段.join("").trim() : 段.join("、");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // 公式、查找引用：{type, value:[…]}，按里面的类型再拆
    if (Array.isArray(o.value)) return 飞书值(o.value, typeof o.type === "number" ? o.type : undefined);
    // 地理位置也有 name（地点名），整段地址更有用
    if (typeof o.full_address === "string" && o.full_address) return o.full_address;
    if (typeof o.text === "string" && o.text) return o.text.trim();
    if (typeof o.name === "string" && o.name) return o.name.trim();
    if (typeof o.email === "string" && o.email) return o.email.trim();
    if (typeof o.link === "string") return o.link;
    if (typeof o.en_name === "string") return o.en_name;
  }
  return "";
}

export function 飞书成记录(表: 飞书表, 类型: Map<string, number>, it: 飞书记录): 原始记录 {
  const 字段: Record<string, string> = { 记录ID: it.record_id };
  const 值们 = it.fields ?? {};
  // 飞书不返回空格子：按列表把每列都补上（空的给 ""），和 Excel 一样每条都有全部列，清空的也认得出
  const 列们 = new Set([...类型.keys(), ...Object.keys(值们)]);
  for (const 列 of 列们) {
    const t = 类型.get(列);
    const v = 值们[列];
    if ((t !== undefined && 关联类.has(t)) || 像关联(v)) {
      const 指向 = 表.关联?.[列] ?? 猜指向(列);
      const 放 = 指向 ? 父列(表.实体, 指向) : null;
      if (放 && !字段[放]) 字段[放] = 关联ID(v)[0] ?? "";
      continue;
    }
    字段[列] = 飞书值(v, t);
  }
  return { 实体: 表.实体, 外部ID: it.record_id, 字段, 出处: `飞书 · ${表名(表)}` };
}
