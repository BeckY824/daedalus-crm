/**
 * 工具表和 schema 表必须对得上。
 *
 * 这是和「打包白名单漏文件」一模一样的一类 bug：**两份清单必须一致，却没人对**。
 * 这里漏一条的后果是静默的——
 *   - 工具没进 SCHEMAS：run.ts 的 `TOOLS.filter(t => SCHEMAS[t.name])` 会把它筛掉，
 *     原生 function calling 根本看不见这个工具，模型「不知道有这个能力」；
 *   - 参数没进 schema：`additionalProperties: false`，模型想传也传不进来。
 * 两种都不报错，只是功能像没写一样。2026-09-18 给 search_customers 加
 * channelName / ownerName / decisionStatus 时就差点这么漏出去。
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@/lib/agent/tools";
import { SCHEMAS, 只读SCHEMAS } from "@/lib/agent/schemas";

/** 从 tools.ts 那串给人看的 args 样例里抠出参数名 */
const 样例参数 = (args: string) => [...args.matchAll(/"(\w+)"\s*:/g)].map((m) => m[1]);

describe("工具表 ↔ schema 表", () => {
  it("每个工具都有 schema——没有的话原生 function calling 里它是隐形的", () => {
    const 漏了 = TOOLS.filter((t) => !SCHEMAS[t.name]).map((t) => t.name);
    expect(漏了, `这些工具没进 SCHEMAS，模型看不见：${漏了.join("、")}`).toEqual([]);
  });

  it("schema 里也不该有已经删掉的工具", () => {
    const 名字 = new Set(TOOLS.map((t) => t.name));
    const 多余 = Object.keys(SCHEMAS).filter((n) => !名字.has(n));
    expect(多余, `SCHEMAS 里这些工具不存在了：${多余.join("、")}`).toEqual([]);
  });

  it("args 样例里写了的参数，schema 里都要有——否则模型传不进来", () => {
    const 问题: string[] = [];
    for (const t of TOOLS) {
      const schema = SCHEMAS[t.name];
      if (!schema) continue;
      const 声明 = new Set(Object.keys(schema.properties));
      for (const p of 样例参数(t.args)) if (!声明.has(p)) 问题.push(`${t.name}.${p}`);
    }
    expect(问题, `args 样例里有、schema 里没有（additionalProperties:false 会把它挡掉）：${问题.join("、")}`).toEqual([]);
  });

  it("反过来也对：schema 里声明了的，args 样例里要写出来给人看", () => {
    const 问题: string[] = [];
    for (const t of TOOLS) {
      const schema = SCHEMAS[t.name];
      if (!schema) continue;
      const 样例 = new Set(样例参数(t.args));
      for (const p of Object.keys(schema.properties)) if (!样例.has(p)) 问题.push(`${t.name}.${p}`);
    }
    expect(问题, `schema 里有、args 样例里没写：${问题.join("、")}`).toEqual([]);
  });

  it("MCP 开出去的只能是只读那几个——别把建议卡漏出去（别人的客户端里没有那张卡）", () => {
    for (const n of Object.keys(只读SCHEMAS)) expect(n.startsWith("propose_"), `${n} 不该在只读组里`).toBe(false);
  });
});
