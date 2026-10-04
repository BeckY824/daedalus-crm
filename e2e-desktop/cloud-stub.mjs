/**
 * 桌面端 e2e 的假云端（从 ~/CRM/xhs/2026-09-tutorial/cloud-stub.mjs 改来）。
 *
 * 本地模式离不开云端：登录页要问 policy、设置页要问余额、AI 走云端的模型网关、团队同步走云端中转。
 * e2e 不该依赖网络，更不该花真钱，所以全部给固定回答——**模型网关不转发**，
 * 原版那份会把请求转到真的中转站，这里只回一句写死的话，并且记账：
 * 「AI 不自动跑」那条用例要靠 /__stub/stats 确认一次都没被叫到。
 *
 * 用法：CLOUD_PORT=3301 node e2e-desktop/cloud-stub.mjs（playwright.desktop.config.ts 的第一个 webServer）
 */
import http from "node:http";

const PORT = Number(process.env.CLOUD_PORT) || 3301;

/** 每个路径被叫了几次。用例读它、也可以清零 */
let 次数 = {};
let 用掉 = 0;

/**
 * 团队同步那条用例要的「中转」：成员名单由用例在开始前 POST /__stub/team 放进来。
 * 没放就是「没有团队」——同步一轮推拉都回空，对角色时什么也不改。
 */
let 团队 = null;

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    let body = "";
    for await (const c of req) body += c;
    if (!p.startsWith("/__stub")) 次数[p] = (次数[p] ?? 0) + 1;

    // ---------- 给用例的后门 ----------
    if (p === "/" || p === "/__stub/health") return json(res, 200, { ok: true });
    if (p === "/__stub/stats") return json(res, 200, 次数);
    if (p === "/__stub/reset") {
      次数 = {};
      return json(res, 200, { ok: true });
    }
    if (p === "/__stub/team") {
      团队 = req.method === "DELETE" ? null : JSON.parse(body || "null");
      return json(res, 200, { ok: true });
    }

    // ---------- 账号 ----------
    if (p === "/api/account/policy") return json(res, 200, { register: true, reset: true, inApp: true });
    if (p === "/api/account/token") {
      return req.method === "DELETE"
        ? json(res, 200, { ok: true })
        : json(res, 200, { token: "dk_e2e_device_token", account: { id: "acc_e2e", name: "林小雨", contact: "xiaoyu@example.com" }, credits: { 还剩: 30 - 用掉 } });
    }
    if (p === "/api/account/code" || p === "/api/account/password" || p === "/api/account/code/check") return json(res, 200, { ok: true });
    if (p === "/api/account/signup/start") return json(res, 409, { registered: true });

    // ---------- 模型网关：不转发，只回一句 ----------
    if (p === "/api/gateway/v1/models") return json(res, 200, { data: [{ id: "e2e-model", note: "默认" }] });
    if (p === "/api/gateway/v1/credits") return json(res, 200, { 上限: 30, 用掉, 还剩: 30 - 用掉 });
    if (p === "/api/gateway/v1/chat/completions") {
      用掉++;
      const j = JSON.parse(body || "{}");
      const 话 = "（e2e 假云端的固定回答）";
      if (j.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: 话 } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      return json(res, 200, { choices: [{ index: 0, message: { role: "assistant", content: 话 }, finish_reason: "stop" }] });
    }

    // ---------- 团队同步中转 ----------
    // 推拉一律收下 / 回空，**不回「不在这个团队」**：那句话会让业务员那台自动退出团队、只留自己的客户（被移出后收拾），
    // 用例收尾时顺序稍一错开就把别人的测试数据删了
    if (p === "/api/sync/push") return json(res, 200, { ok: true });
    if (p === "/api/sync/pull") return json(res, 200, { batches: [], more: false, epoch: 0 });
    if (p === "/api/sync/team") return json(res, 200, { teams: 团队 ? [团队] : [] });

    json(res, 404, { error: `stub: ${p}` });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[cloud-stub] :${PORT}`));
