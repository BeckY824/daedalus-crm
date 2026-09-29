import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const { 启动安装, 记安装中, 安装进行中, 进程活着 } = createRequire(import.meta.url)("../desktop/windows-install.js");

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

/*
  整包静默安装的一两分钟里屏幕上什么都没有。2026-09-29 Sam 在这时点开了应用：程序文件写了一半，本地服务找不到 next，
  弹框里点「改用服务器」进了托管版——掉登录、每页从香港加载。现在启动安装程序时记下进程号，应用启动先看它。
*/
it("启动安装程序时记下「正在装哪一版、进程号」，应用启动时凭它认出安装还没完", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm 更新 "));
  const 更新目录 = path.join(dir, "updates");
  const file = path.join(dir, "setup.exe");
  fs.writeFileSync(file, "fake installer");
  const sha256 = crypto.createHash("sha256").update("fake installer").digest("hex");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 4321 });
  const spawn = vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  try {
    await 启动安装({ 文件: file, sha256, 更新目录, 版本: "0.46.12", 启动: spawn });
    const 在跑 = 安装进行中(更新目录, { 活着: (pid: number) => pid === 4321 });
    expect(在跑).toMatchObject({ 版本: "0.46.12", pid: 4321 });
    // 安装程序退出了：记录作废，而且顺手删掉，下次启动不再问
    expect(安装进行中(更新目录, { 活着: () => false })).toBeNull();
    expect(fs.existsSync(path.join(更新目录, "installing.json"))).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("没传更新目录（老调用方式）照常启动，不写记录", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-"));
  const file = path.join(dir, "setup.exe");
  fs.writeFileSync(file, "x");
  const sha256 = crypto.createHash("sha256").update("x").digest("hex");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 1 });
  const spawn = vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  try {
    await 启动安装({ 文件: file, sha256, 启动: spawn });
    expect(fs.readdirSync(dir)).toEqual(["setup.exe"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("太旧的记录不算数：进程号会被系统复用，正常安装没有 15 分钟那么久", () => {
  const 更新目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-"));
  try {
    记安装中(更新目录, { 版本: "0.46.12", pid: 99, 现在: 1_000_000 });
    const 活着 = () => true;
    expect(安装进行中(更新目录, { 活着, 现在: 1_000_000 + 14 * 60 * 1000 })).not.toBeNull();
    expect(安装进行中(更新目录, { 活着, 现在: 1_000_000 + 16 * 60 * 1000 })).toBeNull();
    expect(fs.existsSync(path.join(更新目录, "installing.json"))).toBe(false);
  } finally { fs.rmSync(更新目录, { recursive: true, force: true }); }
});

it("没有记录、记录读不懂、进程号不像样：都当作没在装", () => {
  const 更新目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-"));
  const 活着 = () => true;
  try {
    expect(安装进行中(更新目录, { 活着 })).toBeNull();
    fs.writeFileSync(path.join(更新目录, "installing.json"), "{半截");
    expect(安装进行中(更新目录, { 活着 })).toBeNull();
    fs.writeFileSync(path.join(更新目录, "installing.json"), JSON.stringify({ 版本: "x", pid: 0, at: Date.now() }));
    expect(安装进行中(更新目录, { 活着 })).toBeNull();
  } finally { fs.rmSync(更新目录, { recursive: true, force: true }); }
});

it("进程活着：自己算活着，一个肯定不存在的进程号不算", () => {
  expect(进程活着(process.pid)).toBe(true);
  expect(进程活着(2 ** 22 + 12345)).toBe(false);
});
