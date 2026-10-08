import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import Module from "node:module";
const M = Module as unknown as { _load: (...a: unknown[]) => unknown };
const old = M._load;
const utilityProcess = { fork: vi.fn() };
M._load = function (req: unknown, ...rest: unknown[]) { return req === "electron" ? { utilityProcess } : old.call(this, req, ...rest); };
const local = Module.createRequire(import.meta.url)("../desktop/local-server.js");
afterAll(() => { M._load = old; });
let root: string;
const servers: http.Server[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-local-start-")); });
afterEach(async () => {
  await local.stop();
  vi.unstubAllEnvs(); utilityProcess.fork.mockReset();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true });
});
const account = (name: string) => { const d = path.join(root, "accounts", name); fs.mkdirSync(d, { recursive: true }); return d; };
const listen = async (reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
  const s = http.createServer(reply); servers.push(s);
  await new Promise<void>((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", r); });
  return (s.address() as { port: number }).port;
};
it("D-028 拷贝账号.port也不能复用另一账号的origin", async () => {
  const a = account("a"); const b = account("b");
  const pa = await local.拿端口(a, { portRoot: root }); fs.copyFileSync(path.join(a, ".port"), path.join(b, ".port"));
  const pb = await local.拿端口(b, { portRoot: root }); expect(pb).not.toBe(pa);
  expect(await local.拿端口(a, { portRoot: root })).toBe(pa); expect(await local.拿端口(b, { portRoot: root })).toBe(pb);
});
it("D-028 并发分配同根账号要保留不同端口", async () => {
  const dirs = Array.from({ length: 12 }, (_, i) => account(String(i)));
  const ports = await Promise.all(dirs.map((d) => local.拿端口(d, { portRoot: root })));
  expect(new Set(ports).size).toBe(dirs.length);
});
it("D-029 .port是目录时明确拒绝，不给无法保存的随机端口", async () => {
  fs.mkdirSync(path.join(root, ".port")); await expect(local.拿端口(root)).rejects.toThrow(/端口|目录|权限/);
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("D-029 即使老端口可用，只读数据目录仍提前拒绝", async () => {
  const p = await local.拿端口(root); fs.chmodSync(root, 0o500);
  await expect(local.拿端口(root)).rejects.toThrow(/目录|权限|写/); expect(Number(fs.readFileSync(path.join(root, ".port"), "utf8"))).toBe(p);
});
it("端口被其他HTTP服务抢走，任意200响应不能算本次CRM就绪", async () => {
  const p = await listen((_req, res) => { res.end("fake login"); });
  await expect(local.等就绪(p, Date.now() + 80, "qa-token", () => true)).rejects.toThrow(/身份|超时/);
});
it("只接受本次启动令牌的摘要，且不把自动登录令牌发给抢占者", async () => {
  const token = crypto.randomBytes(24).toString("hex"); const hash = crypto.createHash("sha256").update(token).digest("hex");
  const p = await listen((req, res) => {
    expect(req.url).toBe("/api/desktop/ready"); expect(JSON.stringify(req.headers)).not.toContain(token);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ instance: hash }));
  });
  await expect(local.等就绪(p, Date.now() + 1000, token, () => true)).resolves.toBeUndefined();
});
it("就绪路由仅在桌面本机开启，不暴露自动登录令牌", async () => {
  const { GET } = await import("@/app/api/desktop/ready/route");
  const req = new Request("http://127.0.0.1:1234/api/desktop/ready");
  vi.stubEnv("DESKTOP_LOCAL", ""); vi.stubEnv("DESKTOP_TOKEN", "qa-token"); expect((await GET(req)).status).toBe(404);
  vi.stubEnv("DESKTOP_LOCAL", "1"); expect((await GET(new Request("http://evil.example/api/desktop/ready"))).status).toBe(404);
  const response = await GET(req); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ instance: crypto.createHash("sha256").update("qa-token").digest("hex") });
});

function fakeChild(wrong: boolean) {
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }> = [];
  utilityProcess.fork.mockImplementation((_entry, _args, { env }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }); children.push(child);
    const server = http.createServer((_req, res) => { res.end(JSON.stringify({ instance: wrong ? "wrong-process" : crypto.createHash("sha256").update(env.DESKTOP_TOKEN).digest("hex") })); });
    servers.push(server); server.listen(Number(env.PORT), "127.0.0.1");
    child.kill.mockImplementation(() => { server.close(() => child.emit("exit", 0)); });
    return child;
  });
  return children;
}
function startArgs() {
  const bundleDir = path.join(root, "bundle"); fs.mkdirSync(bundleDir); fs.writeFileSync(path.join(bundleDir, "entry.js"), "// QA stub");
  const dataDir = account("a"); return { bundleDir, dataDir, portRoot: root, logFile: path.join(root, "logs", "test.log") };
}
it("真实start生命周期验证所属子进程，再返回登录令牌并正常关闭", async () => {
  const children = fakeChild(false); const result = await local.start(startArgs());
  expect(result.token).toMatch(/^[a-f0-9]{48}$/); expect(local.运行中()).toBe(true);
  await local.stop(); expect(children[0].kill).toHaveBeenCalledOnce(); expect(local.运行中()).toBe(false);
});
it("真实start遇到错误服务身份要终止子进程，不返回登录地址", async () => {
  const children = fakeChild(true); await expect(local.start(startArgs())).rejects.toThrow(/身份不匹配/);
  expect(children[0].kill).toHaveBeenCalledOnce(); expect(local.运行中()).toBe(false);
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("真实start对只读目录在启动子进程前拒绝", async () => {
  fakeChild(false); const args = startArgs(); fs.chmodSync(args.dataDir, 0o500);
  try { await expect(local.start(args)).rejects.toThrow(/目录不可写/); expect(utilityProcess.fork).not.toHaveBeenCalled(); }
  finally { fs.chmodSync(args.dataDir, 0o700); }
});
