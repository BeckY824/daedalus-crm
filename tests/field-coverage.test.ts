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
  CustomerExtra: ["country", "whatsapp", "wechat", "email", "source"],
  TradeOrderDoc: ["name", "state"],
  // 供应商和比价（3c）：saveSupplier / saveSupplierQuote / saveOrderPurchase
  Supplier: ["name", "category", "region", "contact", "phone", "wechat", "invoice", "payment", "rating", "issues", "remark"],
  SupplierQuote: ["supplierId", "product", "unitPrice", "currency", "withInvoice", "moq", "leadDays", "sampleFee", "validUntil", "verdict", "reason"],
  TradeOrderPurchase: ["supplierId", "cost", "currency", "fxRate"],
  FollowUp: ["type", "title", "content", "status", "duration", "occurredAt", "dueAt", "participants", "customerId", "contactId", "opportunityId"],
  Task: ["title", "dueAt", "done", "customerId"],
  FollowPlan: ["subject", "plannedAt", "method", "done", "customerId"],
  // 对话历史：人能改的只有标题（重命名）。其余是系统打的，见下面「派生」
  AiConversation: ["title"],
};

/** 派生 / 只读：写明为什么不能直接改 */
const 派生: Record<string, Record<string, string>> = {
  Customer: {
    attributionChannelId: "推荐链往上两代算出来的，改推荐人它就跟着变",
    attributionCustomerId: "同上",
    lastFollowAt: "最近一条跟进的时间，记跟进时自动维护",
  },
  Lead: {
    convertedAt: "convertLead 转化时打上",
    customerId: "转化后指向新建的客户，由 convertLead 设置",
  },
  Task: { doneAt: "toggleTask 完成时打上", ownerId: "创建者，不做转派" },
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
  FollowUpOrder: { followUpId: "哪条跟进，在节点上记一笔时一起建", orderId: "挂在哪张订单上", nodeIdx: "挂在第几步上" },
  ContractOwner: {
    contractId: "哪一笔签约，saveContract 新登记时一起建",
    salesOwnerId: "签约那一刻客户的销售负责人，新登记时打上；业绩按它算，之后不跟着换人",
    channelOwnerId: "签约那一刻客户的渠道负责人，同上",
  },
  UnassignedContact: {
    ownerId: "移出或保留联系人时记录操作者，权限隔离使用；不允许表单转派",
    fromCustomerId: "detachContact 移出时记下原来是谁的，挂回原处时接回跟进记录用",
    fromCustomerName: "同上，给人看（那位之后可能被删）",
    followUpIds: "detachContact 移出时记下原来指着他的跟进记录",
    detachedAt: "移出的时刻，系统打上",
  },
  FollowPlan: { ownerId: "创建者，不做转派", doneAt: "实际完成时系统记录；撤销完成清空，旧记录未知则为空，不允许手工伪造" },
  FollowUp: { ownerId: "记录人，不做转派" },
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
};

/** 已知缺口：有字段、没写入路径。留在这里是为了让它一直显眼 */
/** 已知缺口：有字段、没写入路径。留在这里是为了让它一直显眼。
 *  2026-09-14 清空：FollowUp.attachment / attachSize 是纯死字段，已从 schema 删除
 *  （已有库里的列留着不读，迁移规矩只加不删）。 */
const 已知缺口: Record<string, Record<string, string>> = {};

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
