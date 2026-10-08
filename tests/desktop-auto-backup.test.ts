/**
 * 桌面端自动备份（desktop/auto-backup.js，2026-10-04，回归核对 D-078 / J-242）。
 * 钉的是：每天一份、留 7 份；升级前一份；空库不备；坏了不挡启动；恢复先另存、不认识的文件名不碰、坏备份不换进去。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const 自动 = require_("../desktop/auto-backup.js");
const 备份 = require_("../desktop/backup.js");

let 目录: string;
let 库: string;
beforeEach(() => {
  目录 = fs.mkdtempSync(path.join(os.tmpdir(), "auto-backup-"));
  库 = path.join(目录, "crm.db");
});
afterEach(() => fs.rmSync(目录, { recursive: true, force: true }));

/** 造一个开着 WAL、最后几行还没回写的库：备份要把 WAL 里的也带上 */
function 造库(客户数 = 2) {
  const db = new DatabaseSync(库);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE "Customer" (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE "Lead" (id INTEGER PRIMARY KEY)');
  const ins = db.prepare('INSERT INTO "Customer" (name) VALUES (?)');
  for (let i = 0; i < 客户数; i++) ins.run(`客户${i}`);
  return db;
}
const 数客户 = (f: string) => {
  const db = new DatabaseSync(f);
  try {
    return Number((db.prepare('SELECT count(*) AS n FROM "Customer"').get() as { n: number }).n);
  } finally {
    db.close();
  }
};
const 备份目录 = () => path.join(目录, "backups");
const 有哪些 = () => (fs.existsSync(备份目录()) ? fs.readdirSync(备份目录()).filter((f) => f.endsWith(".db")).sort() : []);
const 日 = (d: string) => new Date(`${d}T09:00:00`);

describe("每天一份", () => {
  it("第一次启动备一份，WAL 里还没回写的也在；同一天再启动不重复备", () => {
    const 开着 = 造库(3);
    const 拷了 = 自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日("2026-10-04"), 日志: () => {} });
    开着.close();
    expect(拷了).toEqual(["daily-2026-10-04.db"]);
    expect(数客户(path.join(备份目录(), "daily-2026-10-04.db"))).toBe(3);
    expect(自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日("2026-10-04"), 日志: () => {} })).toEqual([]);
  });

  it("只留最近 7 份", () => {
    造库().close();
    for (let d = 1; d <= 10; d++) {
      自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日(`2026-10-${String(d).padStart(2, "0")}`), 日志: () => {} });
      // 修剪按修改时间排：把刚拷的那份的时间推到「那一天」，免得同一秒里拷的 10 份分不出先后
      const f = path.join(备份目录(), `daily-2026-10-${String(d).padStart(2, "0")}.db`);
      fs.utimesSync(f, 日(`2026-10-${String(d).padStart(2, "0")}`), 日(`2026-10-${String(d).padStart(2, "0")}`));
    }
    expect(有哪些()).toEqual(["04", "05", "06", "07", "08", "09", "10"].map((d) => `daily-2026-10-${d}.db`));
  });

  it("一个客户、线索、跟进、联系人都没有的新库：不备（拷 7 份空库只会让恢复列表变吵）", () => {
    造库(0).close();
    expect(自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 日志: () => {} })).toEqual([]);
  });
});

describe("升级前一份", () => {
  it("第一次跑有这功能的版本：只记下版本，不当成升级", () => {
    造库().close();
    const 拷了 = 自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日("2026-10-04"), 日志: () => {} });
    expect(拷了.filter((f: string) => f.startsWith("before-upgrade"))).toEqual([]);
    expect(fs.readFileSync(path.join(备份目录(), ".last-version"), "utf8")).toBe("0.46.15");
  });

  it("版本号变了：先备一份 before-upgrade-旧-to-新（同一天已经有每日那份也照样备）", () => {
    造库().close();
    自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日("2026-10-04"), 日志: () => {} });
    const 拷了 = 自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.16", 现在: 日("2026-10-04"), 日志: () => {} });
    expect(拷了).toEqual(["before-upgrade-0.46.15-to-0.46.16.db"]);
    expect(数客户(path.join(备份目录(), "before-upgrade-0.46.15-to-0.46.16.db"))).toBe(2);
  });
});

describe("坏了不挡启动", () => {
  it("库不存在 / 是空文件：什么都不做，不抛", () => {
    expect(自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 日志: () => {} })).toEqual([]);
    fs.writeFileSync(库, "");
    expect(自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 日志: () => {} })).toEqual([]);
  });

  it("备份目录建不出来（被一个同名文件占着）：记一行日志，不抛", () => {
    造库().close();
    fs.writeFileSync(备份目录(), "占位");
    const 日志: string[] = [];
    expect(() => 自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 日志: (x: string) => 日志.push(x) })).not.toThrow();
    expect(日志.join("")).toMatch(/没做成/);
  });
});

describe("恢复", () => {
  function 备一份再改() {
    const db = 造库(2);
    自动.自动备份({ 库, 数据目录: 目录, 版本: "0.46.15", 现在: 日("2026-10-04"), 日志: () => {} });
    db.prepare('INSERT INTO "Customer" (name) VALUES (?)').run("备份之后才录的");
    db.close();
    // 留一份旧的 -wal / -shm 在旁边：恢复要把它们删掉，不然下次打开会重放到换进来的库上
    fs.writeFileSync(`${库}-wal`, "旧的");
    fs.writeFileSync(`${库}-shm`, "旧的");
  }

  it("换进去、删掉旧 -wal / -shm、当前库先另存成 before-restore", () => {
    备一份再改();
    const r = 自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-04.db", 现在: new Date("2026-10-05T15:30:00"), 校验: 备份.校验数据库 });
    expect(r.另存).toBe("before-restore-2026-10-05-1530.db");
    expect(数客户(库)).toBe(2);
    expect(fs.existsSync(`${库}-wal`) || fs.existsSync(`${库}-shm`)).toBe(false);
    expect(数客户(path.join(备份目录(), r.另存))).toBe(3); // 恢复错了还能再恢复回来
  });

  it("审计补测：团队恢复旧库后重置拉取游标，保留团队密钥和身份", () => {
    备一份再改();
    const 团队文件 = path.join(目录, ".team.json");
    const 原团队 = { teamId: "audit-team", device: "dAUDIT01", key: "test-key", pulled: 42, 结构: "same-schema", skipped: [8], signPriv: "private-test-key", keyring: { 0: "old-test-key" }, epoch: 1 };
    fs.writeFileSync(团队文件, JSON.stringify(原团队));
    自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-04.db", 校验: 备份.校验数据库 });
    const 团队 = JSON.parse(fs.readFileSync(团队文件, "utf8"));
    expect(团队).toEqual({ ...原团队, pulled: 0 });
  });

  it("团队配置损坏时中止恢复，不替换当前数据库", () => {
    备一份再改();
    const before = fs.readFileSync(库);
    fs.writeFileSync(path.join(目录, ".team.json"), "{坏掉");
    expect(() => 自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-04.db", 校验: 备份.校验数据库 })).toThrow();
    expect(fs.readFileSync(库)).toEqual(before);
  });

  it("同步检查点写入失败时中止恢复，当前库和配置均保持完整", () => {
    备一份再改();
    const file = path.join(目录, ".team.json");
    const config = JSON.stringify({ teamId: "audit-team", device: "dAUDIT01", key: "test-key", pulled: 42 });
    fs.writeFileSync(file, config);
    const before = fs.readFileSync(库);
    const rename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === file) throw new Error("模拟检查点写入失败");
      return rename(from, to);
    });
    try {
      expect(() => 自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-04.db", 校验: 备份.校验数据库 })).toThrow("模拟检查点写入失败");
      expect(fs.readFileSync(库)).toEqual(before);
      expect(fs.readFileSync(file, "utf8")).toBe(config);
      expect(fs.readdirSync(目录).filter((x) => x.endsWith(".restore.tmp"))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("不认识的文件名（../crm.db 之类）一律不碰", () => {
    备一份再改();
    for (const f of ["../crm.db", "crm.db", "daily-../../x.db", ""]) {
      expect(() => 自动.恢复({ 库, 数据目录: 目录, 文件名: f, 校验: 备份.校验数据库 })).toThrow();
    }
  });

  it("坏掉的备份不换进去：抛错，当前库一行不少", () => {
    备一份再改();
    fs.writeFileSync(path.join(备份目录(), "daily-2026-10-03.db"), "这不是一个库");
    expect(() => 自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-03.db", 校验: 备份.校验数据库 })).toThrow();
    fs.rmSync(`${库}-wal`, { force: true });
    fs.rmSync(`${库}-shm`, { force: true });
    expect(数客户(库)).toBe(3);
  });

  it("列出：类型认得出，新的在前", () => {
    备一份再改();
    自动.恢复({ 库, 数据目录: 目录, 文件名: "daily-2026-10-04.db", 校验: 备份.校验数据库 });
    const 列 = 自动.列出(目录);
    expect(列.map((x: { 类型: string }) => x.类型).sort()).toEqual(["恢复前", "每天"]);
    expect(new Date(列[0].时间).getTime()).toBeGreaterThanOrEqual(new Date(列[1].时间).getTime());
  });
});

describe("壳里接上了", () => {
  it("main.js 起服务前调 自动备份；安装包白名单里有 auto-backup.js", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");
    const 起服务 = main.slice(main.indexOf("async function 真启动本地"), main.indexOf("本地 = await 本地服务.start"));
    expect(起服务).toContain("自动备份.自动备份(");
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../desktop/package.json"), "utf8"));
    expect(pkg.build.files).toContain("auto-backup.js");
  });
});
