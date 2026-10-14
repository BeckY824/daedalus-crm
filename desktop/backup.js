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
const fs = require("node:fs");
const crypto = require("node:crypto");
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
    if (判定 !== "ok") {
      const error = new Error(`备份文件没通过完整性检查：${判定}`);
      error.code = "CRM_SQLITE_CORRUPT";
      throw error;
    }
    const { n } = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    return { 表数: Number(n) };
  } finally {
    db.close();
  }
}

/** Integrity alone also accepts an unrelated or empty SQLite file. Keep this compatible with old CRM schemas. */
function 校验CRM备份(文件) {
  const db = new DatabaseSync(文件, { readOnly: true });
  try {
    for (const [table, required] of [
      ["User", ["id", "email", "password", "name", "title", "role", "avatar", "active", "createdAt", "updatedAt"]],
      ["Customer", ["id", "name", "phone", "school", "grade", "major", "channelId", "referrerCustomerId", "attributionChannelId", "attributionCustomerId", "salesOwnerId", "channelOwnerId", "followStatus", "decisionStatus", "expectedSignAt", "lastFollowAt", "remark", "createdAt", "updatedAt"]],
    ]) {
      const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
      if (required.some(column => !columns.has(column))) throw new Error("这不是可识别的CRM备份：缺少基础用户或客户结构，请选择本应用生成的备份");
    }
  } finally { db.close(); }
}

/**
 * 把 源 备份到 目标。目标已存在会被覆盖（保存框已经问过了）。
 * 返回 { 表数 }。
 */
async function 备份数据库(源, 目标) {
  if (path.resolve(源) === path.resolve(目标)) throw new Error("备份不能存到原文件上");
  if (fs.existsSync(目标)) {
    const a = fs.statSync(源), b = fs.statSync(目标);
    if ((a.ino !== 0 && a.dev === b.dev && a.ino === b.ino) || fs.realpathSync(源) === fs.realpathSync(目标)) throw new Error("备份不能存到原文件上");
  }
  // 旧sidecar可能仍在被其他连接使用，不能擅自删除或把旧WAL重放到新备份。
  if (["-wal", "-shm"].some((tail) => fs.existsSync(`${目标}${tail}`))) throw new Error("目标旁还有数据库临时文件（WAL/SHM），请另选一个新的备份文件名");
  const 临时 = `${目标}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const src = new DatabaseSync(源, { readOnly: true });
  try {
    /*
      一步拷完（第二轮 C-6，当时只记了、没改上）：默认每批 100 页，批与批之间库一有写入就从头再来——
      边导入边备份时永远拷不完，按钮一直转到导入结束。WAL 下读不挡写，一步拷完本机实测几十毫秒。
      用 int32 上限而不是 -1：Electron 自带的 Node 可能只收正数
    */
    await backup(src, 临时, { rate: 2147483647 });
    fs.chmodSync(临时, 0o600);
    const dst = new DatabaseSync(临时);
    try {
      // 在线备份继承源库的WAL模式；转成单文件，后续只读校验也不会产生sidecar。
      dst.exec("PRAGMA journal_mode = DELETE");
    } finally { dst.close(); }
    const 结果 = 校验数据库(临时);
    fs.renameSync(临时, 目标);
    return 结果;
  } finally {
    src.close();
    for (const tail of ["", "-wal", "-shm"]) fs.rmSync(`${临时}${tail}`, { force: true });
  }
}

module.exports = { 建议文件名, 备份数据库, 校验数据库, 校验CRM备份 };
