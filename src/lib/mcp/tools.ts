import { TOOLS, TOOL_MAP, type ToolContext } from "@/lib/agent/tools";
import { getBusiness } from "@/lib/business";

/**
 * 把 agent 的工具箱翻译成 MCP 的形。
 *
 * 我们自己那套 ReAct 循环（lib/agent/run.ts）让模型吐一段 JSON 来选工具，
 * 工具描述里的参数是一串给人和模型看的样例字符串（`args`）。MCP 那边要的是
 * **JSON Schema**——客户端（Claude Code / Codex）拿它做补全和校验。
 * 两份说明各服务一个调用方，所以 schema 写在这里，不塞回 tools.ts 去污染那边。
 *
 * **只暴露只读的九个。** `propose_*` 那几个产出的是「建议卡」——一张要人在我们
 * 界面上点确认才落库的待办，而 MCP 客户端里没有那张卡；在那边把它变成直接写入，
 * 等于把「AI 只起草、人才落库」这条规矩从后门绕掉。写入这条路要等建议卡能持久化
 * （见 ROADMAP），那时再作为一组 propose 工具开出去。
 */

/** MCP 客户端看到的一个工具 */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
};

const 串 = (说明: string) => ({ type: "string", description: 说明 });
const 数 = (说明: string) => ({ type: "number", description: 说明 });
const 真假 = (说明: string) => ({ type: "boolean", description: 说明 });

/**
 * 每个只读工具的参数表。**手写，不从 `args` 那串样例里推**——
 * 推出来的东西没有类型也没有必填，客户端拿着它只会瞎猜。
 */
const SCHEMAS: Record<string, McpTool["inputSchema"]> = {
  search_customers: {
    type: "object",
    properties: {
      query: 串("姓名 / 公司 / 行业 / 备注里的关键词"),
      followStatus: 串("只看某个跟进状态"),
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
    properties: { stage: 串("商机阶段"), status: 串("OPEN / WON / LOST，默认 OPEN"), customerName: 串("客户姓名") },
    additionalProperties: false,
  },
  search_followups: {
    type: "object",
    properties: { keyword: 串("跟进内容里的关键词"), days: 数("只看最近多少天"), mine: 真假("只看我记的") },
    required: ["keyword"],
    additionalProperties: false,
  },
};

/** 开出去的工具名单。propose_* 一个都不在里面，理由见文件头 */
export const MCP_TOOL_NAMES = Object.keys(SCHEMAS);

export function 列工具(): McpTool[] {
  return TOOLS.filter((t) => SCHEMAS[t.name]).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: SCHEMAS[t.name],
  }));
}

/**
 * 跑一个工具，把结果变成 MCP 的 content。
 *
 * 回的是一段 JSON 文本而不是散文：对面是另一个 agent，它要的是能再加工的数据，
 * 不是给人看的排版。`summary` 一并带上——那一句是我们这边写好的人话，
 * 对面把它直接转述给用户也不会错。
 */
export async function 跑工具(name: string, args: Record<string, unknown>, who: { id: string; name: string }) {
  if (!SCHEMAS[name]) throw new Error(`没有这个工具：${name}`);
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  const ctx: ToolContext = { userId: who.id, userName: who.name, b: await getBusiness(), recordOffset: 0, proposals: [] };
  const r = await tool.run(args ?? {}, ctx);
  return { summary: r.summary, data: r.data };
}
