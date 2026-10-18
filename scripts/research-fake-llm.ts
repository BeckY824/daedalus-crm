/**
 * 背调用的假模型：一个 OpenAI 兼容的 /chat/completions，按「这一步」给写好的回答（2026-10-16）。
 *
 * 为什么要它：背调要真把 本机服务 → 6 步编排 → 模型 → 通道（模拟搜索）→ 事件流 → 卡片 整条走一遍，
 * 拦浏览器那一跳（e2e/fake-llm.ts 的 假回答）只测得到卡片。真模型又慢又花钱、结果还会抖。
 * 所以模型换成这个：决策那步「先搜一次、认准那步再读官网、然后够了」，结论那步按提示词认出是哪一步、回固定 JSON。
 *
 * 两种用法：
 *   e2e：import { 起假模型 } 在 beforeAll 里起，设置页把 AI 接入指到它（走界面，见 fake-llm.ts 的 配好AI）
 *   本机看效果：npx tsx -e "import('./scripts/research-fake-llm.ts').then((m) => m.起假模型(3191, { 慢: 600 }))"，
 *              再在设置里把接口地址填 http://127.0.0.1:3191/v1（.claude/launch.json 的 research 就是这么起的）
 *   实验：scripts/research-bench.ts 的「模拟」模式也起它
 *
 * **放在 scripts/ 不放 e2e/**（10-18）：bench 在 scripts/ 下要引它，而镜像构建的上下文排掉了 e2e/（.dockerignore），
 * tsconfig 又会把 scripts/ 一起做类型检查——v0.46.19 的服务器镜像就挂在这儿（找不到 ../e2e/research-fake-llm）。
 * scripts/ 和 src/ 不许引 e2e/、tests/，tests/docker-context.test.ts 守着。
 */
import http from "node:http";

type 消息 = { role: string; content?: unknown };

const 结论 = (prompt: string): unknown => {
  // 只有人名 + 电话的「找公司」（person.ts）：认第一条带「Lumora」的搜索结果
  if (prompt.includes("最多 4 家")) {
    const 条 = [...prompt.matchAll(/^\[(\d+)\] (.+)$/gm)].find((m) => /Lumora/.test(m[2]));
    return { 候选: 条 ? [{ 公司: "Lumora Trading GmbH", 官网: "https://lumora-trading.example", 职位: "", 依据: "号码出现在名录里 Lumora Trading GmbH 的联系方式上", 来源: Number(条[1]) }] : [] };
  }
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
      联系人: [{ 岗位: "采购负责人", 姓名: "Jan Beispiel", 电话: "+49 40 0000 0000", 邮箱: "sales@${d}.example", 来源: `${官网}/about` }, { 岗位: "总经理", 姓名: "Max Erfunden", 来源: `${官网}/about` }],
      小结: "汉堡的照明进口分销商",
    };
  if (prompt.includes("对照我们的业务"))
    return { 型号: [{ 型号: "HB-150", 是什么: "工矿灯", 来源: `${官网}/about` }, { 型号: "SL-60", 是什么: "路灯", 来源: `${官网}/about` }, { 型号: "ZZ-999", 是什么: "原文里没有，该丢", 来源: `${官网}/about` }], 小结: "品类和买家类型都对口" };
  if (prompt.includes("找近期信号")) return { 信号: [{ text: "在招户外照明品类经理", source: `https://jobs.example/${d}-category-manager` }, { text: "参展 light+building 2026", source: `https://fair.example/light-building-2026/${d}` }], 小结: "在扩户外品类" };
  if (prompt.includes("排查风险")) return { 风险: [{ 级别: "low", 说明: "2024 年有一次 30 天付款延迟，已解决", 来源: `https://forum.example/t/${d}-payment` }], 必查: { 母公司: { 结论: "独立公司，商业登记上没有母公司", 级别: "none", 来源: `https://registry.example/${d}` }, 财务: { 结论: "查不到" }, 同行: { 结论: "只做进口分销，不自己生产", 是: "否", 级别: "none", 来源: `${官网}/about` }, 市场: { 结论: "在德奥瑞做生意，正在扩户外品类", 级别: "none", 来源: `${官网}/about` } }, 小结: "风险低" };
  // 最后一步（打分 + 切入建议，产品里固定 gpt-5.5）
  if (prompt.includes("怎么切入"))
    return {
      评档: [
        { 维度: "category", 档: "high", 证据: "主营户外和工业照明", 来源: `${官网}/about` },
        { 维度: "buyerType", 档: "high", 证据: "进口后卖给电气批发和工程商", 来源: `${官网}/about` },
        { 维度: "market", 档: "mid", 证据: "覆盖德奥瑞，需要 ENEC", 来源: `${官网}/about` },
        { 维度: "scale", 档: "mid", 证据: "约 40 人", 来源: `${官网}/about` },
        { 维度: "signals", 档: "high", 证据: "在招品类经理、参展", 来源: `https://jobs.example/${d}-category-manager` },
      ],
      像的老客户: [{ 编号: 1, 档: "mid", 像在哪: "都是做照明的分销商" }],
      建议: ["找新招的户外照明品类经理", "主推工矿灯和路灯，带 ENEC 证书", "提一句 light+building 展位上见"],
      型号对比: [{ 对方: "HB-150", 我们: "UFO 工矿灯 150W", 怎么比: "同功率，我们有 ENEC 版，交期 4–5 周" }, { 对方: "XX-1", 我们: "随便", 怎么比: "对方型号认不出，该丢" }],
      开发信: { 主题: "High-bay and street lights for your outdoor range", 正文: `Dear Mr Beispiel,\n\nI noticed that ${名} is hiring a Category Manager for Outdoor Lighting to expand its street-light and high-bay range. We are an LED lighting manufacturer in China supplying distributors in Germany, Austria and Switzerland with high-bay fixtures and street lights. Our range sits close to your HB-150 and SL-60, with ENEC and CE certified versions available, stable lead times of four to five weeks, and private-label packaging for wholesalers. Many of our distributor customers start with a small trial order to check quality before they list a product. If it is useful, I can send a sample of our closest high-bay model together with a price list for your volume range. Would you have fifteen minutes next week for a short call, or should I send the samples straight to your Hamburg office?\n\nBest regards,\nLi Wei` },
      小结: "从品类经理切入",
    };
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
      // 提示词的样子（run.ts）：系统 → 「背调对象 + 已有材料」→ 「这一步要做什么」（缓存友好：每步一样的放前面）。全拼起来认
      const 首问 = msgs.filter((m: 消息) => m.role === "user").map((m: 消息) => String(m.content ?? "")).join("\n");
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
