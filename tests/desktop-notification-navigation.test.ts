import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
const require_ = createRequire(import.meta.url);
const { 创建通知出口 } = require_("../desktop/notifications.js");
const { 发送导航 } = require_("../desktop/navigation.js");
class Notice extends EventEmitter {
  static all: Notice[] = [];
  static isSupported() { return true; }
  constructor(_options: unknown) { super(); Notice.all.push(this); }
  show = vi.fn(() => this.emit("show"));
  close = vi.fn(() => this.emit("close"));
}
beforeEach(() => { vi.useFakeTimers(); Notice.all = []; });
afterEach(() => { vi.useRealTimers(); });
it("横幅 close 后操作中心点击仍有效；点击一次后释放原生通知", () => {
  const click = vi.fn(); const center = 创建通知出口({ Notification: Notice, 取上下文: () => 'qa-a' });
  center.发({ title: 'QA提醒' }, click);
  const n = Notice.all[0]; n.emit('close'); vi.advanceTimersByTime(10_000); n.emit('click'); n.emit('click');
  expect(click).toHaveBeenCalledTimes(1); expect(n.close).toHaveBeenCalledTimes(1); center.清空();
});
it("切换账号后的旧通知不跳转，清空和到期也会关闭系统通知", () => {
  let context = 'qa-a'; const click = vi.fn();
  const center = 创建通知出口({ Notification: Notice, 取上下文: () => context, 保留毫秒: 1000 });
  center.发({ title: 'QA旧账号' }, click); context = 'qa-b'; Notice.all[0].emit('click');
  expect(click).not.toHaveBeenCalled(); expect(Notice.all[0].close).toHaveBeenCalledTimes(1);
  center.发({ title: 'QA新账号' }, click); vi.advanceTimersByTime(1000); Notice.all[1].emit('click');
  expect(click).not.toHaveBeenCalled(); expect(Notice.all[1].close).toHaveBeenCalledTimes(1);
  center.发({ title: 'QA待清空' }, click); center.清空(); expect(Notice.all[2].close).toHaveBeenCalledTimes(1);
});
it("通知失败、容量限制和导航异常均可收尾；日志不含标题正文或异常中的资料", async () => {
  const events: unknown[] = []; const center = 创建通知出口({ Notification: Notice, 取上下文: () => 'qa', 最多: 1, 记事件: (e: unknown) => events.push(e) });
  center.发({ title: 'QA私有客户', body: '13900009991' }, () => { throw Error('13900009991'); });
  center.发({ title: 'QA第二条' }, async () => { throw Error('QA私有资料'); });
  expect(Notice.all[0].close).toHaveBeenCalledTimes(1); Notice.all[1].emit('click'); await Promise.resolve();
  center.发({ title: 'QA失败' }, () => {}); Notice.all[2].emit('failed', {}, 'QA私有资料');
  expect(Notice.all[2].close).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(events)).toContain('navigation-failed');
  expect(JSON.stringify(events)).not.toMatch(/13900009991|QA私有/); center.清空();
});
function navigation() {
  const ipcMain = new EventEmitter(); const wc = Object.assign(new EventEmitter(), { send: vi.fn() });
  const fallback = vi.fn(); let valid = true;
  const go = (route = '/follow-ups/plans') => { 发送导航({ ipcMain, webContents: wc, 路径: route, 仍有效: () => valid, 兜底: fallback }); return wc.send.mock.lastCall![2]; };
  return { ipcMain, wc, fallback, go, invalidate: () => { valid = false; } };
}
it("仅同一窗口、同一请求的确认可取消导航兜底", () => {
  const n = navigation(); const id = n.go();
  n.ipcMain.emit('nav:ok', { sender: {} }, id); n.ipcMain.emit('nav:ok', { sender: n.wc }, 'wrong');
  vi.advanceTimersByTime(400); expect(n.fallback).toHaveBeenCalledTimes(1); expect(n.ipcMain.listenerCount('nav:ok')).toBe(0);
  const next = n.go(); n.ipcMain.emit('nav:ok', { sender: n.wc }, next); vi.advanceTimersByTime(400);
  expect(n.fallback).toHaveBeenCalledTimes(1); expect(n.wc.listenerCount('destroyed')).toBe(0);
});
it("并发导航不误收旧应答；换账号或窗口销毁后不执行延迟跳转", () => {
  const n = navigation(); const first = n.go('/settings'); n.go();
  n.ipcMain.emit('nav:ok', { sender: n.wc }, first); vi.advanceTimersByTime(400); expect(n.fallback).toHaveBeenCalledTimes(1);
  n.go(); n.invalidate(); vi.advanceTimersByTime(400); expect(n.fallback).toHaveBeenCalledTimes(1);
  n.go(); n.wc.emit('destroyed'); vi.advanceTimersByTime(400); expect(n.ipcMain.listenerCount('nav:ok')).toBe(0);
});
it("真实 preload 在页面跳转回调抛错时不应答；成功后回传导航请求编号", async () => {
  const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(), send: vi.fn(), sendSync: () => false });
  const exposed: Record<string, unknown> = {};
  const source = fs.readFileSync(path.resolve('desktop/preload-app.js'), 'utf8');
  vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (name: string, v: unknown) => { exposed[name] = v; } }, ipcRenderer }), process: { platform: 'darwin' }, window: { addEventListener() {} }, document: { documentElement: { classList: { toggle() {} } } } });
  const nav = exposed.desktopNav as { onGo: (cb: () => void) => () => void };
  const off = nav.onGo(() => { throw Error('QA failed navigation'); });
  ipcRenderer.emit('nav:go', {}, '/settings', 'qa-first'); await Promise.resolve(); expect(ipcRenderer.send).not.toHaveBeenCalled(); off();
  nav.onGo(() => {}); ipcRenderer.emit('nav:go', {}, '/follow-ups/plans', 'qa-second'); await Promise.resolve();
  expect(ipcRenderer.send).toHaveBeenCalledWith('nav:ok', 'qa-second');
});
