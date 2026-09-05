/**
 * 增量迁移机制的护栏。
 *
 * 这套机制的全部安全性都押在一个前提上：migrations/ 里每条语句都是幂等的，
 * 因为容器**每次启动都会把整个目录重跑一遍**，不记录执行进度。
 * 一旦有人往里面塞了 ALTER / DROP / INSERT，第二次启动就会炸在生产环境，
 * 而那时才发现就太晚了。所以在这里挡住。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "migrations");
const 文件 = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

describe("迁移文件", () => {
  it("目录里要有按序号命名的 .sql", () => {
    expect(文件.length).toBeGreaterThan(0);
    for (const f of 文件) expect(f, `${f} 不符合 NNN-说明.sql 的命名`).toMatch(/^\d{3}-[a-z0-9-]+\.sql$/);
  });

  it("只能加东西：不允许 ALTER / DROP / DELETE / UPDATE / INSERT", () => {
    for (const f of 文件) {
      const sql = readFileSync(path.join(DIR, f), "utf8")
        .replace(/--.*$/gm, "") // 去掉注释再检查，免得注释里的字眼误伤
        .toUpperCase();
      for (const 禁 of ["ALTER TABLE", "DROP ", "DELETE FROM", "UPDATE ", "INSERT INTO"]) {
        expect(sql.includes(禁), `${f} 含有不允许的语句：${禁}`).toBe(false);
      }
    }
  });

  it("每条建表/建索引都要带 IF NOT EXISTS", () => {
    for (const f of 文件) {
      const sql = readFileSync(path.join(DIR, f), "utf8").replace(/--.*$/gm, "");
      const 建 = sql.match(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX)[\s\S]*?(?=\()/gi) ?? [];
      for (const 句 of 建) {
        expect(/IF NOT EXISTS/i.test(句), `${f} 里这句缺 IF NOT EXISTS：${句.trim().slice(0, 60)}`).toBe(true);
      }
    }
  });

  it("连续跑两遍不报错——容器每次启动都会重跑一遍", () => {
    const 临时库 = path.join(ROOT, "prisma/_migration-check.db");
    rmSync(临时库, { force: true });
    try {
      const db = new DatabaseSync(临时库);
      for (const 轮 of [1, 2]) {
        for (const f of 文件) {
          expect(
            () => db.exec(readFileSync(path.join(DIR, f), "utf8")),
            `第 ${轮} 遍执行 ${f} 失败`,
          ).not.toThrow();
        }
      }
      // 跑完确实建出了表
      const 表 = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
      expect(表.map((t) => t.name)).toContain("AuditLog");
      db.close();
    } finally {
      rmSync(临时库, { force: true });
    }
  });
});

describe("备份与恢复", () => {
  it("备份文件名要精确到秒，否则同一分钟内的两次备份会互相覆盖", async () => {
    /**
     * 2026-08-29 的恢复演练里撞上过：先备了干净状态，
     * 一分钟内又备了一份带标记的，干净那份直接被盖掉，脚本一声不吭。
     * 备份互相覆盖是最不该发生的事——出问题时那正是唯一的退路。
     */
    const fs = await import("node:fs/promises");
    const sh = await fs.readFile(path.join(ROOT, "scripts/backup.sh"), "utf8");
    expect(sh, "备份文件名缺少秒").toMatch(/%H%M%S/);
    expect(sh, "没有防重名，同名时应当拒绝而不是覆盖").toContain("拒绝覆盖");
  });

  it("恢复脚本必须连 WAL 一起清掉，否则恢复完数据还是错的", async () => {
    /**
     * 库跑在 WAL 模式下，crm.db 旁边还有 crm.db-wal / crm.db-shm。
     * 只换 crm.db 不删这两个，SQLite 起来会把旧 WAL 重放到新文件上，
     * 表现是「恢复完了数据还是错的」，而且完全看不出哪里错。
     */
    const fs = await import("node:fs/promises");
    const sh = await fs.readFile(path.join(ROOT, "scripts/restore.sh"), "utf8");
    expect(sh).toContain("crm.db-wal");
    expect(sh).toContain("crm.db-shm");
    expect(sh, "必须先停容器再换文件").toContain("docker compose stop");
    expect(sh, "破坏性操作要有显式确认").toContain("CONFIRM");
  });
});

describe("两条安装路径要一致", () => {
  it("schema.prisma 里必须有 AuditLog，否则全新安装会缺表", () => {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("model AuditLog");
    // 留痕表不与 User 建外键：成员被删不该带走历史
    const 段 = schema.slice(schema.indexOf("model AuditLog"));
    expect(段.slice(0, 段.indexOf("}"))).not.toMatch(/@relation/);
  });

  it("entrypoint 会执行 migrations，Dockerfile 会把它拷进运行镜像", () => {
    const entry = readFileSync(path.join(ROOT, "docker-entrypoint.sh"), "utf8");
    expect(entry).toContain("/app/migrations");
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const 运行段 = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(运行段, "运行镜像里没有 migrations，存量库永远补不上新表").toContain("migrations");
  });
});
