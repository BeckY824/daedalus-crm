/**
 * 企业版数据接入（2026-10-24）：把原系统（飞书 / 钉钉 / 它们导出的 Excel）的数据搬进来。
 *
 * 一条路走到底，不分来源：
 *   适配器拉原始记录 → 猜映射（规则 + AI）→ 清洗 → 试跑报告 → 人确认 → 正式写入
 *   → 之后增量同步走同一套映射和清洗 → 切换日关掉同步、留快照。
 * Excel 是兜底，也是第一版先走通的那条；飞书 / 钉钉接口做成适配器，拿到权限再接。
 *
 * 这一层只放类型和字段表，不碰库。
 */

export type 来源 = "excel" | "feishu" | "dingtalk";
export const 来源们: 来源[] = ["excel", "feishu", "dingtalk"];
export const 来源名: Record<来源, string> = { excel: "Excel 导出", feishu: "飞书", dingtalk: "钉钉" };

export type 实体 = "customer" | "contact" | "lead" | "opportunity" | "followup";
/** 写入顺序：父先子后（联系人、商机、跟进要挂在客户下面，跟进还可能挂商机）。撤回反过来 */
export const 实体顺序: 实体[] = ["customer", "lead", "contact", "opportunity", "followup"];
export const 实体名: Record<实体, string> = {
  customer: "客户",
  contact: "联系人",
  lead: "线索",
  opportunity: "商机",
  followup: "跟进记录",
};

/** 原系统给的一条。字段名是原系统的列名 / 接口字段名，值一律当字符串 */
export type 原始记录 = {
  实体: 实体;
  /** 原系统里的 ID；Excel 没有 ID 列时由 excel.ts 按关键字段算一个稳定的 */
  外部ID: string;
  字段: Record<string, string>;
  /** Excel 里的行号（从 1 数），报问题时说得出是哪一行 */
  行号?: number;
  /** 哪个文件 / 哪张表来的，报问题用 */
  出处?: string;
};

/**
 * 原系统的通讯录（组织架构同步用，src/lib/enterprise/org-sync.ts）：部门和人，ID 都是原系统的。
 * 部门的上级外部ID 为 null = 挂在根上（飞书的「0」、钉钉的「1」本身不算一个部门）。
 */
export type 通讯录部门 = { 外部ID: string; 名: string; 上级外部ID: string | null; 排序: number };
export type 通讯录人 = {
  外部ID: string;
  名: string;
  邮箱?: string;
  职务?: string;
  /** 第一个当主部门；空 = 挂在根上 */
  部门外部IDs: string[];
  /** 直属上级（原系统里设了的才有） */
  上级外部ID?: string;
  /** 是哪个部门的负责人 */
  是负责人?: boolean;
  离职?: boolean;
};
export type 通讯录 = { 部门们: 通讯录部门[]; 人们: 通讯录人[] };

/**
 * 我们这边的标准字段。`ref` 结尾的是「挂到谁下面」：
 * customerRef / customerName 认客户，opportunityRef / opportunityName 认商机（跟进用）
 */
export const 标准字段 = {
  customer: ["id", "name", "phone", "owner", "followStatus", "remark", "email", "wechat", "whatsapp", "country", "source", "level", "website"],
  contact: ["id", "customerRef", "customerName", "name", "position", "phone", "email", "wechat", "isPrimary", "remark"],
  lead: ["id", "name", "contact", "phone", "email", "industry", "source", "status", "owner", "remark"],
  opportunity: ["id", "customerRef", "customerName", "name", "amount", "stage", "status", "probability", "expectedDealAt", "closedAt", "owner", "remark"],
  followup: ["id", "customerRef", "customerName", "opportunityRef", "opportunityName", "type", "title", "content", "occurredAt", "owner", "status"],
} as const satisfies Record<实体, readonly string[]>;
export type 标准字段名<E extends 实体 = 实体> = (typeof 标准字段)[E][number];

export const 字段中文: Record<string, string> = {
  id: "原系统 ID",
  name: "名称",
  phone: "电话",
  owner: "负责人",
  followStatus: "跟进状态",
  remark: "备注",
  email: "邮箱",
  wechat: "微信",
  whatsapp: "WhatsApp",
  country: "国家 / 地区",
  source: "来源",
  level: "客户等级",
  website: "网站",
  customerRef: "所属客户 ID",
  customerName: "所属客户名称",
  position: "职位 / 关系",
  isPrimary: "关键联系人",
  contact: "联系人",
  industry: "行业",
  status: "状态",
  amount: "金额",
  stage: "阶段",
  probability: "赢率",
  expectedDealAt: "预计成交",
  closedAt: "成交 / 输单日期",
  opportunityRef: "所属商机 ID",
  opportunityName: "所属商机名称",
  type: "跟进方式",
  title: "标题",
  content: "内容",
  occurredAt: "跟进时间",
};

/** 每类必填的标准字段：缺了这一格整条跳过（跟进的标题 / 内容缺一个能拿另一个补，不在这里） */
export const 必填: Record<实体, string[]> = {
  customer: ["name"],
  contact: ["name"],
  lead: ["name"],
  opportunity: ["name"],
  followup: [],
};

/** 列映射：原列名 → 标准字段（"" = 不用这一列） */
export type 列映射 = Record<string, string>;

/**
 * 一整套映射。试跑时猜出来，人可以改，正式导入和之后的同步都照这一份走（存在批次 / 设置里）
 */
export type 映射 = {
  列: Partial<Record<实体, 列映射>>;
  /** 原系统的负责人写法（名字或邮箱）→ 我们的成员 id；"" = 用默认负责人 */
  负责人: Record<string, string>;
  /** 原系统的值 → 我们的值。阶段：原阶段 → 我们五个阶段之一，或 "输单" */
  值: {
    阶段: Record<string, string>;
    线索状态: Record<string, string>;
    跟进类型: Record<string, string>;
    跟进状态: Record<string, string>;
  };
  /** 对不上的负责人落到谁名下 */
  默认负责人Id: string;
  /** 每个字段 / 每个值是谁定的：规则 / AI / 手动。只给报告看 */
  说明?: Record<string, "规则" | "AI" | "手动">;
};

export type 值对照名 = keyof 映射["值"];

/** 清洗时发现的问题。跳过 = 这一条不写；提醒 = 照写，但要人看一眼 */
export type 问题 = {
  级别: "跳过" | "提醒";
  类别: "缺必填" | "重名" | "疑似重名" | "负责人对不上" | "负责人空着" | "负责人有几个" | "阶段对不上" | "值对不上" | "找不到客户" | "客户不唯一" | "找不到商机" | "格式不对" | "缺日期" | "ID 重复";
  实体: 实体;
  外部ID: string;
  行号?: number;
  出处?: string;
  说明: string;
};

/** 清洗后、待写的一条。值里的键是落库的列名（customer 的外贸几格也在里面，写的时候分开） */
export type 待写 = {
  实体: 实体;
  外部ID: string;
  值: Record<string, string | number | boolean | null>;
  /** 挂到哪个客户：本批里的外部 ID，或我们这边已有的客户 id */
  父客户?: { 外部ID: string } | { 本地ID: string };
  父商机?: { 外部ID: string } | { 本地ID: string };
  /**
   * 同一批里认出是同一家（同号、外部 ID 不同）：并到这个外部 ID 那条上，自己不另建。
   * 写入时只记一条对照（这个外部 ID 也指向同一条记录），子记录挂它也能挂上
   */
  并入?: string;
  /**
   * 落到我们这边哪条已有记录上：对照 = 以前导过、对照表里有（之后走三方合并）；
   * 同号 = 我们这边早就有这个号的客户、没导过（连上它，只补空着的格子）。没有 = 新建
   */
  目标?: { 本地ID: string; 方式: "对照" | "同号" };
  /** 导过、这次指纹和上次一样：写的时候直接跳过，报告里算「没变」不算「更新」 */
  没变?: true;
  /** 清洗后整条的指纹：同步时没变就跳过 */
  指纹: string;
  /** 原系统给的原始字段（留档） */
  原始: Record<string, string>;
  行号?: number;
  出处?: string;
};
