import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
const require_ = createRequire(import.meta.url);
const { 解析激活, 创建激活入口, 转交激活, 通知XML } = require_("../desktop/windows-toast-activation.js");
const { 创建通知出口 } = require_("../desktop/notifications.js");
const sockets = fs.mkdtempSync(path.join(os.tmpdir(), "crm-toast-"));
const 取管道名 = (id: string) => process.platform === "win32" ? `\\\\.\\pipe\\crm-test-${id}` : path.join(sockets, id);
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of close.splice(0)) await c(); });
async function broker() {
  const b = await 创建激活入口({ 取管道名 }); close.push(() => b.关闭()); return b;
}
it("只收严格的一次性 URI，不接受目标路径、参数、用户信息或其他协议", () => {
  const uri = `daedalus-crm-notify://${randomUUID()}/${randomUUID()}`;
  expect(解析激活(["app.exe", uri])).toBeTruthy();
  for (const bad of [uri + "/settings", uri + "?route=/customers", uri + "#secret", uri.replace("://", "://x@"), uri.replace("notify:", "evil:"), "file:///data", uri.replace(/\/[a-f0-9-]+$/, "/..")]) expect(解析激活([bad])).toBeNull();
  const xml = 通知XML({ title: '<QA & "客户">', body: "13900009991 & <test>", silent: true }, uri);
  expect(xml).toContain('activationType="protocol"'); expect(xml).toContain(`launch="${uri}"`);
  expect(xml).toContain('&lt;QA &amp; &quot;客户&quot;&gt;'); expect(xml).not.toContain('<test>');
});
it("真实 IPC 只回到原实例，单次消费；伪造和取消的编号均无效", async () => {
  const a = await broker(), b = await broker(); const clickA = vi.fn(), clickB = vi.fn();
  const one = a.登记(clickA), two = b.登记(clickB);
  expect(await 转交激活([one.uri], { 取管道名 })).toBe(true);
  expect(clickA).toHaveBeenCalledTimes(1); expect(clickB).not.toHaveBeenCalled();
  expect(await 转交激活([one.uri], { 取管道名 })).toBe(false);
  const p = 解析激活([two.uri]);
  expect(await 转交激活([`daedalus-crm-notify://${p.instance}/${randomUUID()}`], { 取管道名 })).toBe(false);
  two.取消(); expect(await 转交激活([two.uri], { 取管道名 })).toBe(false);
});
class Notice extends EventEmitter {
  static all: Notice[] = []; static isSupported() { return true; }
  constructor(public options: { toastXml: string }) { super(); Notice.all.push(this); }
  show() {} close = vi.fn();
}
it("横幅消失后协议激活仍能导航；换账号/清空/到期使原入口失效", async () => {
  const b = await broker(); let context = 'qa-a'; const click = vi.fn();
  const center = 创建通知出口({ Notification: Notice, 取上下文: () => context, 取激活入口: () => b, 保留毫秒: 200 });
  const send = () => { center.发({ title: 'QA' }, click); const n = Notice.all.at(-1)!; return { n, uri: /launch="([^"]+)"/.exec(n.options.toastXml)![1] }; };
  const one = send(); one.n.emit('close');
  expect(await 转交激活([one.uri], { 取管道名 })).toBe(true); one.n.emit('click'); expect(click).toHaveBeenCalledTimes(1);
  const stale = send(); context = 'qa-b'; await 转交激活([stale.uri], { 取管道名 }); expect(click).toHaveBeenCalledTimes(1);
  const cleared = send(); center.清空(); expect(await 转交激活([cleared.uri], { 取管道名 })).toBe(false);
  const expired = send(); await new Promise(r => setTimeout(r, 230)); expect(await 转交激活([expired.uri], { 取管道名 })).toBe(false);
  expect(click).toHaveBeenCalledTimes(1);
});
it("入口不可用时明确失败，不展示一个不能点击的成功通知", () => {
  const before = Notice.all.length;
  expect(创建通知出口({ Notification: Notice, 取上下文: () => 'qa', 取激活入口: () => null }).发({ title: 'QA' })).toMatchObject({ ok: false });
  expect(Notice.all).toHaveLength(before);
});
it("协议辅助进程在读取默认数据根/取得单实例锁之前转发并退出", async () => {
  const source = fs.readFileSync(path.resolve('desktop/main.js'), 'utf8');
  const transfer = vi.fn(async () => true), exit = vi.fn();
  const req = vi.fn((id: string) => {
    if (id === 'electron') return { app: { exit } };
    if (id === './windows-toast-activation') return { 协议: 'daedalus-crm-notify', 转交激活: transfer };
    throw Error(`Unexpected main initialization: ${id}`);
  });
  vm.runInNewContext(`(function(require,process){${source}\n})`, {})(req, { platform: 'win32', argv: ['app.exe', `daedalus-crm-notify://${randomUUID()}/${randomUUID()}`] });
  await Promise.resolve(); await Promise.resolve(); expect(transfer).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(0);
  expect(req.mock.calls.map(c => c[0])).toEqual(['electron', './windows-toast-activation']);
});
