/**
 * 桌面端本地服务尽量每次用同一个端口（desktop/local-server.js 拿端口，2026-10-02 排查桌面端 A1）。
 * localStorage 按 origin（含端口）存：原来每次随机端口，外观、列表列、选的模型、栏宽每次重启都回默认。
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import Module from "node:module";

// local-server.js 顶上 require("electron")；测试里只要 拿端口，给它一个空壳
const 原load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (req: unknown, ...rest: unknown[]) {
  if (req === "electron") return { utilityProcess: {} };
  return 原load.call(this, req, ...rest);
};
const { 拿端口 } = Module.createRequire(import.meta.url)("../desktop/local-server.js");
afterAll(() => {
  (Module as unknown as { _load: unknown })._load = 原load;
});

describe("拿端口", () => {
  it("旧端口被 Windows 保留而 EACCES：自动分配并保存可用端口", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-reserved-port-"));
    fs.writeFileSync(path.join(dir, ".port"), "58502");
    const denied = new EventEmitter() as net.Server;
    denied.unref = () => denied;
    denied.listen = (() => {
      queueMicrotask(() => denied.emit("error", Object.assign(new Error("reserved port"), { code: "EACCES" })));
      return denied;
    }) as net.Server["listen"];
    const spy = vi.spyOn(net, "createServer").mockReturnValueOnce(denied);
    try {
      const port = await 拿端口(dir);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(Number(fs.readFileSync(path.join(dir, ".port"), "utf8"))).toBe(port);
      expect(await 拿端口(dir)).toBe(port);
      const live = net.createServer();
      await new Promise<void>((resolve, reject) => { live.once("error", reject); live.listen(port, "127.0.0.1", resolve); });
      await new Promise<void>(resolve => live.close(() => resolve()));
    } finally { spy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it(".port 文件本身 EACCES：保留旧文件并拒绝，不能掩盖为端口恢复", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-port-permission-"));
    const file = path.join(dir, ".port");
    fs.writeFileSync(file, "58502");
    const original = fs.accessSync;
    const access = vi.spyOn(fs, "accessSync").mockImplementation((p, mode) => {
      if (p === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(p, mode);
    });
    const listen = vi.spyOn(net, "createServer");
    try {
      await expect(拿端口(dir)).rejects.toThrow(/端口配置不可写/);
      expect(listen).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, "utf8")).toBe("58502");
    } finally { access.mockRestore(); listen.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("第一次随机一个并记下；下次还是它；被占了换一个新的再记下", async () => {
    const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-port-"));
    const 一 = await 拿端口(目录);
    expect(Number(fs.readFileSync(path.join(目录, ".port"), "utf8"))).toBe(一);
    expect(await 拿端口(目录)).toBe(一);

    const 占着 = net.createServer();
    await new Promise<void>((r) => 占着.listen(一, "127.0.0.1", () => r()));
    const 二 = await 拿端口(目录);
    expect(二).not.toBe(一);
    expect(Number(fs.readFileSync(path.join(目录, ".port"), "utf8"))).toBe(二);
    await new Promise<void>((r) => 占着.close(() => r()));
    fs.rmSync(目录, { recursive: true, force: true });
  });
});
