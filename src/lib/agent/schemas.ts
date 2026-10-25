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

/**
 * 说明可以不给：字段名已经说清楚的（customerName、remark）就只留类型。
 * 这张表每一步决策都整张送（2026-10-25 量过：参数 8.5k 字，比工具说明多一倍多），
 * 所以这里只写字段名说不清的事；问法举例写在工具说明里，propose_* 的取值看系统提示里的取值表，
 * 不在这儿再抄一遍。没进 required 的就是可空，不用再写「可空」。
 */
const 类型 = (type: string) => (说明?: string) => (说明 ? { type, description: 说明 } : { type });
const 串 = 类型("string");
const 数 = 类型("number");
const 真假 = 类型("boolean");

/** 只读的十二个（0.39 加了 query_records）。MCP 开出去的就是这一组 */
export const 只读SCHEMAS: Record<string, Schema> = {
  search_customers: {
    type: "object",
    properties: {
      query: 串("关键词"),
      channelName: 串("渠道名"),
      ownerName: 串("负责销售姓名"),
      followStatus: 串(),
      decisionStatus: 串(),
      createdFrom: 串("建档起 YYYY-MM-DD"),
      createdTo: 串("建档止，含当天"),
      expectedSignFrom: 串("预计签约起 YYYY-MM-DD"),
      expectedSignTo: 串("预计签约止，含当天"),
      mine: 真假("只看我负责的"),
    },
    additionalProperties: false,
  },
  get_customer: {
    type: "object",
    properties: { id: 串("客户 id"), name: 串("或给姓名，重名会让你挑") },
    additionalProperties: false,
  },
  query_metric: {
    type: "object",
    properties: {
      metric: 串("leads_count / lead_conversion / customers_count / contract_amount / contract_count / followups_count"),
      groupBy: 串("该指标能用的维度见工具说明"),
      from: 串("YYYY-MM-DD"),
      to: 串("YYYY-MM-DD"),
    },
    required: ["metric"],
    additionalProperties: false,
  },
  find_person: {
    type: "object",
    properties: { name: 串("原样传，不要截短") },
    required: ["name"],
    additionalProperties: false,
  },
  my_recap: {
    type: "object",
    properties: { days: 数("recent 时最近几天，默认7，1~90"), period: { type: "string", enum: ["recent", "this_month", "last_month", "this_week", "last_week"], description: "月/周按自然日历；recent 按最近 days 天" } },
    additionalProperties: false,
  },
  get_watchlist: { type: "object", properties: { scope: { type: "string", enum: ["mine", "team"], description: "默认 mine" } }, additionalProperties: false },
  get_my_plans: { type: "object", properties: {}, additionalProperties: false },
  list_channels: {
    type: "object",
    properties: { keyword: 串(), includeInactive: 真假("连停用的一起列") },
    additionalProperties: false,
  },
  list_leads: {
    type: "object",
    properties: { keyword: 串("名称 / 联系人 / 电话"), status: 串(), source: 串() },
    additionalProperties: false,
  },
  list_opportunities: {
    type: "object",
    properties: {
      stage: 串(),
      status: 串("默认 OPEN"),
      customerName: 串(),
      minAmount: 数("金额下限"),
      dealFrom: 串("预计成交起 YYYY-MM-DD"),
      dealTo: 串("预计成交止，含当天"),
    },
    additionalProperties: false,
  },
  list_users: {
    type: "object",
    properties: { keyword: 串(), includeInactive: 真假("连停用的一起列") },
    additionalProperties: false,
  },
  list_suppliers: {
    type: "object",
    properties: { keyword: 串(), product: 串() },
    additionalProperties: false,
  },
  list_orders: {
    type: "object",
    properties: { customerName: 串(), ownerName: 串(), onlyLate: 真假("只看有超期节点的") },
    additionalProperties: false,
  },
  list_contracts: {
    type: "object",
    properties: {
      from: 串("YYYY-MM-DD"),
      to: 串("YYYY-MM-DD，含当天"),
      customerName: 串(),
      ownerName: 串(),
      channelName: 串(),
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
        description: "彼此是「且」",
        items: {
          type: "object",
          properties: {
            字段: 串("中文字段名，如 跟进状态"),
            运算: 串("包含 / 等于 / 不等于 / 属于 / 大于 / 小于 / 不早于 / 不晚于 / 最近天数 / 为空 / 非空"),
            值: { description: "运算为 为空/非空 时不填；属于 时给数组；最近天数 时给天数" },
          },
          required: ["字段", "运算"],
        },
      },
      关联: {
        type: "object",
        description: "跨一张表筛选（只能跨一张）",
        properties: {
          路径: 串("如 客户.来源渠道 / 商机.客户 / 签约.客户 / 联系人.客户 / 跟进记录.客户 / 跟进计划.客户 / 任务.客户"),
          条件: { type: "array", description: "形状同上", items: { type: "object" } },
        },
        required: ["路径", "条件"],
      },
      排序: {
        type: "object",
        properties: { 字段: 串(), 降序: 真假("默认 true") },
        required: ["字段"],
      },
      取: 数("最多 50，默认 20"),
      只计数: 真假("只要条数时给 true"),
      分组: 串("按此字段分组计数，不能按日期"),
    },
    required: ["表"],
    additionalProperties: false,
  },
  search_followups: {
    type: "object",
    properties: { keyword: 串(), days: 数("只看最近几天"), mine: 真假("只看我记的") },
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
const 理由 = "一句话理由";
const 币种 = "币种代码如 USD，空 = 本位币";

export const 建议SCHEMAS: Record<string, Schema> = {
  propose_status_change: {
    type: "object",
    properties: { id: 串("客户 id"), to: 串("新状态"), reason: 串(理由) },
    required: ["id", "to", "reason"],
    additionalProperties: false,
  },
  propose_followup: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      type: 串("跟进类型"),
      title: 串("一句话标题"),
      content: 串("这次聊了什么"),
      occurredAt: 串("已经发生的时间 YYYY-MM-DD HH:mm，不给算刚刚"),
      reason: 串(理由),
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
      method: 串("计划方式"),
      reason: 串(理由),
    },
    required: ["id", "subject", "plannedAt", "reason"],
    additionalProperties: false,
  },
  propose_lead: {
    type: "object",
    properties: {
      name: 串("线索名称 / 姓名"),
      contact: 串(),
      phone: 串(),
      source: 串(),
      status: 串(),
      remark: 串(),
      reason: 串(理由),
    },
    required: ["name", "reason"],
    additionalProperties: false,
  },
  propose_customer_update: {
    type: "object",
    properties: {
      id: 串("客户 id"),
      changes: { type: "object", description: "只写要改的项" },
      reason: 串(理由),
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
      currency: 串(币种),
      stage: 串("商机阶段"),
      probability: 数("0~100"),
      expectedDealAt: 串("YYYY-MM-DD"),
      remark: 串(),
      reason: 串(理由),
    },
    required: ["id", "name", "amount", "stage", "reason"],
    additionalProperties: false,
  },
  propose_contract: {
    type: "object",
    properties: { id: 串("客户 id"), amount: 数("签约金额"), currency: 串(币种), signedAt: 串("YYYY-MM-DD"), remark: 串(), reason: 串(理由) },
    required: ["id", "amount", "signedAt", "reason"],
    additionalProperties: false,
  },
  propose_channel_update: {
    type: "object",
    properties: {
      channelName: 串("渠道名"),
      ownerName: 串("新负责人姓名"),
      phone: 串(),
      remark: 串(),
      reason: 串(理由),
    },
    required: ["channelName", "reason"],
    additionalProperties: false,
  },
};

export const SCHEMAS: Record<string, Schema> = { ...只读SCHEMAS, ...建议SCHEMAS };
