import { 列工具, 跑工具 } from "./tools";

/**
 * MCP 的 JSON-RPC 处理。传输那一层（HTTP）在 api/mcp/route.ts，这里只管消息。
 *
 * 只实现**工具**这一块能力：initialize / tools/list / tools/call / ping。
 * 不做 resources、prompts、sampling——我们要交出去的就是那九个只读查询，
 * 多实现一样就多一样要长期对得上的协议面。
 *
 * 为什么是我们自己写而不是拿官方 SDK：这一层加起来不到一百行，
 * 而 SDK 会把一套传输、会话、能力协商的抽象带进桌面端的打包体积里。
 * 真到了要做 sampling / resources 那天再换不迟。
 */

/** 跟着客户端走：它报哪个版本我们就回哪个，认不出来的回我们支持的那个 */
const 支持的协议 = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type 请求 = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
export type 回应 = { jsonrpc: "2.0"; id: string | number | null; result: unknown } | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const 结果 = (id: 请求["id"], result: unknown): 回应 => ({ jsonrpc: "2.0", id: id ?? null, result });
const 出错 = (id: 请求["id"], code: number, message: string): 回应 => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function 处理(req: 请求, who: { id: string; name: string }, 版本: string): Promise<回应 | null> {
  switch (req.method) {
    case "initialize": {
      const 想要 = String((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion ?? "");
      return 结果(req.id, {
        protocolVersion: 支持的协议.includes(想要) ? 想要 : 支持的协议[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "daedalus-crm", version: 版本 },
        // 客户端会把这段显示给用户看，说清这把钥匙能干什么、不能干什么
        instructions:
          "这是一个 CRM 的只读接口：查客户、渠道、线索、商机、跟进记录和业务指标。" +
          "它写不了任何东西——要记一笔、改状态、排计划，请到 Daedalus CRM 里操作。" +
          "数据在这台机器上，不经过我们的服务器。",
      });
    }

    // 通知没有 id，也不该回任何东西
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return 结果(req.id, {});

    case "tools/list":
      return 结果(req.id, { tools: 列工具() });

    case "tools/call": {
      const p = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof p.name === "string" ? p.name : "";
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = await 跑工具(name, args, who);
        return 结果(req.id, {
          content: [{ type: "text", text: JSON.stringify(r, null, 1) }],
          structuredContent: r,
          isError: false,
        });
      } catch (e) {
        /*
          工具自己出的错回成 isError 的**结果**，不是 JSON-RPC 的 error：
          协议里那个 error 表示「这条消息没法处理」，而「客户不存在」是一个
          模型应该看见并据此改口的答案。回成协议错误的话，对面只会说「工具坏了」。
        */
        return 结果(req.id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : "调用失败" }],
          isError: true,
        });
      }
    }

    default:
      return 出错(req.id, -32601, `不支持的方法：${req.method}`);
  }
}
