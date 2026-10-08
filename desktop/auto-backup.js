/**
 * 本机库的自动备份（2026-10-04，回归核对 D-078 / J-242；用户拍板的样子）：
 *
 *   每天第一次启动拷一份      backups/daily-YYYY-MM-DD.db              留最近 7 份
 *   升级（版本号变了）先拷一份  backups/before-upgrade-<旧>-to-<新>.db   留最近 3 份
 *   从备份恢复之前先拷一份      backups/before-restore-YYYY-MM-DD-HHmm.db 留最近 3 份
 *
 * 为什么要有：桌面端的数据只在这台电脑上一个 SQLite 文件里，盘坏、误删、一次坏迁移就整份没了，
 * 而原来只有设置页里一个要人记得去点的「备份数据库…」。迁移失败时服务起不来，连那个按钮都进不去。
 *
 * 由 server-entry.js 在**跑迁移之前**调用（那时还没有别的连接在写），用 VACUUM INTO 拷：
 * 拷出来是一个一致、独立、已压实的库，WAL 里还没回写的也在里面。
 * **备份失败绝不挡启动**——只记日志。挡住了等于为了保护数据让人用不了数据。
 *
 * 文件名用 ASCII：用户会把这个文件夹拷来拷去、发给我们，中文名在一些压缩工具和网盘里会乱码。
 * 不引 electron，能直接拿 node 测（tests/desktop-auto-backup.test.ts）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const 目录名 = "backups";
const 版本记号 = ".last-version";
const 留几份 = { daily: 7, "before-upgrade": 3, "before-restore": 3 };

const 备份目录 = (数据目录) => path.join(数据目录, 目录名);
const 两位 = (n) => String(n).padStart(2, "0");
const 日期 = (d) => `${d.getFullYear()}-${两位(d.getMonth() + 1)}-${两位(d.getDate())}`;
const 时分 = (d) => `${两位(d.getHours())}${两位(d.getMinutes())}`;
const 安全版本 = (v) => String(v).replace(/[^0-9A-Za-z.-]/g, "_");

/** 用 VACUUM INTO 拷一份。目标已存在就不拷（同一天第二次启动） */
function 拷(库, 目标) {
  if (fs.existsSync(目标)) return false;
  const db = new DatabaseSync(库, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${目标.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return true;
}

/** 这个库里有没有值得保护的东西：一个客户、线索、跟进都没有的新库，拷 7 份空库只会让恢复列表变吵 */
function 有数据(库) {
  const db = new DatabaseSync(库, { readOnly: true });
  try {
    for (const t of ["Customer", "Lead", "FollowUp", "Contact"]) {
      try {
        if (Number(db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n) > 0) return true;
      } catch {
        /* 很老的库可能没有某张表 */
      }
    }
    return false;
  } finally {
    db.close();
  }
}

/** 同一类只留最近 N 份。按文件名里的日期 / 版本排不可靠，按修改时间排 */
function 修剪(目录, 前缀) {
  const 份 = fs
    .readdirSync(目录)
    .filter((f) => f.startsWith(`${前缀}-`) && f.endsWith(".db"))
    .map((f) => ({ f, t: fs.statSync(path.join(目录, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of 份.slice(留几份[前缀])) fs.rmSync(path.join(目录, f), { force: true });
}

/**
 * 启动时调一次。返回这次拷了哪几份（给日志和测试看），从不抛。
 * @param {{ 库: string, 数据目录: string, 版本?: string, 现在?: Date, 日志?: (行: string) => void }} o
 */
function 自动备份({ 库, 数据目录, 版本, 现在 = new Date(), 日志 = (行) => console.log(行) }) {
  const 拷了 = [];
  try {
    if (!fs.existsSync(库) || fs.statSync(库).size === 0) return 拷了;
    const 目录 = 备份目录(数据目录);
    fs.mkdirSync(目录, { recursive: true });

    // 升级前：记号里的版本和这次不一样。没有记号 = 第一次跑有这功能的版本，只记下、不当升级（那一天的每日备份照样会拷）
    const 记号文件 = path.join(目录, 版本记号);
    const 上次 = fs.existsSync(记号文件) ? fs.readFileSync(记号文件, "utf8").trim() : "";
    if (版本 && 上次 && 上次 !== 版本) {
      const f = path.join(目录, `before-upgrade-${安全版本(上次)}-to-${安全版本(版本)}.db`);
      if (拷(库, f)) 拷了.push(path.basename(f));
      修剪(目录, "before-upgrade");
    }
    if (版本 && 上次 !== 版本) fs.writeFileSync(记号文件, 版本);

    if (有数据(库)) {
      const f = path.join(目录, `daily-${日期(现在)}.db`);
      if (拷(库, f)) 拷了.push(path.basename(f));
      修剪(目录, "daily");
    }
    if (拷了.length) 日志(`[备份] 自动备份：${拷了.join("、")}`);
  } catch (e) {
    日志(`[备份] 自动备份没做成（不影响启动）：${e?.message ?? e}`);
  }
  return 拷了;
}

/** 设置页列出来用。新的在前 */
function 列出(数据目录) {
  const 目录 = 备份目录(数据目录);
  if (!fs.existsSync(目录)) return [];
  return fs
    .readdirSync(目录)
    .filter((f) => /^(daily|before-upgrade|before-restore)-.+\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(目录, f));
      const 类型 = f.startsWith("daily-") ? "每天" : f.startsWith("before-upgrade-") ? "升级前" : "恢复前";
      return { 文件名: f, 类型, 时间: st.mtime.toISOString(), 大小: st.size };
    })
    .sort((a, b) => (a.时间 < b.时间 ? 1 : -1));
}

/**
 * 从一份自动备份恢复。**调用方必须先停掉本地服务**（main.js 的 从自动备份恢复）。
 * 先验那份备份能用、再把当前库另存成 before-restore-…，再换进去，最后删掉旧的 -wal / -shm——
 * 不删的话下次打开会把旧 WAL 重放到换进来的库上（设置页手动恢复的说明里也写着这一步，2026-10-02 D1）。
 */
function 恢复({ 库, 数据目录, 文件名, 现在 = new Date(), 校验 }) {
  if (!/^(daily|before-upgrade|before-restore)-[0-9A-Za-z._-]+\.db$/.test(String(文件名))) throw new Error("不认识这份备份");
  const 目录 = 备份目录(数据目录);
  const 源 = path.join(目录, 文件名);
  if (!fs.existsSync(源)) throw new Error("这份备份已经不在了");
  校验(源); // 坏的备份不换进去：宁可不恢复，也不把好库换成坏库
  const 临时库 = `${库}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.restore.tmp`;
  let 另存 = null;
  try {
    // 先准备独立快照并校验，再原子替换；不直接覆盖正在保护的原库。
    拷(源, 临时库);
    fs.chmodSync(临时库, 0o600);
    校验(临时库);
    if (fs.existsSync(库) && fs.statSync(库).size > 0) {
      另存 = path.join(目录, `before-restore-${日期(现在)}-${时分(现在)}.db`);
      拷(库, 另存); // 同一分钟恢复两次：已有那份不覆盖，保留第一次恢复前的样子
      修剪(目录, "before-restore");
    }
    // 配置在库外。先重置检查点，再换库：即使换库中断，也只会安全地重拉当前库。
    // 先完成原子写，写不成就拒绝恢复，不能留下旧游标配旧数据库。
    const 团队文件 = path.join(数据目录, ".team.json");
    if (fs.existsSync(团队文件)) {
      const 团队 = JSON.parse(fs.readFileSync(团队文件, "utf8"));
      if (!团队.teamId || !团队.key || !团队.device) throw new Error("团队配置损坏，请先修复后再恢复备份");
      const 临时文件 = `${团队文件}.${process.pid}.restore.tmp`;
      try {
        fs.writeFileSync(临时文件, JSON.stringify({ ...团队, pulled: 0 }), { mode: 0o600 });
        fs.chmodSync(临时文件, 0o600);
        fs.renameSync(临时文件, 团队文件);
      } finally {
        fs.rmSync(临时文件, { force: true });
      }
    }
    // 当前库先把真实WAL回写。换包失败时旧库仍包含全部已提交数据。
    if (fs.existsSync(库)) {
      const old = new DatabaseSync(库);
      try {
        const result = old.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (Number(result?.busy) !== 0) throw new Error("数据库仍被占用，请退出其他应用窗口后重试恢复");
      } finally { old.close(); }
    }
    for (const 尾 of ["-wal", "-shm"]) fs.rmSync(`${库}${尾}`, { force: true });
    fs.renameSync(临时库, 库);
  } finally {
    for (const tail of ["", "-wal", "-shm"]) fs.rmSync(`${临时库}${tail}`, { force: true });
  }

  return { 另存: 另存 && path.basename(另存) };
}

module.exports = { 自动备份, 列出, 恢复, 备份目录 };
