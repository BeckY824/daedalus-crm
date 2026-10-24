// 【我方用】数据卷指纹：在 crm 容器里用 node --experimental-sqlite 跑（tools/restore-drill.sh 调）。
// 每行一项，两次输出 diff 为空 = 数据一模一样：
//   integrity <结果>                 PRAGMA integrity_check
//   schema <sha256>                   表、索引、触发器的定义
//   table <表名> <行数> <sha256>       整张表的内容
//   file <路径> <字节数> <sha256>      /data 下数据库以外的文件（附件、会话密钥等）
// 表内容按「每行一个哈希、排序后再哈希」算：VACUUM INTO（备份用它）会给没有 INTEGER PRIMARY KEY
// 的表重排 rowid、行的物理顺序也可能变，按 rowid 排序比会误报；内容一样就该一样。
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const val = (v) =>
  v instanceof Uint8Array ? { blob: Buffer.from(v).toString("base64") }
  : typeof v === "bigint" ? { int: v.toString() }
  : v;

const D = process.env.DATA_DIR || "/data"; // 本机试跑时指到别处
const db = new DatabaseSync(`${D}/crm.db`, { readOnly: true });
const out = [];
out.push("integrity " + db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]).join(","));
out.push("schema " + sha(JSON.stringify(
  db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
)));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
for (const { name } of tables) {
  const st = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
  st.setReadBigInts(true);
  const hs = [];
  for (const row of st.iterate()) hs.push(sha(JSON.stringify(Object.entries(row).map(([k, v]) => [k, val(v)]))));
  hs.sort();
  out.push(`table ${name} ${hs.length} ${sha(hs.join("\n"))}`);
}
db.close();

const skip = new Set(["crm.db", "crm.db-wal", "crm.db-shm", "restore-tmp"]);
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    const rel = path.relative(D, p);
    // 和 backup.sh 的排除项一致：数据库另算，pre-rebuild-* 是重建前的旧库、不进备份
    if (dir === D && (skip.has(e.name) || e.name.startsWith("pre-rebuild-"))) continue;
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) {
      const b = fs.readFileSync(p);
      out.push(`file ${rel} ${b.length} ${sha(b)}`);
    }
  }
};
walk(D);
process.stdout.write(out.join("\n") + "\n");
