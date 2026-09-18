import { TOOLS, TOOL_MAP, type ToolContext } from "@/lib/agent/tools";
import { 只读SCHEMAS, type Schema } from "@/lib/agent/schemas";
import { getBusiness } from "@/lib/business";

/**
 * 把 agent 的工具箱翻译成 MCP 的形。
 *
 * 参数表（JSON Schema）在 lib/agent/schemas.ts —— 那份现在有**两个**调用方：
 * 这里（开给别人的 agent）和我们自己的原生 function calling（run.ts）。
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
  inputSchema: Schema;
};

/** 开出去的工具名单。propose_* 一个都不在里面，理由见文件头 */
export const MCP_TOOL_NAMES = Object.keys(只读SCHEMAS);

export function 列工具(): McpTool[] {
  return TOOLS.filter((t) => 只读SCHEMAS[t.name]).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: 只读SCHEMAS[t.name],
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
  if (!只读SCHEMAS[name]) throw new Error(`没有这个工具：${name}`);
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new Error(`没有这个工具：${name}`);
  const ctx: ToolContext = { userId: who.id, userName: who.name, b: await getBusiness(), recordOffset: 0, proposals: [] };
  const r = await tool.run(args ?? {}, ctx);
  return { summary: r.summary, data: r.data };
}
