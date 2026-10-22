"use strict";
/**
 * 商机 / 订单的附件「用系统程序打开」（2026-10-22 D-24）。
 *
 * 文件在数据目录 attachments/<编号>，没有扩展名（原名在库里）。系统得靠扩展名挑程序，
 * 所以拷一份到临时目录 DaedalusCRM-附件/<编号>/<原名> 再打开——原件不让别的程序改。
 *
 * 页面只传编号和名字：编号只许字母数字（挡 ../），名字去掉路径和 Windows 不认的字符。
 * 能跑的文件（.exe .bat .sh …）不替人双击，只在文件夹里选中它。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const 编号样子 = /^[a-z0-9]{8,40}$/i;

const 能跑的 = new Set([
  "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "reg", "jar",
  "app", "command", "sh", "bash", "zsh", "csh", "pkg", "dmg", "workflow", "terminal", "url", "webloc", "inetloc",
]);

/** 给临时副本用的名字：去路径、去控制字符和 Windows 不许的字符、去结尾的点和空格；空了就叫「附件」 */
function 安全文件名(名) {
  const 去路径 = String(名 ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const 干净 = 去路径.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/[. ]+$/, "").trim();
  const 名字 = (干净 || "附件").slice(0, 120);
  // CON、NUL、COM1… 在 Windows 上建不出来
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(名字) ? `_${名字}` : 名字;
}

function 是能跑的(名) {
  const i = 名.lastIndexOf(".");
  return i >= 0 && 能跑的.has(名.slice(i + 1).toLowerCase());
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

module.exports = { 打开附件, 安全文件名, 是能跑的 };
