/**
 * 生成「空业务库模板」。托管版开一个新工作区 = 复制这个文件。
 *
 * 为什么不在应用进程里建表：运行镜像是 node:22-slim，`node:sqlite` 在 22 上要加
 * --experimental-sqlite，而 Next 的 server.js 不带这个 flag。所以建表这件事
 * 一律交给能自己控制 flag 的脚本与容器入口，应用进程只做纯文件复制。
 *
 * 用法：
 *   node --experimental-sqlite scripts/build-template.mjs [输出路径] [schema.sql 路径]
 * 不传参时：输出 prisma/ws/_template.db，schema.sql 现场用 prisma migrate diff 生成。
 */
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "prisma/ws/_template.db";
let schemaSql = process.argv[3] ?? "";

if (!schemaSql) {
  // 本地没有现成的 schema.sql（那是 Docker 构建期产物），现场生成一份
  schemaSql = path.join(process.env.TMPDIR ?? "/tmp", `crm-schema-${process.pid}.sql`);
  const sql = execSync(
    "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  fs.writeFileSync(schemaSql, sql);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
// 重新生成：模板必须反映当前 schema，残留的旧表会被原样复制进每个新工作区
for (const f of [out, `${out}-wal`, `${out}-shm`]) fs.rmSync(f, { force: true });

const db = new DatabaseSync(out);
db.exec(fs.readFileSync(schemaSql, "utf8"));

// 迁移在全新库上多数是空转：schema.sql 已经按当前模型建全了。
// SQLite 没有 ADD COLUMN IF NOT EXISTS，所以「列已存在」是预期内的，跳过即可——
// 容器入口用 2>/dev/null 达到同样效果，这里写明白一点。
const migDir = "migrations";
if (fs.existsSync(migDir)) {
  for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      db.exec(fs.readFileSync(path.join(migDir, f), "utf8"));
    } catch (e) {
      if (!/duplicate column name|already exists/i.test(String(e?.message))) throw e;
    }
  }
}
db.close();

console.log(`模板库已生成：${out}`);
