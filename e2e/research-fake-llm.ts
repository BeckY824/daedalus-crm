/**
 * 背调用的假模型：一个 OpenAI 兼容的 /chat/completions，按「这一步」给写好的回答（2026-10-16）。
 *
 * 为什么要它：背调要真把 本机服务 → 6 步编排 → 模型 → 通道（模拟搜索）→ 事件流 → 卡片 整条走一遍，
 * 拦浏览器那一跳（e2e/fake-llm.ts 的 假回答）只测得到卡片。真模型又慢又花钱、结果还会抖。
 * 所以模型换成这个：决策那步「先搜一次、认准那步再读官网、然后够了」，结论那步按提示词认出是哪一步、回固定 JSON。
 *
 * 两种用法：
 *   e2e：import { 起假模型 } 在 beforeAll 里起，设置页把 AI 接入指到它（走界面，见 fake-llm.ts 的 配好AI）
 *   本机看效果：npx tsx -e "import('./e2e/research-fake-llm.ts').then((m) => m.起假模型(3191, { 慢: 600 }))"，
 *              再在设置里把接口地址填 http://127.0.0.1:3191/v1（.claude/launch.json 的 research 就是这么起的）
 */
import http from "node:http";

type 消息 = { role: string; content?: unknown };

const 结论 = (prompt: string): unknown => {
  const 名 = prompt.match(/背调对象：(.+)/)?.[1]?.trim() ?? "Company";
  const d = 名.toLowerCase().replace(/\b(gmbh|ltd|limited|inc|llc|co|corp|ag|plc)\b\.?/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
  const 官网 = `https://${d}.example`;
  if (prompt.includes("认准是哪一家")) return { 认准: true, 官网: `${官网}/about`, 国家城市: "德国·汉堡", 说明: "官网和商业登记对上了", 来源: `https://registry.example/${d}` };
  if (prompt.includes("查基本面"))
    return {
      字段: {
        founded: { value: "2009 年", source: `https://registry.example/${d}` },
        size: { value: "约 40 人", source: `${官网}/about` },
        business: { value: "户外 / 工业 LED 照明分销", source: `${官网}/about` },
        buyerType: { value: "进口分销商", source: `${官网}/about` },
        contact: { value: `sales@${d}.example`, source: `${官网}/about` },
      },
      小结: "汉堡的照明进口分销商",
    };
  if (prompt.includes("对照我们的业务"))
    return {
      评档: [
        { 维度: "category", 档: "high", 证据: "主营户外和工业照明", 来源: `${官网}/about` },
        { 维度: "buyerType", 档: "high", 证据: "进口后卖给电气批发和工程商", 来源: `${官网}/about` },
        { 维度: "market", 档: "mid", 证据: "覆盖德奥瑞，需要 ENEC", 来源: `${官网}/about` },
        { 维度: "scale", 档: "mid", 证据: "约 40 人", 来源: `${官网}/about` },
      ],
      像的老客户: [{ 编号: 1, 档: "mid", 像在哪: "都是做照明的分销商" }],
      小结: "品类和买家类型都对口",
    };
  if (prompt.includes("找近期信号")) return { 信号: [{ text: "在招户外照明品类经理", source: `https://jobs.example/${d}-category-manager` }, { text: "参展 light+building 2026", source: `https://fair.example/light-building-2026/${d}` }], 档: "high", 证据: "在招品类经理、参展", 小结: "在扩户外品类" };
  if (prompt.includes("排查风险")) return { 风险: [{ 级别: "low", 说明: "2024 年有一次 30 天付款延迟，已解决", 来源: `https://forum.example/t/${d}-payment` }], 小结: "风险低" };
  if (prompt.includes("怎么切入")) return { 建议: ["找新招的户外照明品类经理", "主推工矿灯和路灯，带 ENEC 证书", "提一句 light+building 展位上见"], 小结: "从品类经理切入" };
  return {};
};

function 回(res: http.ServerResponse, message: Record<string, unknown>, usage = { prompt_tokens: 1200, completion_tokens: 120 }) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "fake", object: "chat.completion", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage }));
}

export function 起假模型(port = 0, { 慢 = 0 } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
      }
      let body: { messages?: 消息[]; tools?: unknown[] } = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* 当空请求 */
      }
      if (慢) await new Promise((r) => setTimeout(r, 慢));
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const 首问 = String(msgs[1]?.content ?? "");
      if (Array.isArray(body.tools) && body.tools.length) {
        const 交回 = msgs.filter((m: 消息) => m.role === "tool").length;
        const 名 = 首问.match(/背调对象：(.+)/)?.[1]?.trim() ?? "Company";
        if (交回 === 0) return 回(res, { role: "assistant", content: "先搜公司全名", tool_calls: [{ id: `c${Date.now()}`, type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: `"${名}" hiring fair` }) } }] });
        if (交回 === 1 && 首问.includes("认准是哪一家")) {
          const d = 名.toLowerCase().replace(/\b(gmbh|ltd|limited|inc|llc|co|corp|ag|plc)\b\.?/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          return 回(res, { role: "assistant", content: "读官网", tool_calls: [{ id: `c${Date.now()}`, type: "function", function: { name: "read_page", arguments: JSON.stringify({ url: `https://${d}.example/about` }) } }] });
        }
        return 回(res, { role: "assistant", content: "够了" });
      }
      return 回(res, { role: "assistant", content: JSON.stringify(结论(首问)) });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const p = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${p}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
