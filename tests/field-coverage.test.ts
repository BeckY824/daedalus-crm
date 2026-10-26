/**
 * 字段覆盖审计：表里有的字段，要么能改，要么说清为什么不能改。
 *
 * 起因是「渠道负责人」——schema 里有、列表和详情页都显示、却没有任何地方能改，
 * AI 被问到时只好编一个不存在的入口。这种"有字段却改不了"的缺口不该靠人肉发现。
 *
 * 这条测试把每个模型的标量字段分成三类，**三类之外的字段一律让测试挂掉**：
 *   可写      —— 有 server action 能写它（人和 AI 都走这条路）
 *   派生/只读 —— 由系统算出来或系统打上的，写它就是破坏一致性，逐个写明理由
 *   已知缺口  —— 明知有洞、还没补：也要写明，让它一直显眼，而不是悄悄躺着
 * 新加字段时必须归到某一类，否则这里就红。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** 从 schema.prisma 读出每个模型的标量字段（去掉 id / 时间戳 / 关系对象） */
function 标量字段(): Record<string, string[]> {
  const s = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
  const models = [...s.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)];
  const names = new Set(models.map((m) => m[1]));
  const out: Record<string, string[]> = {};
  for (const [, name, body] of models) {
    out[name] = body
      .split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)).filter((p) => p.length >= 2)
      .filter((p) => !/^(id|createdAt|updatedAt)$/.test(p[0]))
      .filter((p) => !names.has(p[1].replace(/[\[\]?]/g, "")))
      .map((p) => p[0]);
  }
  return out;
}

/** 可写：对应的 server action 接收这个字段 */
const 可写: Record<string, string[]> = {
  // 企业版组织架构（2026-10-24）：设置 → 组织架构（settings/org-actions.ts）
  EntDept: ["name", "parentId"],
  EntMember: ["deptId", "bizRole", "line", "managerId", "dottedManagerId"],
  // 企业版线索分配（2026-10-24）：leads/assign-actions.ts 的 分配线索 / 设配额
  EntLeadAssign: ["leadId", "toUserId", "line", "kind"],
  EntLeadQuota: ["userId", "quota"],
  Customer: ["name", "phone", "school", "grade", "major", "channelId", "referrerCustomerId", "salesOwnerId", "channelOwnerId", "followStatus", "decisionStatus", "expectedSignAt", "remark"],
  Channel: ["name", "phone", "remark", "channelOwnerId", "active"],
  Lead: ["name", "contact", "phone", "email", "industry", "source", "status", "remark", "ownerId"],
  Contract: ["customerId", "amount", "signedAt", "remark"],
  Contact: ["name", "position", "phone", "email", "wechat", "isPrimary", "remark", "customerId"],
  // 未归属联系人：联系人页上点开改资料（saveUnassignedContact）
  UnassignedContact: ["name", "position", "phone", "email", "wechat", "remark"],
  Opportunity: ["name", "amount", "stage", "status", "probability", "expectedDealAt", "remark", "customerId", "ownerId"],
  // 币种（2026-10-03）：saveOpportunity / saveContract 收 currency，签约的精确金额跟着 amount 一起写
  OpportunityMoney: ["currency"],
  ContractMoney: ["currency", "amountExact"],
  // 报价明细（2026-10-03）：saveOpportunity 收 报价，一行五个字段
  QuoteLine: ["product", "spec", "qty", "unit", "unitPrice"],
  // 外贸订单（2026-10-03）：表头 saveOrder，节点 saveOrderNode，单据 saveOrderDoc / addOrderDoc
  TradeOrder: ["no", "amount", "currency", "incoterm", "payment", "depositDue", "depositPaid", "depositAt", "balancePaid", "balanceAt", "remark"],
  TradeOrderNode: ["name", "dueAt", "status"],
  // 客户的外贸档案（2026-10-05）：客户表单 saveCustomer 的 extra、记录页 patchCustomer 单格改、导入、线索转客户
  // 2026-10-16 加客户等级、官网：同样走 saveCustomer 的 extra、patchCustomer、导入
  CustomerExtra: ["country", "whatsapp", "wechat", "email", "source", "level", "website", "alibabaId"],
  TradeOrderDoc: ["name", "state"],
  // 供应商和比价（3c）：saveSupplier / saveSupplierQuote / saveOrderPurchase
  Supplier: ["name", "category", "region", "contact", "phone", "wechat", "invoice", "payment", "rating", "issues", "remark"],
  SupplierQuote: ["supplierId", "product", "unitPrice", "currency", "withInvoice", "moq", "leadDays", "sampleFee", "validUntil", "verdict", "reason"],
  TradeOrderPurchase: ["supplierId", "cost", "currency", "fxRate"],
  // 团队版项目模式 1a（2026-10-23）：建档向导、项目详情（编辑项目 / 改节点 / 勾交付 / 项目组）、设置里的「项目模式」一栏
  Project: ["name", "contactId", "ownerId", "phase", "node", "result", "exceptionCategoryId", "exceptionReason", "balanceSettled", "acceptancePassed", "amount", "currency", "remark"],
  ProjectMember: ["roleId"],
  ProjectRole: ["name", "active"],
  ProjectExceptionCategory: ["name", "active"],
  FollowUp: ["type", "title", "content", "status", "duration", "occurredAt", "dueAt", "participants", "customerId", "contactId", "opportunityId"],
  Task: ["title", "dueAt", "done", "customerId"],
  FollowPlan: ["subject", "plannedAt", "method", "done", "customerId"],
  // 对话历史：人能改的只有标题（重命名）。其余是系统打的，见下面「派生」
  AiConversation: ["title"],
};

/** 派生 / 只读：写明为什么不能直接改 */
const 派生: Record<string, Record<string, string>> = {
  EntDept: { sort: "新建时排在同一级最后，系统算" },
  EntMember: { userId: "哪个账号，一人一行；设成员时按账号定，不改" },
  EntLeadAssign: {
    fromUserId: "分之前线索在谁名下，分配时从线索上抄过来",
    byUserId: "点分配的那个人，当前登录账号",
    counted: "算不算进当月配额，按线索种类和设置算出来",
    month: "分配那一刻的年月，按业务钟算（企业版北京时间），每月清零靠它",
  },
  EntLeadQuota: { setById: "最后改配额的人，当前登录账号" },
  Opportunity: { activityAt: "最近业务推进时间；转交负责人保留，业务字段/报价变化时刷新，老数据为空沿用原修改时间" },
  Customer: {
    expectedSignOn: "预计签约原日历日，随保存/导入/同步保留；旧数据未知为空",
    attributionChannelId: "推荐链往上两代算出来的，改推荐人它就跟着变",
    attributionCustomerId: "同上",
    lastFollowAt: "最近一条跟进的时间，记跟进时自动维护",
  },
  Lead: {
    convertedAt: "convertLead 转化时打上",
    customerId: "转化后指向新建的客户，由 convertLead 设置",
  },
  Task: { dueOn: "仅日期的原日历日，保存时派生并随同步保留", dueHasTime: "明确钟点选择；旧数据未知为空", doneAt: "toggleTask 完成时打上", ownerId: "创建者，不做转派" },
  OpportunityClose: {
    opportunityId: "哪个商机，变成赢单或丢单时一起写",
    closedAt: "赢单 / 丢单的那一刻，系统打上；回到进行中就删掉这一行",
  },
  OpportunityMoney: { opportunityId: "哪个商机，saveOpportunity 新建 / 改币种时一起写" },
  ContractMoney: { contractId: "哪一笔签约，saveContract 保存时一起写" },
  // 2026-10-04 L-007：整行是登记签约勾了赢单时系统记下的，删签约时据此退回，没有单改某一格的入口
  ContractWin: {
    opportunityId: "哪个商机，saveContract 勾了赢单时一起记；商机之后离开赢单就删掉这一行",
    contractId: "哪一笔签约赢下的，删这笔签约时据此退回商机",
    prevStage: "赢单之前的阶段，系统记下，退回时用",
    prevProbability: "赢单之前的概率，同上",
  },
  Quote: {
    opportunityId: "哪个商机，saveOpportunity 带报价时一起写",
    quotedAt: "这一版报价记下的那一刻，系统打上；改价另记一版，不改旧的",
    currency: "报价那一刻商机的币种，跟着商机走",
  },
  QuoteLine: { quoteId: "属于哪一版报价", sort: "这一版里的第几行，按界面上的顺序打上" },
  TradeOrder: {
    customerId: "建单时定：订单是哪位客户的，不改（改了等于另一张单）",
    opportunityId: "从哪个商机生成的，建单时打上；商机删了置空",
    ownerId: "业务员，下单那一刻固化（同 ContractOwner），业绩按它算",
    contractId: "这张订单是哪一笔签约（2026-10-05 订单 = 签约），建单时和签约一起写，不改",
  },
  CustomerExtra: { customerId: "哪位客户的档案，一位一行" },
  TradeOrderNode: { orderId: "属于哪张订单", idx: "第几步（1–12），建单时排好", doneAt: "改成已完成的那一刻，系统打上；改回别的就清掉" },
  TradeOrderDoc: { orderId: "属于哪张订单", sort: "清单里的顺序，加一样时排在最后" },
  SupplierQuote: { opportunityId: "哪个商机（询盘）的比价，建行时定", quotedAt: "记下这一行的那一刻，系统打上" },
  TradeOrderPurchase: { orderId: "哪张订单，一张一行" },
  // 公海（第 6 块）：整行是「放进 / 领取」两个动作的结果，没有单改某一格的入口
  CustomerPool: {
    customerId: "哪位客户，有这一行 = 在公海；放进公海时建、领取时删",
    userId: "谁放进去的，放进公海时打上；自动掉进去的为空",
    reason: "手动 / N 天没跟进自动放进，系统打上",
    at: "放进去的那一刻，系统打上",
  },
  CustomerClaim: {
    customerId: "哪位客户，领取时建 / 覆盖",
    userId: "谁领的，领取时打上",
    at: "领走的那一刻，自动掉公海从它算起",
  },
  // 合并重复（2026-10-20）：两张都是一个动作的结果，没有单改某一格的入口
  CustomerMerge: {
    fromId: "被合并掉的那位，合并时打上（= id）",
    intoId: "留下的那位，合并时打上",
    fromName: "被合并那位原来的名字，合并时打上，给人看",
    fromOwnerName: "被合并那位原来的负责人，合并时打上，给人看",
    userId: "谁合并的，合并时打上",
    at: "合并的那一刻，系统打上",
  },
  CustomerNotDupe: {
    customerId: "两位里编号小的那位，标「不是同一个人」时打上",
    otherId: "另一位，同上",
    userId: "谁标的，标的时候打上",
    at: "标的那一刻，系统打上",
  },
  FollowUpOrder: { followUpId: "哪条跟进，在节点上记一笔时一起建", orderId: "挂在哪张订单上", nodeIdx: "挂在第几步上" },
  ContractOwner: {
    contractId: "哪一笔签约，saveContract 新登记时一起建",
    salesOwnerId: "签约那一刻客户的销售负责人，新登记时打上；业绩按它算，之后不跟着换人",
    channelOwnerId: "签约那一刻客户的渠道负责人，同上",
  },
  UnassignedContact: {
    wasPrimary: "移出时保存原关键身份；空值表示旧数据未知，挂回原客户可预选恢复，换客户不默认接管关键身份",
    ownerId: "移出或保留联系人时记录操作者，权限隔离使用；不允许表单转派",
    fromCustomerId: "detachContact 移出时记下原来是谁的，挂回原处时接回跟进记录用",
    fromCustomerName: "同上，给人看（那位之后可能被删）",
    followUpIds: "detachContact 移出时记下原来指着他的跟进记录",
    detachedAt: "移出的时刻，系统打上",
  },
  FollowPlan: { plannedOn: "仅日期的原日历日，保存时派生并随同步保留", plannedHasTime: "明确钟点选择；旧数据未知为空", ownerId: "创建者，不做转派", doneAt: "实际完成时系统记录；撤销完成清空，旧记录未知则为空，不允许手工伪造" },
  FollowUp: { dueOn: "仅日期原日历日，随派生待办/撤销保存", dueHasTime: "明确钟点选择；旧数据未知为空", ownerId: "记录人，不做转派" },
  AiConversation: {
    ownerId: "问的人，落库时打上。对话只有自己看得见，转派没有意义",
    scope: "在哪一页问的，新建那条对话时打上。一条对话在哪一页开的，之后不会变——面板按它翻这一页的历史",
    lastAskedAt: "最后一次提问的时间，落一轮时自动维护——排序按它",
    projectId: "项目那一层这一版只有表没有界面（列必须现在就建，migrations 只能加表不能加列）",
    pinnedAt: "置顶。同上，列先留着，界面下一版再长出来",
    archivedAt: "归档。同上；眼下删对话是真删，不是归档",
  },
  AiMessage: {
    conversationId: "属于哪条对话，落库时定，之后不换",
    role: "user 还是 assistant，由落库那一刻决定",
    text: "问了什么、答了什么。**不给改**：能改的历史就不是历史了",
    model: "这一答用的哪个模型，系统记的",
    ms: "这一答用了多久，系统记的",
    steps: "工具调用轨迹，系统记的",
    refs: "这一答读到的记录，系统记的",
  },
  AiProject: {
    name: "这一版只有表、没有界面，见 AiConversation.projectId",
    brief: "同上",
    ownerId: "同上",
    archivedAt: "同上",
  },
  /*
    导入批次这两张表**整体只读**。它们是一次导入发生过什么的账，
    而账能改的话，撤销就不再可信——撤销照着这里的记录走，
    改一条 before 就能让撤销把别的值写进人家的档案。
    人在界面上能做的只有一件：撤销一整批（revertedAt）。
  */
  ImportBatch: {
    at: "导入发生的时刻，落库时打上。撤销要拿它和客户的 updatedAt 比，改了就比错了",
    userId: "谁导的，落库时打上",
    userName: "同上，冗余存一份，成员被删也还认得出是谁",
    fileName: "导的哪个文件，落库时打上。只存文件名，不存内容",
    sheetName: "第几张工作表。眼下只读第一张，这一列先留着（migrations 只能加表不能加列）",
    created: "这一批建了几条，执行完写一次",
    updated: "补空了几条，同上",
    skipped: "跳过几条，同上",
    failed: "没进来几条，同上",
    revertedAt: "撤销时打上。**这是这两张表上唯一一处人能触发的改动**，而且只能从没值变成有值",
  },
  ImportRow: {
    batchId: "属于哪一批，落库时定",
    customerId: "这一行落到了哪位客户身上，落库时定",
    kind: "create 还是 update，落库时定——撤销按它决定是删还是还原",
    before: "补空之前那几格是什么。**不给改**：撤销照着它还原，能改就等于能让撤销写任意值",
    writtenAt: "写完那一刻客户的 updatedAt，落库时定——撤销拿它判断之后有没有人改过",
  },
  /*
    企业版导入（2026-10-24，lib/enterprise-import/）：飞书 / 钉钉 / Excel 导进来的批次、对照、冲突、回收站、切换快照。
    跟上面的导入账一样是「账」：系统按导入 / 同步 / 撤回 / 定冲突的流程写，人在设置页「企业版导入」里能做的
    只有那几个动作（改映射重新试跑、正式导入、整批撤回 / 恢复、定冲突、开关同步、切换），没有直接改某一格的入口。
    能直接改的话撤回和三方比对就不再可信。
  */
  EntImportBatch: {
    source: "从哪来（excel / feishu / dingtalk），建批时定",
    kind: "首次 / 同步 / 定冲突，建批时定",
    status: "流程状态：试跑、写入、撤回、恢复各一步一步推进，只有这几个动作能改它",
    userId: "谁做的，建批时打上",
    report: "试跑报告，试跑和「改映射重新试跑」时整份重算",
    raw: "上传的表读出来的样子，建批时存；重新试跑从这里取，不给改",
    mapping: "人在报告上认过的映射，「改映射重新试跑」时整份重算，不单格改",
    plan: "清洗后的待写记录，跟着报告一起算，正式导入照它写——改了就和人看过的报告对不上",
    cursor: "正式导入 / 撤回写到第几条，续写用，系统推进",
    total: "这一批几条，试跑时算",
    created: "建了几条，写入时累加",
    updated: "更新了几条，同上",
    skipped: "没变跳过几条，同上",
    conflicts: "记了几笔冲突，同上",
    failed: "没写进去几条，同上",
    note: "写不进去的明细，写入时记",
    finishedAt: "写完那一刻",
    revertedAt: "整批撤回时打上，恢复时清掉",
    revertNote: "最近一次撤回 / 恢复的账（删掉、还原、留下几条），系统写",
  },
  EntImportRow: {
    batchId: "属于哪一批，写入时定",
    entity: "落到哪类记录，写入时定",
    externalId: "原系统 ID，写入时定",
    targetId: "落到我们这边哪条，写入时定",
    kind: "新建还是更新，撤回按它决定删还是还原",
    before: "更新之前那几格。**不给改**：撤回照着它还原，能改就等于能让撤回写任意值",
    written: "写进去的值，撤回时比对有没有人动过",
    refBefore: "写之前的对照行，撤回时退回去",
    undo: "整批撤回时这一行怎么处理的，撤回 / 恢复时系统写",
  },
  EntExternalRef: {
    source: "从哪来，第一次写入时定",
    entity: "哪类记录，同上",
    externalId: "原系统 ID，同上——同步按 来源 + 原系统 ID 认人，改了就认错",
    targetId: "对到我们这边哪条，写入时定",
    fingerprint: "原系统记录的指纹，每次写入时算，没变就跳过",
    written: "上次我们写进去的值，三方比对用，写入时更新",
    raw: "原系统最后一次给的原始记录，留档和切换快照用",
    batchId: "最近写它的是哪一批",
  },
  EntConflict: {
    source: "同步时记下，照原系统来的那条",
    entity: "同上",
    externalId: "同上",
    targetId: "同上",
    batchId: "哪一批同步记下的",
    fields: "三方的值（原系统 / 我们 / 上次），记下时定",
    incoming: "原系统这次给的整条，采用原系统时照它写",
    localDeleted: "记下时我们这边那条已经删了，系统判断",
    status: "人在冲突页点「采用原系统 / 保留我们」改；撤回、过时由系统改",
    resolvedById: "谁定的，定的时候打上",
    resolvedAt: "什么时候定的，同上",
    resolveBatchId: "定它的那一批，整批撤回时据此退回待定",
  },
  EntTrash: {
    batchId: "哪一批撤回时删的",
    entity: "哪类记录",
    targetId: "删掉的是哪条",
    data: "删之前的整条记录，恢复时照它建回；不给改",
    ref: "撤回时的对照行，恢复时照它建回",
    rowId: "对应哪一行导入账",
    restoredAt: "恢复时打上",
  },
  EntSnapshot: {
    source: "切换的是哪个来源，切换时定",
    userId: "谁点的切换",
    count: "快照里几条对照",
    data: "切换那一刻的全部对照和原始记录，留档，不给改",
  },
  // 企业版联系方式子表（2026-10-26）：建档时照客户 / 联系人上的号系统写，人改号码改的是原来那几格
  ContactMethod: {
    customerId: "哪位客户，建档时系统写",
    contactId: "哪位联系人的号；客户本身的号为空，建档时系统写",
    kind: "号码类型，照建档时选的写",
    value: "规整后的号，照建档时填的写",
    numberKey: "查重用的规整值，从号算出来",
    formatStatus: "格式校验结果，系统判",
    region: "号码归属地，从离线号段库算出来",
  },
  /*
    商机 / 订单的附件（2026-10-22 D-24，lib/attachments.ts）：文件存进去以后不再改，要换就是删了再传。
    传的时候 POST /api/attachments 落一整行，之后只能 DELETE，没有改的入口
  */
  Attachment: {
    opportunityId: "挂在哪个商机上，传的时候定",
    orderId: "挂在哪张订单上，传的时候定",
    name: "原文件名，传的时候定（去掉路径和 Windows 不认的字符）",
    mime: "文件类型，传的时候定。决定能不能在页面里显示，不给改",
    size: "文件字节数，存文件时量出来",
    width: "图片压完以后的宽，存文件时定",
    height: "图片压完以后的高，同上",
    sha256: "文件内容的指纹，存文件时算。团队版拿它去重和校验，改了就对不上",
    userId: "谁传的，落库时打上",
  },
  // 团队版项目模式 1a（2026-10-23）：系统打上的
  Project: {
    customerId: "建档向导里和客户一起建，不改（改了等于另一单生意）",
    creatorId: "实际建档的人，向导保存那一刻打上，不改",
    balanceSettledById: "勾尾款结清的那个人，系统打上",
    balanceSettledAt: "勾尾款结清的那一刻，系统打上",
    acceptancePassedById: "勾验收通过的那个人，系统打上",
    acceptancePassedAt: "勾验收通过的那一刻，系统打上",
    closedAt: "有结局的那一刻，系统打上；回到进行中清掉",
    pooledAt: "放回公海的那一刻，系统打上；有人领取或老板重新指派时清掉",
    nextStepAt: "记沟通时填的下一步时间，跟着最近一条沟通写；企业版超时回收用",
  },
  ProjectMember: { projectId: "哪个项目的组员，加人时定", userId: "哪位成员，加人时定；换人 = 删了再加", invitedById: "谁拉进来的，加人时打上" },
  ProjectRole: { sort: "加角色时排到最后，系统写；不做拖动排序" },
  ProjectExceptionCategory: { sort: "加类别时排到最后，系统写；不做拖动排序" },
  ProjectNodeLog: {
    projectId: "哪个项目，改节点时系统写", userId: "谁改的，系统写", at: "改的那一刻，系统写",
    fromPhase: "改之前的阶段，系统写", fromNode: "改之前的节点，系统写", fromResult: "改之前的结局，系统写",
    toPhase: "改之后的阶段，系统写", toNode: "改之后的节点，系统写", toResult: "改之后的结局，系统写",
    reason: "进异常状态时填的备注（可空），跟着那一次改节点写；只增不改",
    categoryId: "进异常状态时选的类别，跟着那一次改节点写；只增不改",
    kind: "这一行是改节点、转让负责人、放回公海还是领取，系统写",
    fromOwnerId: "转让 / 放回公海 / 领取前的负责人，那一刻系统写；改节点的行留空",
    toOwnerId: "转让 / 领取后的负责人，那一刻系统写；放回公海和改节点的行留空",
  },
  FollowUpProject: { followUpId: "哪条沟通记录，记的时候定", projectId: "挂在哪个项目，记的时候定", node: "记这条时项目在哪个节点，系统打上" },
  CustomerCreator: { customerId: "哪位客户，一位一行", userId: "实际建档的人，向导保存那一刻打上，不改", at: "建档那一刻，系统打上" },
  CustomerOwnerLog: {
    customerId: "哪位客户，换负责人时系统写", userId: "谁换的，系统写", at: "换的那一刻，系统写",
    fromOwnerId: "换之前的负责人（历史负责人），系统写", toOwnerId: "换之后的负责人，系统写",
    kind: "改负责人、公海领取 / 分配还是成员停用，系统写",
  },
};

/** 已知缺口：有字段、没写入路径。留在这里是为了让它一直显眼 */
/** 已知缺口：有字段、没写入路径。留在这里是为了让它一直显眼。
 *  2026-09-14 清空：FollowUp.attachment / attachSize 是纯死字段，已从 schema 删除
 *  （已有库里的列留着不读，迁移规矩只加不删）。 */
const 已知缺口: Record<string, Record<string, string>> = {
  // 团队版项目模式 1a：进组状态 1a 拉人一律 JOINED（系统写），等 1b 进组邀请补上「已邀请 / 没接受」
  ProjectMember: { inviteStatus: "1a 拉人一律写 JOINED；用户能动它要等 1b 进组邀请（团队版会话）" },
  // 企业版组织架构（2026-10-24）：这一步只有表和 helper，设置里的「组织架构」页在下一个 PR，到时挪进 可写
  EntDept: { name: "设置里的组织架构页在下一个 PR 才有写入口", parentId: "设置里的组织架构页在下一个 PR 才有写入口", sort: "设置里的组织架构页在下一个 PR 才有写入口" },
  EntMember: {
    userId: "设置里的组织架构页在下一个 PR 才有写入口", deptId: "设置里的组织架构页在下一个 PR 才有写入口", bizRole: "设置里的组织架构页在下一个 PR 才有写入口",
    line: "设置里的组织架构页在下一个 PR 才有写入口", managerId: "设置里的组织架构页在下一个 PR 才有写入口", dottedManagerId: "设置里的组织架构页在下一个 PR 才有写入口",
  },
};

const 不审 = new Set(["User", "WorkspaceAccount", "FollowUpSource", "AuditLog", "Setting"]);

describe("每个模型的每个字段都有归属", () => {
  const 全部 = 标量字段();
  for (const [model, fields] of Object.entries(全部)) {
    if (不审.has(model)) continue;
    it(`${model}：${fields.length} 个字段都能改，或者说清为什么不能`, () => {
      const 没归类 = fields.filter(
        (f) => !可写[model]?.includes(f) && !派生[model]?.[f] && !已知缺口[model]?.[f],
      );
      expect(没归类, `${model} 里这些字段既不能改、也没说明为什么：${没归类.join("、")}`).toEqual([]);
    });
  }

  it("可写清单里不能有 schema 里根本没有的字段——那是改了表忘了改这里", () => {
    const 全部 = 标量字段();
    for (const [model, fields] of Object.entries(可写)) {
      const 多出 = fields.filter((f) => !全部[model]?.includes(f));
      expect(多出, `${model} 的可写清单里有 schema 没有的字段：${多出.join("、")}`).toEqual([]);
    }
  });

  it("已知缺口是要还的债：每条都要有说明", () => {
    for (const [model, gaps] of Object.entries(已知缺口)) {
      for (const [f, why] of Object.entries(gaps)) expect(why.length, `${model}.${f} 没写为什么`).toBeGreaterThan(10);
    }
  });
});
