/**
 * R2 · 备份与恢复（desktop/backup.js 原样 require）。
 *
 * 备份时库正在写：本地服务（另一个进程）一直在往 WAL 里写，备份要一致、要通过 integrity_check、不能卡死。
 * 恢复：本轮只改了设置页的说明文字（先退出、删 crm.db-wal / crm.db-shm、再改名放回）。
 * 这里把「按新说明恢复」和「按老说明恢复（不删 -wal）」都真演一遍：本地服务被 SIGKILL、WAL 里留着帧。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
/** node:sqlite 运行时认 { readOnly }，这版 @types/node 的构造函数只写了一个参数 */
const 只读库 = (f: string) =>
  new (DatabaseSync as unknown as new (f: string, o: { readOnly: boolean }) => InstanceType<typeof DatabaseSync>)(f, { readOnly: true });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const 备份 = require_("../desktop/backup.js");

let 沙盒: string;
beforeEach(() => {
  沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "r2-backup-"));
});
// Windows 上写库的连接刚关、文件锁还没放，删会报 EBUSY：多试几次
afterEach(() => fs.rmSync(沙盒, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

function 造库(f: string, 行数: number) {
  const db = new DatabaseSync(f);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE Customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO Customer (name) VALUES (?)");
  db.exec("BEGIN");
  for (let i = 0; i < 行数; i++) ins.run(`客户${i}`.padEnd(80, "·"));
  db.exec("COMMIT");
  return db;
}
const 行数 = (f: string) => {
  const db = 只读库(f);
  try {
    return (db.prepare("SELECT count(*) AS n FROM Customer").get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const 完整 = (f: string) => {
  try {
    const db = 只读库(f);
    const r = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    db.close();
    return r;
  } catch (e) {
    return String((e as Error).message);
  }
};

/** 另一个进程：模拟本地服务，每 间隔 毫秒写一笔 */
function 一直写(f: string, 间隔: number) {
  return spawn(process.execPath, [
    "--no-warnings",
    "-e",
    `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(f)});db.exec("PRAGMA busy_timeout=5000");` +
      `const s=db.prepare("INSERT INTO Customer(name) VALUES ('边备份边写')");setInterval(()=>{try{s.run()}catch(e){console.error(e.message)}},${间隔});`,
  ]);
}
const 限时 = <T,>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "完成" as const), new Promise<"超时">((r) => setTimeout(() => r("超时"), ms))]);

/** 本地服务写了几笔、然后被硬杀（SIGTERM 时 Next 直接 exit，Prisma 不 checkpoint，效果一样）：WAL 里留着帧 */
function 写完被杀(f: string, 笔数: number) {
  spawnSync(process.execPath, [
    "--no-warnings",
    "-e",
    `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(f)});db.exec("PRAGMA wal_autocheckpoint=0");` +
      `const s=db.prepare("INSERT INTO Customer(name) VALUES ('备份之后写的')");for(let i=0;i<${笔数};i++)s.run();` +
      `db.exec("DELETE FROM Customer WHERE id % 3 = 0");process.kill(process.pid,"SIGKILL");`,
  ]);
}

describe("备份时库正在写", () => {
  it("另一个进程每 10 毫秒写一笔（13 MB 的库，人在用 + AI 在写）：备份照样完成、一致、通过 integrity_check", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源, 50_000).close();
    const w = 一直写(源, 10);
    await new Promise((r) => setTimeout(r, 300));
    const 前 = 行数(源);
    const 目标 = path.join(沙盒, "b.db");
    const 结果 = await 限时(备份.备份数据库(源, 目标), 8_000);
    w.kill();
    expect(结果).toBe("完成");
    expect(完整(目标)).toBe("ok");
    expect(行数(目标)).toBeGreaterThanOrEqual(前);
  }, 30_000);

  /*
    【C · 真坏】写得密的时候（Excel 导入几千行、AI 批量建记录，每毫秒一笔）备份**一直不结束**：
    node:sqlite 的 backup() 默认每步拷 100 页、两步之间让出事件循环，源库被别的连接改了就从头再来——
    38 MB 的库要 100 来步，每步之间都有新写入，于是永远重来，按钮一直转到导入结束。
    改法一行：backup(src, 目标, { rate: -1 }) 一步拷完（WAL 下读不挡写），本机实测 25 ms。
  */
  it("【C-6 真坏】每毫秒一笔的持续写入下（导入中）：备份 8 秒内要完成", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源, 150_000).close();
    const w = 一直写(源, 1);
    await new Promise((r) => setTimeout(r, 300));
    const 结果 = await 限时(备份.备份数据库(源, path.join(沙盒, "b.db")), 8_000);
    w.kill();
    expect(结果).toBe("完成");
  }, 30_000);

  it("有一笔写事务开着没提交：备份不等它、也不带上它", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源, 10).close();
    const 写着 = new DatabaseSync(源);
    写着.exec("BEGIN IMMEDIATE");
    写着.exec("INSERT INTO Customer(name) VALUES ('没提交的')");
    const 目标 = path.join(沙盒, "b.db");
    await 备份.备份数据库(源, 目标);
    写着.exec("ROLLBACK");
    写着.close();
    expect(行数(目标)).toBe(10);
    expect(完整(目标)).toBe("ok");
  });

  /*
    【C】备份完 校验数据库() 用只读连接打开了一次，只读连接收尾删不掉自己建的 -shm / -wal：
    桌面上除了「DaedalusCRM-备份-….db」还躺着同名的 .db-shm、.db-wal（0 字节）。不影响备份本身，
    但恢复说明正好在教人「删 -wal / -shm」，人看到备份旁边也有这俩会犯嘀咕。
  */
  it("【C-5 现状】备份旁边会多出 .db-shm / .db-wal 两个文件（.db 本身是完整的）", async () => {
    const 源 = path.join(沙盒, "crm.db");
    const 开着 = 造库(源, 30);
    fs.mkdirSync(path.join(沙盒, "桌面"));
    const 目标 = path.join(沙盒, "桌面", "DaedalusCRM-备份.db");
    await 备份.备份数据库(源, 目标);
    开着.close();
    expect(fs.readdirSync(path.join(沙盒, "桌面")).sort()).toEqual(["DaedalusCRM-备份.db", "DaedalusCRM-备份.db-shm", "DaedalusCRM-备份.db-wal"]);
    // 只拿走 .db 也是全的
    const 只拿db = path.join(沙盒, "只拿db.db");
    fs.copyFileSync(目标, 只拿db);
    expect(行数(只拿db)).toBe(30);
  });

  it("Mac 上大小写不敏感：备份到同目录的「CRM.db」（其实就是 crm.db）也不把库弄坏", async () => {
    const 源 = path.join(沙盒, "crm.db");
    造库(源, 20).close();
    const 同一个 = path.join(沙盒, "CRM.db");
    const 是同一个文件 = fs.existsSync(同一个);
    await 备份.备份数据库(源, 同一个).catch(() => null);
    expect(完整(源)).toBe("ok");
    expect(行数(源)).toBe(20);
    if (!是同一个文件) fs.rmSync(同一个, { force: true });
  });
});

describe("恢复（设置页说明，DesktopTab.tsx:136）", () => {
  function 演一遍(删wal: boolean) {
    const 数据目录 = path.join(沙盒, "data");
    fs.mkdirSync(数据目录);
    const 库 = path.join(数据目录, "crm.db");
    造库(库, 50).close();
    return { 数据目录, 库 };
  }

  it("按现在的说明：退出 → 删 crm.db-wal / crm.db-shm → 备份改名放回：打开就是备份那一刻，完整", async () => {
    const { 数据目录, 库 } = 演一遍(true);
    const 备份文件 = path.join(沙盒, "b.db");
    await 备份.备份数据库(库, 备份文件);
    写完被杀(库, 300);
    expect(fs.statSync(`${库}-wal`).size).toBeGreaterThan(0); // 确实留着帧
    // 恢复
    fs.rmSync(`${库}-wal`, { force: true });
    fs.rmSync(`${库}-shm`, { force: true });
    fs.rmSync(库);
    fs.copyFileSync(备份文件, path.join(数据目录, "crm.db"));
    expect(完整(库)).toBe("ok");
    expect(行数(库)).toBe(50);
  });

  it("按老说明（只换 crm.db、不删 -wal）：恢复出来的不是备份那一刻——说明里那一句必须在", async () => {
    const { 数据目录, 库 } = 演一遍(false);
    const 备份文件 = path.join(沙盒, "b.db");
    await 备份.备份数据库(库, 备份文件);
    写完被杀(库, 300);
    fs.rmSync(库);
    fs.copyFileSync(备份文件, path.join(数据目录, "crm.db"));
    const 结果 = 完整(库);
    const 恢复成了 = 结果 === "ok" && 行数(库) === 50;
    expect(恢复成了).toBe(false); // 要么旧 WAL 被重放（行数不对），要么库坏了
  });

  it("设置页的恢复说明写着：先退出、删 -wal 和 -shm", () => {
    const 文 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/DesktopTab.tsx"), "utf8");
    // 2026-10-04 有了自动备份后这句改成「从自己另存的备份恢复」；要钉的三件事不变
    const 说明 = 文.split("\n").find((l) => /从.*备份恢复/.test(l)) ?? "";
    expect(说明).toMatch(/先退出应用/);
    expect(说明).toMatch(/crm\.db-wal/);
    expect(说明).toMatch(/crm\.db-shm/);
  });

  // 【下一版】回归核对 D-077 后半：Windows 默认藏扩展名，人看到的备份叫「DaedalusCRM-备份」，照说明改名成 crm.db
  // 实际得到 crm.db.db——程序找不到 crm.db 就当新装起一个空库，人以为恢复把数据弄没了（数据其实还在）。
  // 有了设置里的「自动备份 → 恢复」，手动恢复已经不是主路；补一句文案排下一版，补了去掉 skip
  it.skip("【下一版】D-077 恢复说明提醒 Windows 藏扩展名：改名时别改成 crm.db.db", () => {
    const 文 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/DesktopTab.tsx"), "utf8");
    const 说明 = 文.split("\n").find((l) => /从.*备份恢复/.test(l)) ?? "";
    expect(说明).toMatch(/扩展名|crm\.db\.db/);
  });
});
