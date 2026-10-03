/**
 * 桌面端 MCP 固定端口那座桥（desktop/mcp-bridge.js）。
 *
 * 0.46.15 第 7 块：「连接服务器」模式下原来照样转给本机服务——本机服务在跑时，Claude Code 问「团队里有几个客户」，
 * 答的是这台电脑上的**个人库**；本机服务没起时回 502「本地服务没在跑」，人看不懂为什么。
 * 现在连着服务器就直接说清楚，不转。
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const 桥 = require("../desktop/mcp-bridge.js") as {
  start: (o: { 取端口: () => number | null; dataDir?: string; 连着服务器?: () => string | null }) => Promise<number | null>;
  stop: () => Promise<void>;
};

let 假本机: http.Server | null = null;
afterEach(async () => {
  await 桥.stop();
  await new Promise<void>((r) => (假本机 ? 假本机.close(() => r()) : r()));
  假本机 = null;
});

async function 起假本机(): Promise<number> {
  假本机 = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { 来自: "本机个人库" } }));
  });
  await new Promise<void>((r) => 假本机!.listen(0, "127.0.0.1", () => r()));
  return (假本机.address() as { port: number }).port;
}

function 问(端口: number, 路径 = "/api/mcp"): Promise<{ 状态: number; 体: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 端口, path: 路径, method: "POST", agent: false, headers: { "content-type": "application/json" } }, (res) => {
      let 体 = "";
      res.on("data", (c) => (体 += c));
      res.on("end", () => resolve({ 状态: res.statusCode ?? 0, 体 }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

describe("MCP 桥", () => {
  it("本机模式：原样转给本机服务", async () => {
    const 本机 = await 起假本机();
    const p = await 桥.start({ 取端口: () => 本机, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mcp-")) });
    expect(p).toBeTruthy();
    const r = await 问(p!);
    expect(r.状态).toBe(200);
    expect(r.体).toContain("本机个人库");
  });

  it("连着服务器：不转（本机服务在跑也不转），说清现在连着哪、怎么查团队那份", async () => {
    const 本机 = await 起假本机();
    let 服务器: string | null = "http://192.168.1.20:3000";
    const p = await 桥.start({ 取端口: () => 本机, 连着服务器: () => 服务器 });
    const r = await 问(p!);
    expect(r.状态).toBe(409);
    expect(r.体).not.toContain("本机个人库");
    const 错 = JSON.parse(r.体).error;
    expect(错.message).toContain("http://192.168.1.20:3000");
    expect(错.message).toContain("设置 → AI 接入");
    // 切回本机数据：桥不用重启，下一次就照常转
    服务器 = null;
    expect((await 问(p!)).体).toContain("本机个人库");
  });

  it("别的路径一律 404", async () => {
    const p = await 桥.start({ 取端口: () => null });
    expect((await 问(p!, "/api/customers")).状态).toBe(404);
  });
});
