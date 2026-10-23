"use strict";
/**
 * 商机 / 订单的附件「用系统程序打开」（2026-10-22 D-24）。
 *
 * 文件在数据目录 attachments/<编号>，没有扩展名（原名在库里）。系统得靠扩展名挑程序，
 * 所以拷一份到临时目录 DaedalusCRM-附件/<编号>/<原名> 再打开——原件不让别的程序改。
 *
 * 页面只传编号和名字：编号只许字母数字（挡 ../），名字去掉路径和 Windows 不认的字符。
 * 能跑的文件（.exe .bat .sh …）不替人双击，只在文件夹里选中它。
 * 临时目录里一天前的副本，下次打开附件时顺手删掉。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const 编号样子 = /^[a-z0-9]{8,40}$/i;

const 能跑的 = new Set([
  "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "reg", "jar",
  "py", "pyw", "msc", "appref-ms", "application", "scf", "chm", "vb", "ws", "wsc", "settingcontent-ms", "library-ms",
  // 双击会挂载成一个盘，里面的东西就没有「来自网络」的标记了
  "iso", "img", "vhd", "vhdx",
  "app", "command", "sh", "bash", "zsh", "csh", "pkg", "mpkg", "dmg", "workflow", "action", "terminal", "url", "webloc", "inetloc",
  "scpt", "scptd", "applescript", "prefpane",
]);

const 一天 = 24 * 60 * 60 * 1000;

/**
 * 给临时副本用的名字：去路径、去控制字符和 Windows 不许的字符、截到 120 字、去结尾的点和空格；空了就叫「附件」。
 * 先截再去结尾：反过来的话截完结尾又可能是空格（「a….exe .x」截成「a….exe 」），
 * 判扩展名时是 "exe "、不算能跑的，Windows 打开时却把空格去了，等于运行了 .exe
 */
function 安全文件名(名) {
  const 去路径 = String(名 ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const 干净 = 去路径.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").slice(0, 120).trim().replace(/[. ]+$/, "");
  const 名字 = 干净 || "附件";
  // CON、NUL、COM1… 在 Windows 上建不出来
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(名字) ? `_${名字}` : 名字;
}

function 是能跑的(名) {
  // 结尾的点和空格 Windows 打开时会去掉，判断时也去掉（安全文件名 已经去过，这里再挡一次）
  const 实名 = 名.replace(/[. ]+$/, "");
  const i = 实名.lastIndexOf(".");
  return i >= 0 && 能跑的.has(实名.slice(i + 1).toLowerCase());
}

/** 删掉临时根下一天前的副本目录；只认编号样子的目录，删不掉就算了 */
function 清旧副本(临时根, 留, 现在 = Date.now()) {
  let 项;
  try {
    项 = fs.readdirSync(临时根, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of 项) {
    if (!e.isDirectory() || e.name === 留 || !编号样子.test(e.name)) continue;
    const 目录 = path.join(临时根, e.name);
    try {
      if (现在 - fs.statSync(目录).mtimeMs > 一天) fs.rmSync(目录, { recursive: true, force: true });
    } catch {
      // 别的程序还开着它（Windows 会锁），下次再删
    }
  }
}

/**
 * 拷到临时目录、交给系统。shell 传进来（Electron 的 shell：openPath / showItemInFolder），方便测。
 * 回 { ok } 或 { ok: false, error: 一句人话 }
 */
async function 打开附件({ 数据目录, id, 名, shell, 临时根 = path.join(os.tmpdir(), "DaedalusCRM-附件") }) {
  if (!数据目录) return { ok: false, error: "还没有本机数据" };
  if (typeof id !== "string" || !编号样子.test(id)) return { ok: false, error: "找不到这个附件" };
  const 原件 = path.join(数据目录, "attachments", id);
  if (!fs.existsSync(原件)) return { ok: false, error: "文件不在这台电脑上" };
  清旧副本(临时根, id);
  const 文件名 = 安全文件名(名);
  const 目录 = path.join(临时根, id);
  const 副本 = path.join(目录, 文件名);
  try {
    fs.mkdirSync(目录, { recursive: true });
    // 上次打开过、被别的程序改过也不管：每次都按原件重拷
    fs.copyFileSync(原件, 副本);
  } catch (e) {
    return { ok: false, error: `没能准备文件：${e?.message ?? e}` };
  }
  if (是能跑的(文件名)) {
    shell.showItemInFolder(副本);
    return { ok: true, 只显示: true };
  }
  const 错 = await shell.openPath(副本);
  return 错 ? { ok: false, error: `系统没能打开：${错}` } : { ok: true };
}

module.exports = { 打开附件, 安全文件名, 是能跑的, 清旧副本 };
