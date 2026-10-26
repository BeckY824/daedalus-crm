/**
 * 清洗：原始记录 + 映射 → 待写的记录 + 问题清单。试跑和正式导入、之后的同步都走这一个函数，结果一模一样。
 *
 * 这里不碰库：我们这边已有的东西（对照表、客户名、电话、商机名）由调用方查好装进 本地索引 传进来。
 *
 * 清洗做的事：
 *   - 按列映射把原列落到标准字段；映射成「进备注」的列拼成「表头：值」进备注（跟进进内容），一格不丢
 *   - 负责人、阶段、线索状态、跟进方式、跟进状态按映射换成我们的值；对不上的用默认值 + 记一笔「提醒」
 *   - 电话、日期、金额、赢率按我们的格式认；认不出的原样进备注 + 提醒，不硬塞
 *   - 同一批里同号、外部 ID 不同 → 认作同一家，后一条并进前一条（名字不同另提醒）；名字很像但号不同 → 疑似重名，照写、提醒
 *   - 联系人 / 商机 / 跟进挂客户：先认所属客户 ID，再认客户名（本批里唯一、或我们这边唯一）；认不出整条跳过
 *   - 客户：对照表里有 → 落到那条；没导过但我们这边有同号客户 → 连上它（只补空格子）；否则新建
 */
import { createHash } from "node:crypto";
import { FOLLOW_TYPES, OPP_STAGES, STAGE_PROBABILITY } from "../constants";
import { 认日期 } from "../import/plan";
import { 查电话, 号键 } from "../phone";
import { 拆多人, 进备注, 输单 } from "./mapping";
import { 实体顺序, 必填, 实体名, 字段中文, type 原始记录, type 实体, type 映射, type 问题, type 待写 } from "./types";

/** 我们这边已有的东西，调用方从库里查好传进来。键都已规整过（见下面的 名键 / 号键） */
export type 本地索引 = {
  /** `${实体}|${外部ID}` → 我们这边的 id（以前导过的） */
  引用: Map<string, string>;
  /** `${实体}|${外部ID}` → 上次导入时的指纹（没给就都当有变化） */
  指纹?: Map<string, string>;
  /** 客户名键 → 客户 id（可能多个） */
  客户名: Map<string, string[]>;
  /** 号键 → 客户 id（可能多个） */
  客户号: Map<string, string[]>;
  /** `${客户id}|${商机名键}` → 商机 id（可能多个） */
  商机名: Map<string, string[]>;
};

export const 空索引 = (): 本地索引 => ({ 引用: new Map(), 客户名: new Map(), 客户号: new Map(), 商机名: new Map() });

/** 名字比较用的键：去空白、全角转半角、小写 */
export function 名键(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

/** 疑似重名用的公司名键：再去掉括号、标点和「有限公司」这类尾巴。只用来提醒，不拿来合并 */
export function 公司名键(s: string): string {
  return 名键(s)
    .replace(/[(\[【][^)\]】]*[)\]】]/g, "")
    .replace(/[.,·、，。\-_'"“”‘’]/g, "")
    .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|公司|co\.?ltd|ltd|inc|llc|corp)$/i, "");
}

export type 清洗结果 = { 待写: 待写[]; 问题: 问题[] };

type 标准 = { 值: Record<string, string>; 附加: string[] };

/** 一条原始记录按列映射拆成：标准字段的值（同一字段多列时取第一格有值的）+ 要拼进备注的「表头：值」 */
function 拆(r: 原始记录, 列: Record<string, string>): 标准 {
  const 值: Record<string, string> = {};
  const 附加: string[] = [];
  for (const [h, raw] of Object.entries(r.字段)) {
    const v = (raw ?? "").trim();
    const std = 列[h];
    if (!v || !std) continue;
    if (std === 进备注) 附加.push(`${h}：${v}`);
    else if (!值[std]) 值[std] = v;
  }
  return { 值, 附加 };
}

function 指纹(x: unknown): string {
  return createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 20);
}

function 拼备注(...段: (string | undefined | null)[]): string | null {
  const s = 段.filter((x) => x && x.trim()).join("\n");
  return s || null;
}

/** 是 / 否：关键联系人这种格子 */
function 认是否(v: string): boolean {
  return /^(是|y|yes|true|1|√|✓|主|主要|关键)$/i.test(v.trim());
}

/** 金额：去掉货币符号、千分位、「元」，「万」乘一万。认不出返回 null */
export function 认金额(v: string): number | null {
  let s = v.trim().replace(/[,，\s]/g, "").replace(/^(¥|￥|\$|US\$|RMB|CNY|USD)/i, "").replace(/(元|人民币|rmb|cny|usd)$/i, "");
  let 倍 = 1;
  if (/万$/.test(s)) {
    倍 = 10000;
    s = s.slice(0, -1);
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * 倍;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** 赢率：「60%」「60」「0.6」都认成 60。认不出返回 null */
export function 认赢率(v: string): number | null {
  const s = v.trim().replace(/[%％]$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  let n = Number(s);
  if (n > 0 && n < 1 && s.includes(".")) n *= 100;
  return n >= 0 && n <= 100 ? Math.round(n) : null;
}

/**
 * 跟进时间要带时分（同一天几次跟进得排得出先后）。日期部分走大批导入的 认日期（同一套写法），
 * 再认后面的「14:30」「14:30:05」或 Excel 序列号的小数部分。认不出返回 null
 */
export function 认时间(v: string): Date | null {
  const d = 认日期(v);
  if (!d) return null;
  const s = v.trim();
  if (/^\d{4,6}\.\d+$/.test(s)) {
    const 秒 = Math.round((Number(s) % 1) * 86400);
    d.setHours(Math.floor(秒 / 3600), Math.floor((秒 % 3600) / 60), 秒 % 60, 0);
    return d;
  }
  const t = /[\sT日](\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/.exec(s);
  if (t) {
    const [h, m, sec] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
    if (h < 24 && m < 60 && sec < 60) d.setHours(h, m, sec, 0);
  }
  return d;
}

/** 商机状态列：赢 / 输 / 进行中 */
function 认商机状态(v: string): "WON" | "LOST" | "OPEN" {
  if (/赢|成交|签约|won/i.test(v) && !/未成交/.test(v)) return "WON";
  if (/输|丢|失败|未成交|lost|关闭|closed/i.test(v)) return "LOST";
  return "OPEN";
}

/** 跟进记录的状态：大多是已完成；「待办 / 未完成」算待处理 */
function 认跟进记录状态(v: string): string {
  if (/待|未完成|计划|todo|pending/i.test(v)) return "待处理";
  if (/已发送|sent/i.test(v)) return "已发送";
  return "已完成";
}

/** 客户等级只存 A–D 一个大写字母（迁移 037）：「A类」「a级」认成 A，别的认不出 */
function 认等级(v: string): string | null {
  const m = /^([a-dA-D])(类|级|档|$)/.exec(v.trim());
  return m ? m[1].toUpperCase() : null;
}

/** 客户的外贸几格：落 CustomerExtra，写的时候从 值 里分出来 */
export const 客户附加列 = ["email", "wechat", "whatsapp", "country", "source", "level", "website"] as const;

export function 清洗(记录: readonly 原始记录[], m: 映射, 本地: 本地索引 = 空索引()): 清洗结果 {
  const 问题们: 问题[] = [];
  const 出问题 = (r: 原始记录, 级别: 问题["级别"], 类别: 问题["类别"], 说明: string) =>
    问题们.push({ 级别, 类别, 实体: r.实体, 外部ID: r.外部ID, 行号: r.行号, 出处: r.出处, 说明 });

  const 按类: Record<实体, 原始记录[]> = { customer: [], contact: [], lead: [], opportunity: [], followup: [] };
  for (const r of 记录) 按类[r.实体]?.push(r);

  const 待写们: 待写[] = [];
  /** 本批里写下来的客户 / 商机：外部 ID → 待写；客户名键 → 外部 ID 们 */
  const 批客户 = new Map<string, 待写>();
  const 批客户名 = new Map<string, string[]>();
  const 批商机 = new Map<string, 待写>();

  const 负责人 = (r: 原始记录, 写法: string | undefined): string => {
    if (!写法) {
      出问题(r, "提醒", "负责人空着", "原系统没写负责人，先落到默认负责人名下");
      return m.默认负责人Id;
    }
    const id = m.负责人[写法];
    const 几个 = 拆多人(写法);
    if (id && 几个.length) 出问题(r, "提醒", "负责人有几个", `负责人写了 ${几个.length} 个人（${写法}），我们一条只有一个负责人，按映射落到其中一个名下，其余的人请导完再看要不要协作`);
    if (id) return id;
    出问题(r, "提醒", "负责人对不上", `负责人「${写法}」对不上我们这边的成员，先落到默认负责人名下`);
    return m.默认负责人Id;
  };

  const 认电话 = (r: 原始记录, v: string | undefined, 附加: string[]): string => {
    if (!v) return "";
    const p = 查电话(v, { 必填: false });
    if (p.ok) return p.phone;
    附加.unshift(`电话：${v}`);
    出问题(r, "提醒", "格式不对", `电话「${v}」看不出是个号码，原样放进了备注`);
    return "";
  };

  const 对值 = (r: 原始记录, 名: keyof 映射["值"], v: string | undefined, 默认: string, 叫法: string): string => {
    if (!v) return 默认;
    const hit = m.值[名][v];
    if (hit) return hit;
    出问题(r, "提醒", 名 === "阶段" ? "阶段对不上" : "值对不上", `${叫法}「${v}」对不上，先按「${默认}」写`);
    return 默认;
  };

  const 缺必填 = (r: 原始记录, s: 标准): boolean => {
    const 缺 = 必填[r.实体].filter((f) => !s.值[f]);
    if (!缺.length) return false;
    出问题(r, "跳过", "缺必填", `没有${缺.map((f) => 字段中文[f] ?? f).join("、")}，这一条不导`);
    return true;
  };

  /** 挂客户：所属客户 ID → 本批 / 以前导过的；再按客户名 → 本批唯一 / 我们这边唯一 */
  const 找客户 = (r: 原始记录, s: 标准): 待写["父客户"] | null => {
    const ref = s.值.customerRef;
    if (ref) {
      const 批 = 批客户.get(ref);
      if (批) return { 外部ID: 批.并入 ?? 批.外部ID };
      const 本 = 本地.引用.get(`customer|${ref}`);
      if (本) return { 本地ID: 本 };
    }
    const 名 = s.值.customerName;
    if (名) {
      const 批 = 批客户名.get(名键(名)) ?? [];
      if (批.length === 1) return { 外部ID: 批[0] };
      if (批.length > 1) {
        出问题(r, "跳过", "客户不唯一", `这批数据里叫「${名}」的客户有 ${批.length} 个，分不出挂哪个；请补「所属客户 ID」列`);
        return null;
      }
      const 本 = 本地.客户名.get(名键(名)) ?? [];
      if (本.length === 1) return { 本地ID: 本[0] };
      if (本.length > 1) {
        出问题(r, "跳过", "客户不唯一", `我们这边叫「${名}」的客户有 ${本.length} 个，分不出挂哪个`);
        return null;
      }
    }
    出问题(r, "跳过", "找不到客户", ref || 名 ? `找不到所属客户「${名 || ref}」，这一条不导` : "没有所属客户，这一条不导");
    return null;
  };

  const 收 = (r: 原始记录, 值: 待写["值"], 附: Partial<待写> = {}): 待写 => {
    const w: 待写 = { 实体: r.实体, 外部ID: r.外部ID, 值, 指纹: "", 原始: r.字段, 行号: r.行号, 出处: r.出处, ...附 };
    w.指纹 = 指纹([w.值, w.父客户 ?? null, w.父商机 ?? null, w.并入 ?? null]);
    if (w.目标?.方式 === "对照" && 本地.指纹?.get(`${w.实体}|${w.外部ID}`) === w.指纹) w.没变 = true;
    待写们.push(w);
    return w;
  };

  for (const e of 实体顺序) {
    const 列 = m.列[e] ?? {};
    const 见过ID = new Map<string, 原始记录>();
    /** 客户本批去重：号键 → 第一条；公司名键 → 第一条 */
    const 同号 = new Map<string, 待写>();
    const 像名 = new Map<string, 原始记录>();

    for (const r of 按类[e]) {
      const 先前 = 见过ID.get(r.外部ID);
      if (先前) {
        出问题(r, "跳过", "ID 重复", `原系统 ID「${r.外部ID}」和${先前.行号 ? `第 ${先前.行号} 行` : "前面一条"}重复，只导前一条`);
        continue;
      }
      见过ID.set(r.外部ID, r);
      const s = 拆(r, 列);
      if (缺必填(r, s)) continue;
      const 附加 = [...s.附加];
      const 对照 = 本地.引用.get(`${e}|${r.外部ID}`);
      const 目标: 待写["目标"] = 对照 ? { 本地ID: 对照, 方式: "对照" } : undefined;

      if (e === "customer") {
        const phone = 认电话(r, s.值.phone, 附加);
        const level = s.值.level ? 认等级(s.值.level) : null;
        if (s.值.level && !level) 附加.push(`客户等级：${s.值.level}`);
        const 值: 待写["值"] = {
          name: s.值.name,
          phone,
          salesOwnerId: 负责人(r, s.值.owner),
          followStatus: 对值(r, "跟进状态", s.值.followStatus, "待跟进", "跟进状态"),
          remark: 拼备注(s.值.remark, ...附加),
          email: s.值.email ?? null,
          wechat: s.值.wechat ?? null,
          whatsapp: s.值.whatsapp ?? null,
          country: s.值.country ?? null,
          source: s.值.source ?? null,
          level,
          website: s.值.website ?? null,
        };
        // 同号：并进前一条（外部 ID 不同，原系统里重复建了）。和我们这边「一个号一位客户」的查重一个口径，名字不同也并，提醒人看
        const 键 = phone ? 号键(phone) : "";
        const 前 = 键 ? 同号.get(键) : undefined;
        if (前) {
          const 哪条 = 前.行号 ? `第 ${前.行号} 行` : `「${前.外部ID}」`;
          出问题(
            r,
            "提醒",
            "重名",
            名键(String(前.值.name)) === 名键(s.值.name)
              ? `和${哪条}同名同号，认作同一家，合成一条`
              : `和${哪条}「${前.值.name}」同号、名字不同，按同一家合成一条，请人看一眼`,
          );
          const w = 收(r, 值, { 并入: 前.外部ID, 目标 });
          批客户.set(r.外部ID, w);
          continue;
        }
        // 没导过、我们这边有同号客户：连上它
        let 落 = 目标;
        if (!落 && phone) {
          const 本地同号 = 本地.客户号.get(号键(phone)) ?? [];
          if (本地同号.length === 1) {
            落 = { 本地ID: 本地同号[0], 方式: "同号" };
            出问题(r, "提醒", "重名", `我们这边已有同号客户，连上它，只补空着的格子`);
          } else if (本地同号.length > 1) 出问题(r, "提醒", "疑似重名", `我们这边有 ${本地同号.length} 个客户是这个号，照新建，请人工合并`);
        }
        if (!落) {
          const k = 公司名键(s.值.name);
          const 像 = k ? 像名.get(k) : undefined;
          if (像) 出问题(r, "提醒", "疑似重名", `和${像.行号 ? `第 ${像.行号} 行` : "前面一条"}名字很像、电话不同，照写两条，请人看一眼`);
          else if (k) 像名.set(k, r);
          if (!像 && (本地.客户名.get(名键(s.值.name)) ?? []).length) 出问题(r, "提醒", "疑似重名", `我们这边已经有叫「${s.值.name}」的客户，照新建，请人看一眼`);
        }
        const w = 收(r, 值, { 目标: 落 });
        if (键) 同号.set(键, w);
        批客户.set(r.外部ID, w);
        const nk = 名键(s.值.name);
        批客户名.set(nk, [...(批客户名.get(nk) ?? []), r.外部ID]);
        continue;
      }

      if (e === "lead") {
        const phone = 认电话(r, s.值.phone, 附加);
        收(
          r,
          {
            name: s.值.name,
            contact: s.值.contact ?? null,
            phone: phone || null,
            email: s.值.email ?? null,
            industry: s.值.industry ?? null,
            source: s.值.source ?? "其他",
            status: 对值(r, "线索状态", s.值.status, "待跟进", "线索状态"),
            ownerId: 负责人(r, s.值.owner),
            remark: 拼备注(s.值.remark, ...附加),
          },
          { 目标 },
        );
        continue;
      }

      // 下面三类都要挂客户
      const 父客户 = 找客户(r, s);
      if (!父客户) continue;

      if (e === "contact") {
        const phone = 认电话(r, s.值.phone, 附加);
        收(
          r,
          {
            name: s.值.name,
            position: s.值.position ?? null,
            phone: phone || null,
            email: s.值.email ?? null,
            wechat: s.值.wechat ?? null,
            isPrimary: s.值.isPrimary ? 认是否(s.值.isPrimary) : false,
            remark: 拼备注(s.值.remark, ...附加),
          },
          { 父客户, 目标 },
        );
        continue;
      }

      if (e === "opportunity") {
        const 阶段 = 对值(r, "阶段", s.值.stage, OPP_STAGES[0], "商机阶段");
        let status: "WON" | "LOST" | "OPEN" = s.值.status ? 认商机状态(s.值.status) : "OPEN";
        let stage = 阶段;
        if (阶段 === 输单) {
          status = "LOST";
          stage = OPP_STAGES[0];
        } else if (阶段 === "赢单成交" && status === "OPEN") status = "WON";
        if (status === "WON") stage = "赢单成交";
        let amount = 0;
        if (s.值.amount) {
          const a = 认金额(s.值.amount);
          if (a === null) {
            附加.push(`金额：${s.值.amount}`);
            出问题(r, "提醒", "格式不对", `金额「${s.值.amount}」认不出，先记 0，原样放进了备注`);
          } else amount = a;
        }
        let probability = status === "WON" ? 100 : status === "LOST" ? 0 : (STAGE_PROBABILITY[stage] ?? 10);
        if (s.值.probability && status === "OPEN") {
          const p = 认赢率(s.值.probability);
          if (p === null) 出问题(r, "提醒", "格式不对", `赢率「${s.值.probability}」认不出，按阶段给 ${probability}%`);
          else probability = p;
        }
        let expectedDealAt: string | null = null;
        if (s.值.expectedDealAt) {
          const d = 认日期(s.值.expectedDealAt);
          if (d) expectedDealAt = d.toISOString();
          else {
            附加.push(`预计成交：${s.值.expectedDealAt}`);
            出问题(r, "提醒", "格式不对", `预计成交日期「${s.值.expectedDealAt}」认不出，原样放进了备注`);
          }
        }
        // 赢单 / 输单要有个历史日期，不然看板会把它算成本月的成交
        let closedAt: string | null = null;
        if (status !== "OPEN") {
          const d = s.值.closedAt ? 认日期(s.值.closedAt) : null;
          if (d) closedAt = d.toISOString();
          else if (s.值.closedAt) {
            附加.push(`结单日期：${s.值.closedAt}`);
            出问题(r, "提醒", "格式不对", `结单日期「${s.值.closedAt}」认不出，原样放进了备注`);
          }
          if (!closedAt) {
            closedAt = expectedDealAt;
            出问题(
              r,
              "提醒",
              "缺日期",
              expectedDealAt
                ? `${status === "WON" ? "赢单" : "输单"}没有结单日期，按预计成交日期记`
                : `${status === "WON" ? "赢单" : "输单"}没有结单日期，会按导入当天算进看板`,
            );
          }
        }
        const w = 收(
          r,
          {
            name: s.值.name,
            amount,
            stage,
            status,
            probability,
            expectedDealAt,
            closedAt,
            ownerId: 负责人(r, s.值.owner),
            remark: 拼备注(s.值.remark, ...附加),
          },
          { 父客户, 目标 },
        );
        批商机.set(r.外部ID, w);
        continue;
      }

      // followup
      let content = s.值.content ?? "";
      const 类型 = 对值(r, "跟进类型", s.值.type, "OTHER", "跟进方式");
      const 类型名 = FOLLOW_TYPES.find((t) => t.value === 类型)?.label ?? "跟进";
      if (!content && !s.值.title) {
        出问题(r, "跳过", "缺必填", "没有跟进内容，这一条不导");
        continue;
      }
      // 标题只从原内容取前 20 字，别把拼进去的「表头：值」带进标题
      const title = s.值.title || content.replace(/\s+/g, " ").trim().slice(0, 20) || 类型名;
      if (!content) content = s.值.title!;
      if (附加.length) content = 拼备注(content, ...附加) ?? "";
      let occurredAt: string | null = null;
      if (s.值.occurredAt) {
        const d = 认时间(s.值.occurredAt);
        if (d) occurredAt = d.toISOString();
        else 出问题(r, "提醒", "格式不对", `跟进时间「${s.值.occurredAt}」认不出，按导入时间记`);
      } else 出问题(r, "提醒", "格式不对", "没有跟进时间，按导入时间记");
      // 挂商机：所属商机 ID → 本批 / 以前导过的；商机名 → 同一客户下唯一的
      let 父商机: 待写["父商机"];
      const oref = s.值.opportunityRef;
      const oname = s.值.opportunityName;
      if (oref) {
        if (批商机.has(oref)) 父商机 = { 外部ID: oref };
        else if (本地.引用.has(`opportunity|${oref}`)) 父商机 = { 本地ID: 本地.引用.get(`opportunity|${oref}`)! };
      }
      if (!父商机 && oname) {
        const 同客户 = [...批商机.values()].filter((o) => 同一客户(o.父客户, 父客户) && 名键(String(o.值.name)) === 名键(oname));
        if (同客户.length === 1) 父商机 = { 外部ID: 同客户[0].外部ID };
        else if ("本地ID" in 父客户) {
          const 本 = 本地.商机名.get(`${父客户.本地ID}|${名键(oname)}`) ?? [];
          if (本.length === 1) 父商机 = { 本地ID: 本[0] };
        }
      }
      if (!父商机 && (oref || oname)) 出问题(r, "提醒", "找不到商机", `找不到所属商机「${oname || oref}」，跟进照导，只挂在客户下面`);
      收(
        r,
        {
          type: 类型,
          title,
          content,
          status: s.值.status ? 认跟进记录状态(s.值.status) : "已完成",
          occurredAt,
          ownerId: 负责人(r, s.值.owner),
        },
        { 父客户, 父商机, 目标 },
      );
    }
  }
  return { 待写: 待写们, 问题: 问题们 };
}

function 同一客户(a: 待写["父客户"], b: 待写["父客户"]): boolean {
  if (!a || !b) return false;
  if ("外部ID" in a && "外部ID" in b) return a.外部ID === b.外部ID;
  if ("本地ID" in a && "本地ID" in b) return a.本地ID === b.本地ID;
  return false;
}

/** 报告里按类数一数 */
export function 数一数(结果: 清洗结果): Record<实体, { 待写: number; 新建: number; 更新: number; 没变: number; 并入: number; 跳过: number; 提醒: number }> {
  const out = Object.fromEntries(实体顺序.map((e) => [e, { 待写: 0, 新建: 0, 更新: 0, 没变: 0, 并入: 0, 跳过: 0, 提醒: 0 }])) as ReturnType<typeof 数一数>;
  for (const w of 结果.待写) {
    const c = out[w.实体];
    c.待写++;
    if (w.并入) c.并入++;
    else if (w.没变) c.没变++;
    else if (w.目标) c.更新++;
    else c.新建++;
  }
  for (const p of 结果.问题) out[p.实体][p.级别 === "跳过" ? "跳过" : "提醒"]++;
  return out;
}

export { 实体名 };
