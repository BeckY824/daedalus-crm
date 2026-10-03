/**
 * Mac 上「看得见壁纸」的那种毛玻璃（2026-10-02，照 MonoCode 的做法，它是 MIT 的）。
 *
 * 系统自带的 vibrancy（sidebar / under-window 那几种材质）模糊得很重，壁纸透过来只剩一片灰白——
 * 用户看了说「不够透」。MonoCode 的办法是：窗口本身全透明，再调 WindowServer 的私有接口
 * CGSSetWindowBackgroundBlurRadius 给窗口背后设一个小一点的模糊半径，壁纸的颜色和轮廓都还在，
 * 页面上再用半透明底色压一层保证字看得清。
 *
 * 私有接口随时可能在某一版 macOS 上没了：这里任何一步拿不到（koffi 没装上、符号找不到、
 * 窗口号读不出）都返回 false，main.js 据此退回系统 vibrancy——最多是没那么透，不会坏。
 * Windows 不走这里（那边是 acrylic）。
 */
let 接口 = undefined;

function 取接口() {
  if (接口 !== undefined) return 接口;
  接口 = null;
  if (process.platform !== "darwin") return 接口;
  try {
    const koffi = require("koffi");
    // 这两个符号由 CoreGraphics 转出（实现在 SkyLight），AppKit 进程里本来就加载着
    const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
    const 连接 = cg.func("int CGSMainConnectionID()");
    const 设半径 = cg.func("int CGSSetWindowBackgroundBlurRadius(int, int, int)");
    接口 = { 连接, 设半径 };
  } catch {
    接口 = null;
  }
  return 接口;
}

/** 这台机器能不能用：能就建透明窗口，不能就照旧 vibrancy */
function 可用() {
  return 取接口() !== null;
}

/** 窗口号：getMediaSourceId() 形如 "window:12345:0"，中间那段就是 CGWindowID（= NSWindow.windowNumber） */
function 窗口号(win) {
  const m = /^window:(\d+):/.exec(win.getMediaSourceId?.() ?? "");
  return m ? Number(m[1]) : 0;
}

/** 设模糊半径；0 = 不模糊。成没成都不抛 */
function 设模糊(win, 半径) {
  const api = 取接口();
  if (!api || !win || win.isDestroyed()) return false;
  try {
    const 号 = 窗口号(win);
    const 连 = api.连接();
    if (!号 || !连) return false;
    return api.设半径(连, 号, Math.max(0, Math.min(64, Math.round(半径)))) === 0;
  } catch {
    return false;
  }
}

module.exports = { 可用, 设模糊 };
