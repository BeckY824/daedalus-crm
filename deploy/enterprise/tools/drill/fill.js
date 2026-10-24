/* eslint-disable @typescript-eslint/no-require-imports -- 经 stdin 交给 node - 跑，只能是 CommonJS */
// 【我方用，只在 CI / 测试机演练时用，别在客户服务器上跑】往库里每张表灌演练数据，再在 /data 下放几个附件样的文件。
// 在 crm 容器里用 node --experimental-sqlite 跑（tools/restore-drill.sh --fill 调）。
// 目的是让「逐表比对」每张表都有东西可比，并带上容易在备份恢复里出岔子的值：
// 中日韩文字和 emoji、引号和换行、NULL、64KB 的长文本、二进制、上 MB 的文件、中文文件名。
// 不按业务规则造数据（外键、枚举都不管），所以灌完的库只用来比对，不用来点页面。
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");

const D = process.env.DATA_DIR || "/data"; // 本机试跑时指到别处
const ROWS = Number(process.env.DRILL_ROWS || 30);
const db = new DatabaseSync(`${D}/crm.db`);
db.exec("PRAGMA foreign_keys = OFF");
db.exec("PRAGMA busy_timeout = 10000");

const 长文本 = "长".repeat(64 * 1024);
const 文本 = (t, c, i) =>
  i === 0 ? 长文本
  : i === 1 ? `演练 ${t}.${c} #${i} 😀🚀 "双引号" '单引号' \\反斜杠\n第二行\t制表`
  : `drill-${t}-${c}-${i}`;

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
let 表 = 0, 行 = 0;
const 空表 = [];
for (const { name: t } of tables) {
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
  const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
  const st = db.prepare(sql);
  let n = 0;
  db.exec("BEGIN");
  for (let i = 0; i < ROWS; i++) {
    const vals = cols.map((c) => {
      const ty = String(c.type || "").toUpperCase();
      const intPk = c.pk && /INT/.test(ty);
      if (intPk) return null; // 让 SQLite 自己编号
      // 允许空的列每隔几行放 NULL（主键、必填列不放）
      if (!c.notnull && !c.pk && i % 5 === 4) return null;
      if (/BOOL/.test(ty)) return i % 2;
      if (/DATE|TIME/.test(ty)) return Date.now() - i * 86400000;
      if (/INT/.test(ty)) return 1000 + i;
      if (/REAL|FLOA|DOUB|DEC|NUM/.test(ty)) return i * 1.25;
      if (/BLOB/.test(ty)) return crypto.randomBytes(i === 0 ? 256 * 1024 : 64);
      return 文本(t, c.name, i);
    });
    try { st.run(...vals); n++; } catch { /* 撞了唯一约束之类就跳过这一行 */ }
  }
  db.exec("COMMIT");
  if (n) { 表++; 行 += n; } else 空表.push(t);
}
db.close();

// 附件样的文件：一个 5MB 随机文件、几个小文件（含中文名、空文件、子目录）
fs.mkdirSync(`${D}/attachments/演练/子目录`, { recursive: true });
fs.writeFileSync(`${D}/attachments/演练/大附件.bin`, crypto.randomBytes(5 * 1024 * 1024));
fs.writeFileSync(`${D}/attachments/演练/名片 照片.jpg`, crypto.randomBytes(48 * 1024));
fs.writeFileSync(`${D}/attachments/演练/空文件`, "");
fs.writeFileSync(`${D}/attachments/演练/子目录/合同.pdf`, crypto.randomBytes(300 * 1024));

console.log(`灌了 ${表} 张表、${行} 行${空表.length ? `；没灌进去的表：${空表.join(" ")}` : ""}；${D}/attachments/演练 下 4 个文件`);
