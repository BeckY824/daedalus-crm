/**
 * r2-ai 异常路径测试的公共台子：**桌面端本地服务 → 我们的网关 → 上游模型**，三段在同一个进程里接起来。
 *
 * 为什么要整条接起来，而不是各测各的：
 *   桌面端用户看到的那句话、被扣了几次，是三段一起决定的——
 *   上游回什么 → 网关扣不扣、退不退、回什么状态码和正文 → 本地 llm.ts 重试几次、把哪句话交给界面。
 *   单测网关只知道「回了 502」，单测 llm.ts 只知道「收到 502」，中间那一段（重试几次各扣不扣）只有接起来才看得见。
 *
 * 做法：
 *   - 本地这一侧是真的：DESKTOP_LOCAL=1、CRM_DATA_DIR 下放一份 .cloud.json，llm.ts 读它拿令牌和网关地址
 *   - 网关这一侧也是真的：fetch 打到 `${云}/api/gateway/v1/*` 时，直接在进程里调路由的 POST / GET
 *     （控制面库是临时建的 SQLite；网关认证那一下要 MULTI_TENANT=1，只在同步那一小段里打开，
 *       免得本地这侧的 prisma 也被当成托管版去解析工作区）
 *   - 上游是假的：由每条用例自己写剧本
 *   - 不调任何真实模型、真实云端
 */
import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const 云 = "http://cloud.test";
export const 上游 = "https://relay.example.com/v1";

/** 建一份空的控制面库（账号、设备令牌、AI 次数账本都在里面） */
export function 建控制库(根: string) {
  fs.mkdirSync(根, { recursive: true });
  process.env.CONTROL_DATABASE_URL = `file:${path.join(根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(根, "control.db"), ddl], { stdio: "pipe" });
}

export function 网关环境() {
  process.env.GATEWAY_API_KEY = "upstream-key";
  process.env.GATEWAY_BASE_URL = 上游;
  process.env.GATEWAY_MODELS = "deepseek-v4.1-flash";
}

let 序号 = 0;
/** 建一个账号、签一枚设备令牌、按「在这台机器上登录过」结掉注册赠送（和 tests/gateway.test.ts 同一套） */
export async function 建账号带令牌() {
  const { createAccount } = await import("@/lib/tenant/accounts");
  const { 签发 } = await import("@/lib/tenant/device-token");
  const { 结算赠送 } = await import("@/lib/tenant/credits");
  const 第几个 = 序号++;
  const acc = await createAccount({
    target: { kind: "phone", value: `1371${String(process.pid % 1000).padStart(3, "0")}${String(第几个).padStart(4, "0")}` },
    password: "abcd1234",
    name: "桌面用户",
  });
  const { token, id } = await 签发(acc.id, "测试 Mac");
  const 机器 = createHash("sha256").update(`r2-ai:${process.pid}:${第几个}`).digest("hex");
  await 结算赠送({ kind: "account", id: acc.id }, 机器);
  return { acc, token, tokenId: id, owner: { kind: "account" as const, id: acc.id } };
}

/** 这个账号到现在一共被扣了几次（不看「还剩」：扣的时候会顺带补每日赠送，还剩会被抬高） */
export async function 用掉(accountId: string): Promise<number> {
  const { 用掉次数 } = await import("@/lib/tenant/credits");
  return 用掉次数({ kind: "account", id: accountId });
}

/** 装一台「已登录」的桌面端：数据目录里放 .cloud.json。返回目录，用完自己删 */
export function 装桌面端(凭据: Record<string, unknown> | string): string {
  const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-ai-desk-"));
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 目录;
  process.env.CRM_CLOUD_URL = 云;
  fs.writeFileSync(path.join(目录, ".cloud.json"), typeof 凭据 === "string" ? 凭据 : JSON.stringify(凭据, null, 2));
  return 目录;
}

export function 拆桌面端(目录?: string) {
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  delete process.env.CRM_CLOUD_URL;
  if (目录) fs.rmSync(目录, { recursive: true, force: true });
}

export const 标准凭据 = (token: string, extra: Record<string, unknown> = {}) => ({
  baseUrl: 云,
  token,
  accountId: "acc",
  name: "桌面用户",
  contact: "me@example.com",
  models: ["deepseek-v4.1-flash"],
  loggedAt: new Date().toISOString(),
  ...extra,
});

/* ---------------- 上游剧本里用的几种回应 ---------------- */

export const 回JSON = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

/** 一次普通回答（content） */
export const 回文本 = (content: string, extra: Record<string, unknown> = {}) =>
  回JSON({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop", ...extra }], usage: { prompt_tokens: 10, completion_tokens: 10 } });

let 调用号 = 0;
/** 一次原生工具调用 */
export const 回工具 = (calls: { name: string; args?: unknown; raw?: string }[], content: string | null = "") =>
  回JSON({
    choices: [{
      message: {
        role: "assistant",
        content,
        tool_calls: calls.map((c) => ({ id: `call_${++调用号}`, type: "function", function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) } })),
      },
      finish_reason: "tool_calls",
    }],
  });

/** 流式回答。`断在` 给了就在吐完前 N 段之后让流出错（模拟中转站 / 网络中途断开） */
export function 回流(段: string[], 断在?: number): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (断在 !== undefined && i >= 断在) {
        controller.error(new TypeError("terminated"));
        return;
      }
      if (i >= 段.length) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 段[i++] } }] })}\n\n`));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 上游收到的一次请求 */
export type 上游请求 = { body: Record<string, unknown>; 第几次: number };
export type 上游剧本 = (r: 上游请求) => Response | Promise<Response>;

export type 线路 = {
  /** 上游实际被打了几次、每次收到了什么 */
  上游: 上游请求[];
  /** 桌面端打到网关的每一次（chat/completions），带着哪个问题编号 */
  网关: { url: string; questionId: string | null; feature: string | null; status?: number }[];
};

/**
 * 把三段接起来。
 *   上游剧本：上游怎么回
 *   云断网：返回 true 时，打到云端（网关）的请求直接抛 TypeError（和断网时 undici 的表现一样）
 */
export function 接线(opts: { 上游: 上游剧本; 云断网?: () => boolean; 云端回?: (url: string) => Response | null }): 线路 {
  const 线: 线路 = { 上游: [], 网关: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    // 和真 fetch 一样：地址不合法直接抛 TypeError
    new URL(url);
    if (init.signal?.aborted) throw init.signal.reason;

    if (url.startsWith(上游)) {
      const r = { body: JSON.parse(String(init.body ?? "{}")), 第几次: 线.上游.length + 1 };
      线.上游.push(r);
      return opts.上游(r);
    }
    if (url.startsWith(云)) {
      if (opts.云断网?.()) throw new TypeError("fetch failed");
      const 特 = opts.云端回?.(url);
      if (特) return 特;
      const headers = new Headers(init.headers);
      const req = new Request(url, { method: init.method ?? "GET", headers, body: init.body as BodyInit | undefined });
      const 记 = url.includes("/chat/completions")
        ? 线.网关[线.网关.push({ url, questionId: headers.get("x-question-id"), feature: headers.get("x-feature") }) - 1]
        : null;
      const 处理: ((r: Request) => Promise<Response>) | null = url.includes("/api/gateway/v1/chat/completions")
        ? (await import("@/app/api/gateway/v1/chat/completions/route")).POST
        : url.includes("/api/gateway/v1/models")
          ? (await import("@/app/api/gateway/v1/models/route")).GET
          : url.includes("/api/gateway/v1/credits")
            ? (await import("@/app/api/gateway/v1/credits/route")).GET
            : null;
      // 网关认证只在同步那一小段读 MULTI_TENANT：在那一段里打开，立刻关回去
      const 原 = process.env.MULTI_TENANT;
      process.env.MULTI_TENANT = "1";
      let p: Promise<Response>;
      try {
        p = 处理 ? 处理(req) : Promise.resolve(new Response("not found", { status: 404 }));
      } finally {
        if (原 === undefined) delete process.env.MULTI_TENANT;
        else process.env.MULTI_TENANT = 原;
      }
      // 客户端超时 / 中断：客户端这边立刻抛，网关那边照样跑完（真实世界也是这样）
      const 等 = init.signal
        ? Promise.race([
            p,
            new Promise<never>((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason), { once: true })),
          ])
        : p;
      const res = await 等;
      if (记) 记.status = res.status;
      return res;
    }
    throw new TypeError(`fetch failed（测试里没接这个地址：${url}）`);
  });
  return 线;
}

/**
 * 判断一句给人看的话是不是「中文人话」：有中文；没有原始 JSON、英文报错、协议字眼。
 * 允许出现的英文只有产品里本来就这么叫的（AI、API Key、Excel）和模型名。
 */
export function 是人话(s: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(s)) return false;
  if (/[{}"]|gateway_error|Unexpected token|is not valid JSON|fetch failed|terminated|Cannot read|undefined|TypeError|SyntaxError|DSML/i.test(s)) return false;
  const 去掉许可的 = s.replace(/deepseek[\w.-]*|glm[\w.-]*|API Key|Excel|AI/g, "");
  return !/[A-Za-z]{4,}/.test(去掉许可的);
}

export const 等一下 = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 像首页对话框那样问一句：走真的 /api/ai/stream 路由，把它推给浏览器的事件流原样收回来。
 * `屏幕` 是按 token / reset 事件拼出来的、用户最后在屏幕上看到的那段字。
 */
export async function 问AI(question: string, extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/ai/stream/route");
  const res = await POST(
    new Request("http://127.0.0.1/api/ai/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "agent", question, ...extra }),
    }),
  );
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, "")) as Record<string, unknown> & { type: string });
  const result = events.find((e) => e.type === "result") as
    | { type: "result"; ok: true; answer: { text: string; proposals: { kind: string; customerId: string }[] } }
    | { type: "result"; ok: false; error: string }
    | undefined;
  let 屏幕 = "";
  for (const e of events) {
    if (e.type === "token") 屏幕 += String(e.text);
    if (e.type === "reset") 屏幕 = "";
  }
  return { events, result, 屏幕, steps: events.filter((e) => e.type === "step") };
}

/** 上游剧本的小工具：按请求的种类分开（带 tools 的决策步 / 流式的最终回答 / 其余是 JSON 协议） */
export const 种类 = (r: 上游请求): "决策" | "回答" | "JSON" => (r.body.tools ? "决策" : r.body.stream ? "回答" : "JSON");
