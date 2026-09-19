/**
 * 每个工具的参数表（JSON Schema）。
 *
 * 两个调用方各用一半：
 *   - **原生 function calling**（run.ts）：这套 schema 直接当 `tools` 发给模型。
 *     模型不再需要「按我们规定的格式吐一段 JSON」，走的是它自己训练过的那条路——
 *     小模型在这件事上的成功率差别很大（2026-09-18 实测：flash 模型 226 个 prompt token
 *     就正确选中了 list_channels，而 JSON 协议那条路上它想了 70 多秒还选错）
 *   - **MCP**（lib/mcp/tools.ts）：只取只读那几个开出去
 *
 * 和 tools.ts 里那串 `args` 样例的关系：那串是给**人**看的（也顺带塞进提示词），
 * 这里是给**机器**看的。同一件事写两遍不理想，但样例字符串里那些「可空」「或者」
 * 是 schema 表达不了的口语，而 schema 里的类型又是样例说不清的——留两份，各自完整。
 */

export type Schema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

const 串 = (说明: string) => ({ type: "string", description: 说明 });
const 数 = (说明: string) => ({ type: "number", description: 说明 });
const 真假 = (说明: string) => ({ type: "boolean", description: 说明 });

/** 只读的十二个（0.39 加了 query_records）。MCP 开出去的就是这一组 */
export const 只读SCHEMAS: Record<string, Schema> = {
  search_customers: {
    type: "object",
    properties: {
      query: 串("姓名 / 学校 / 年级 / 专业 / 备注里的关键词"),
      channelName: 串("只看某个渠道带来的（「小红这个渠道里有谁」）"),
      ownerName: 串("只看某位销售负责的（「李四手上有哪些客户」）"),
      followStatus: 串("只看某个跟进状态"),
      decisionStatus: 串("只看某个决策状态（「还在犹豫的有谁」）"),
      createdFrom: 串("建档时间起，YYYY-MM-DD（「这周新增了哪些客户」）"),
      createdTo: 串("建档时间止，YYYY-MM-DD，含当天"),
      expectedSignFrom: 串("预计签约起，YYYY-MM-DD（「这个月预计能签哪几个」）"),
      expectedSignTo: 串("预计签约止，YYYY-MM-DD，含当天"),
      mine: 真假("只看我负责的"),
    },
    additionalProperties: false,
  },
  get_customer: {
    type: "object",
    properties: { id: 串("客户 id，从 search_customers 拿"), name: 串("或者直接给姓名，重名会让你去挑") },
    additionalProperties: false,
  },
  query_metric: {
    type: "object",
    properties: {
      metric: 串("leads_count / lead_conversion / customers_count / contract_amount / contract_count / followups_count"),
      groupBy: 串("month / sales / channel / source / grade / followStatus / decisionStatus / type，可空"),
      from: 串("YYYY-MM-DD，可空"),
      to: 串("YYYY-MM-DD，可空"),
    },
    required: ["metric"],
    additionalProperties: false,
  },
  find_person: {
    type: "object",
    properties: { name: 串("人名，原样传，不要截短") },
    required: ["name"],
    additionalProperties: false,
  },
  my_recap: {
    type: "object",
    properties: { days: 数("最近多少天，默认 7，1~90") },
    additionalProperties: false,
  },
  get_watchlist: { type: "object", properties: {}, additionalProperties: false },
  get_my_plans: { type: "object", properties: {}, additionalProperties: false },
  list_channels: {
    type: "object",
    properties: { keyword: 串("名字里的关键词"), includeInactive: 真假("连停用的一起列") },
    additionalProperties: false,
  },
  list_leads: {
    type: "object",
    properties: { keyword: 串("名称 / 联系人 / 电话"), status: 串("线索状态"), source: 串("线索来源") },
    additionalProperties: false,
  },
  list_opportunities: {
    type: "object",
    properties: {
      stage: 串("商机阶段"),
      status: 串("OPEN / WON / LOST，默认 OPEN"),
      customerName: 串("客户姓名"),
      minAmount: 数("金额下限，元（「超过 10 万的单子」）"),
      dealFrom: 串("预计成交起，YYYY-MM-DD（「这个月要关的单子」）"),
      dealTo: 串("预计成交止，YYYY-MM-DD，含当天"),
    },
    additionalProperties: false,
  },
  list_users: {
    type: "object",
    properties: { keyword: 串("姓名里的关键词"), includeInactive: 真假("连已停用的一起列") },
    additionalProperties: false,
  },
  list_contracts: {
    type: "object",
    properties: {
      from: 串("YYYY-MM-DD，可空"),
      to: 串("YYYY-MM-DD，可空，含当天"),
      customerName: 串("客户姓名"),
      ownerName: 串("销售负责人姓名"),
      channelName: 串("渠道名称"),
    },
    additionalProperties: false,
  },
  /**
   * 通用查询（0.39）。结构比别的工具复杂，但**复杂的是形状不是自由度**：
   * 表名、字段名、运算符、关联路径全是白名单里的词，填错了
   * `lib/agent/query.ts` 会退回一句「能用的是这些」，照着改一次就对。
   *
   * 这里刻意不把白名单枚举进 schema：九张表几十个字段铺开会把 prompt 撑爆，
   * 而小模型面对一张超长的枚举表反而更容易挑错。名单写在工具说明里，
   * 填错一次由错误信息纠正——一次往返，比每轮都背一遍便宜。
   */
  query_records: {
    type: "object",
    properties: {
      表: 串("查哪张表：客户 / 线索 / 商机 / 签约 / 联系人 / 跟进记录 / 跟进计划 / 任务 / 渠道"),
      条件: {
        type: "array",
        description: "筛选条件，彼此是「且」的关系。不给就是不筛",
        items: {
          type: "object",
          properties: {
            字段: 串("字段名，用中文，如 跟进状态 / 金额 / 建档时间"),
            运算: 串("包含 / 等于 / 不等于 / 属于 / 大于 / 小于 / 不早于 / 不晚于 / 最近天数 / 为空 / 非空"),
            值: { description: "运算为 为空/非空 时不填；属于 时给数组；最近天数 时给天数" },
          },
          required: ["字段", "运算"],
        },
      },
      关联: {
        type: "object",
        description: "跨一张表筛选（只能跨一张）。如 表=签约、路径=签约.客户，就能筛「所属客户的姓名包含陈」",
        properties: {
          路径: 串("如 客户.来源渠道 / 商机.客户 / 签约.客户 / 联系人.客户 / 跟进记录.客户 / 跟进计划.客户 / 任务.客户"),
          条件: { type: "array", description: "在那张表上的条件，形状同上", items: { type: "object" } },
        },
        required: ["路径", "条件"],
      },
      排序: {
        type: "object",
        properties: { 字段: 串("按哪个字段排"), 降序: 真假("true = 从大到小，默认 true") },
        required: ["字段"],
      },
      取: 数("要几条，最多 50，默认 20"),
      只计数: 真假("只想知道有多少条时给 true，不返回名单"),
      分组: 串("按这个字段分组数个数（如 跟进状态）。不能按日期分组"),
    },
    required: ["表"],
    additionalProperties: false,
  },
  search_followups: {
    type: "object",
    properties: { keyword: 串("跟进内容里的关键词"), days: 数("只看最近多少天"), mine: 真假("只看我记的") },
    required: ["keyword"],
    additionalProperties: false,
  },
};

/**
 * 建议卡那几个。**只在我们自己的 agent 里用**，不走 MCP——
 * 它们产出的是一张要人点确认的卡片，而别人的客户端里没有那张卡。
 *
 * `reason` 一律必填：卡片上要显示「为什么建议这么做」，没有理由的建议卡
 * 人没法判断该不该点。
 */
export const 建议SCHEMAS: Record<string, Schema> = {
  propose_status_change: {
    type: "object",
    properties: { id: 串("客户 id"), to: 串("新状态，只能用取值表里的词"), reason: 串("一句话：为什么") },
    required: ["id", "to", "reason"],
    additionalProperties: false,
  },
  propose_followup: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      type: 串("电话沟通 / 线上会议 / 上门拜访 / 邮件沟通 / 短信沟通 / 跟进任务 / 跟进提醒 / 其他记录"),
      title: 串("可选，一句话标题"),
      content: 串("这次聊了什么"),
      occurredAt: 串("可选，YYYY-MM-DD HH:mm，不给就算刚刚"),
      reason: 串("一句话：为什么"),
    },
    required: ["id", "type", "content", "reason"],
    additionalProperties: false,
  },
  propose_plan: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      subject: 串("下次谈什么"),
      plannedAt: 串("YYYY-MM-DD HH:mm"),
      method: 串("电话沟通 / 线上会议 / 上门拜访 / 邮件沟通 / 微信沟通"),
      reason: 串("一句话：为什么"),
    },
    required: ["id", "subject", "plannedAt", "reason"],
    additionalProperties: false,
  },
  propose_lead: {
    type: "object",
    properties: {
      name: 串("线索名称 / 姓名"),
      contact: 串("联系人，可空"),
      phone: 串("电话，可空"),
      source: 串("来源，可空"),
      status: 串("状态，可空"),
      remark: 串("备注，可空"),
      reason: 串("一句话：为什么"),
    },
    required: ["name", "reason"],
    additionalProperties: false,
  },
  propose_customer_update: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      changes: { type: "object", description: "只写要改的那几项；负责人 / 渠道 / 推荐人给名字（salesOwnerName / channelName / referrerName）" },
      reason: 串("一句话：为什么"),
    },
    required: ["id", "changes", "reason"],
    additionalProperties: false,
  },
  propose_opportunity: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      name: 串("商机名称"),
      amount: 数("金额"),
      stage: 串("初步沟通 / 需求确认 / 方案报价 / 谈判审核 / 赢单成交"),
      probability: 数("0~100，可空"),
      expectedDealAt: 串("可空，YYYY-MM-DD"),
      remark: 串("可空"),
      reason: 串("一句话：为什么"),
    },
    required: ["id", "name", "amount", "stage", "reason"],
    additionalProperties: false,
  },
  propose_contract: {
    type: "object",
    properties: { id: 串("客户 id"), amount: 数("签约金额"), signedAt: 串("YYYY-MM-DD"), remark: 串("可空"), reason: 串("一句话：为什么") },
    required: ["id", "amount", "signedAt", "reason"],
    additionalProperties: false,
  },
  propose_channel_update: {
    type: "object",
    properties: {
      channelName: 串("渠道名称"),
      ownerName: 串("新的渠道负责人姓名，可空"),
      phone: 串("可空"),
      remark: 串("可空"),
      reason: 串("一句话：为什么"),
    },
    required: ["channelName", "reason"],
    additionalProperties: false,
  },
};

export const SCHEMAS: Record<string, Schema> = { ...只读SCHEMAS, ...建议SCHEMAS };
