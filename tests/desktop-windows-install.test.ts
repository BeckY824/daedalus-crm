import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const { 启动安装 } = createRequire(import.meta.url)("../desktop/windows-install.js");

it("只启动哈希匹配的安装程序，带空格的路径不经过 shell", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm 更新 "));
  const file = path.join(dir, "setup.exe");
  fs.writeFileSync(file, "fake installer");
  const sha256 = crypto.createHash("sha256").update("fake installer").digest("hex");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawn = vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  try {
    await expect(启动安装({ 文件: file, sha256: "0".repeat(64), 启动: spawn })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    await 启动安装({ 文件: file, sha256, 启动: spawn });
    expect(spawn).toHaveBeenCalledWith(file, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
    expect(child.unref).toHaveBeenCalledOnce();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("缺少哈希不执行安装程序", async () => {
  const spawn = vi.fn();
  await expect(启动安装({ 文件: "setup.exe", 启动: spawn })).rejects.toThrow("SHA-256");
  expect(spawn).not.toHaveBeenCalled();
});
