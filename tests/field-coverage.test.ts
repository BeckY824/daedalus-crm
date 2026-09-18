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
  Opportunity: ["name", "amount", "stage", "status", "probability", "expectedDealAt", "remark", "customerId", "ownerId"],
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
  FollowPlan: { ownerId: "创建者，不做转派" },
  FollowUp: { ownerId: "记录人，不做转派" },
  AiConversation: {
    ownerId: "问的人，落库时打上。对话只有自己看得见，转派没有意义",
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
