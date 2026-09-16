/**
 * 崩溃与诊断：把主进程没接住的错误写进日志，并整理一段给人看 / 贴进 issue 的诊断信息。
 *
 * 上线前的判断：用户机器上炸了你不知道，他来报 bug 也说不清——这两件事都靠这里。
 * 不接第三方上报（Sentry 之类）：卖点是数据不出机器，先把「本地有日志、一键复制」做扎实。
 *
 * 不引 electron，能直接拿 node 测。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 错误对象整理成几行文字。不是 Error 的（有人 throw 字符串）也能处理 */
function 错误文本(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack || ""}`.trim();
  try {
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 追加一条到崩溃日志。同步写：进程可能马上就没了，不能等。
 * 写失败不抛——报错的路径上再抛一次只会把最后一点信息也弄丢。
 */
function 写崩溃日志(文件, 标题, e, 环境 = {}) {
  const 块 = [
    `==== ${new Date().toISOString()} ${标题} ====`,
    ...Object.entries(环境).map(([k, v]) => `${k}: ${v}`),
    错误文本(e),
    "",
  ].join("\n");
  try {
    fs.mkdirSync(path.dirname(文件), { recursive: true });
    fs.appendFileSync(文件, `${块}\n`);
  } catch {
    /* 见上 */
  }
  return 块;
}

/** 一段能直接贴进 issue 的环境信息。字段由调用方给，这里只负责排版 */
function 诊断信息(字段) {
  return Object.entries(字段)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** 日志最后几行，给对话框用 */
function 日志尾巴(文件, 行数 = 30) {
  try {
    return fs.readFileSync(文件, "utf8").trim().split("\n").slice(-行数).join("\n");
  } catch {
    return "";
  }
}

module.exports = { 写崩溃日志, 诊断信息, 错误文本, 日志尾巴 };
