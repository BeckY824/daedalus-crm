/**
 * 备份本地数据库。
 *
 * 不能直接 cp：本地服务开着库、走的是 WAL，拷走的 crm.db 可能缺最近的写入，
 * 甚至打不开。用 SQLite 自己的在线备份 API（node:sqlite 的 backup()），
 * 它会和正在写的进程协调锁，拷出来的是一个一致的、独立的库文件。
 *
 * 备份完再打开一次做 integrity_check——用户点了「备份」就应该拿到一个确定能用的文件，
 * 而不是一个"应该没问题"的文件。
 *
 * 不引 electron，能直接拿 node 测。
 */
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

/** 备份文件名带日期时间，连着备几次不会互相覆盖 */
function 建议文件名(现在 = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `DaedalusCRM-备份-${现在.getFullYear()}-${p(现在.getMonth() + 1)}-${p(现在.getDate())}-${p(现在.getHours())}${p(现在.getMinutes())}.db`;
}

/** 打开一个库只读地验一遍，坏了就抛。返回里面有几张表，给提示用 */
function 校验数据库(文件) {
  const db = new DatabaseSync(文件, { readOnly: true });
  try {
    const 结果 = db.prepare("PRAGMA integrity_check").all();
    const 判定 = 结果.map((r) => Object.values(r)[0]).join("; ");
    if (判定 !== "ok") throw new Error(`备份文件没通过完整性检查：${判定}`);
    const { n } = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    return { 表数: Number(n) };
  } finally {
    db.close();
  }
}

/**
 * 把 源 备份到 目标。目标已存在会被覆盖（保存框已经问过了）。
 * 返回 { 表数 }。
 */
async function 备份数据库(源, 目标) {
  if (path.resolve(源) === path.resolve(目标)) throw new Error("备份不能存到原文件上");
  const src = new DatabaseSync(源, { readOnly: true });
  try {
    await backup(src, 目标);
  } finally {
    src.close();
  }
  return 校验数据库(目标);
}

module.exports = { 建议文件名, 备份数据库, 校验数据库 };
