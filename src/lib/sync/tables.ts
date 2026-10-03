/**
 * 团队同步（2026-10-03，0.46.15 第 5 块）：哪些表同步、哪些列不同步、哪些列指向人。
 * 设计依据：~/CRM/团队同步探针-2026-10-03.md。
 *
 * 这三份清单都**必须和 prisma/schema.prisma 对得上**——加了表、加了指向人的列，这里不改不会报错，
 * 只会让那份数据悄悄不同步、或者改身份时漏改一列。tests/sync-tables.test.ts 对着 schema 一条条钉着。
 */

/**
 * 要同步的表。顺序 = 建表依赖顺序（被指的在前）：第一次推全量时按这个顺序记，别人回放时外键不打架。
 * 不同步的：AI 对话三张（AiConversation / AiMessage / AiProject，本来就只有自己看得见）、
 * 导入批次两张（ImportBatch / ImportRow，是本机的撤销记录）、WorkspaceAccount（托管版用的）。
 */
export const 同步表 = [
  "User",
  "Setting",
  "Channel",
  "Customer",
  "CustomerPool",
  "Contact",
  "UnassignedContact",
  "Lead",
  "Opportunity",
  "OpportunityClose",
  "OpportunityMoney",
  "Contract",
  "ContractOwner",
  "ContractMoney",
  "FollowUp",
  "FollowUpSource",
  "Task",
  "FollowPlan",
  "AuditLog",
  "Quote",
  "QuoteLine",
  "Supplier",
  "SupplierQuote",
  "TradeOrder",
  "TradeOrderNode",
  "TradeOrderDoc",
  "TradeOrderPurchase",
  "FollowUpOrder",
] as const;

/** 明确不同步的表（和上面合起来要覆盖 schema 里的全部模型，守卫用例据此判「新加的表没人管」） */
export const 不同步表 = ["AiConversation", "AiMessage", "AiProject", "ImportBatch", "ImportRow", "WorkspaceAccount"] as const;

/**
 * 不同步的列：
 *   派生字段——收到别人的改动后本机重算（探针场景 ③：「最近跟进」按后写为准同步会拿到后补记的那条）。
 *   **归属三件套（attributionChannelId / attributionCustomerId / channelOwnerId）不算派生**：它们是保存那一刻
 *   按推荐链固化的（lib/attribution.ts：「后续改动上游不会追溯性地改变已有学员的归属」），和推荐人一起写、一起同步；
 *   User.password——每台各登各的云端账号，本机密码只是占位。
 */
export const 不同步列: Record<string, string[]> = {
  Customer: ["lastFollowAt"],
  User: ["password"],
};

/** Setting 只同步这几个 key：业务配置是全团队一份；AI Key、本机偏好不同步 */
export const 同步的设置 = ["business"];

/**
 * 指向人（User.id）的列。改身份时一列不漏地改过去。
 * **有一半没有外键**（ContractOwner、TradeOrder、AuditLog…），光靠 PRAGMA foreign_key_list 找不全（探针场景 ①）。
 */
export const 指向人的列: [string, string][] = [
  ["Lead", "ownerId"],
  ["Channel", "channelOwnerId"],
  ["Customer", "salesOwnerId"],
  ["Customer", "channelOwnerId"],
  ["CustomerPool", "userId"],
  ["ContractOwner", "salesOwnerId"],
  ["ContractOwner", "channelOwnerId"],
  ["Opportunity", "ownerId"],
  ["FollowUp", "ownerId"],
  ["Task", "ownerId"],
  ["FollowPlan", "ownerId"],
  ["AuditLog", "userId"],
  ["AiConversation", "ownerId"],
  ["AiProject", "ownerId"],
  ["ImportBatch", "userId"],
  ["TradeOrder", "ownerId"],
  ["WorkspaceAccount", "userId"],
];

/**
 * 唯一约束撞车时按「同名就是同一个」合并的表（探针场景 ②）：两边都留 id 小的那个，另一个的引用改过去。
 * 值 = 唯一的那一列，和指向这张表的列。
 */
export const 同名合并: Record<string, { 列: string; 被指: [string, string][] }> = {
  Channel: { 列: "name", 被指: [["Customer", "channelId"], ["Customer", "attributionChannelId"]] },
};

/** 桌面端模板库里固定种的账号（每台电脑 id 一样）。进团队前：管理员改身份，没用过的占位账号删掉 */
export const 模板占位账号 = ["zhangsan", "lisi"];
