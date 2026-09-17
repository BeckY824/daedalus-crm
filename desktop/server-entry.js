/**
 * 本地服务的入口。由 Electron 用自己的 Node 拉起（ELECTRON_RUN_AS_NODE=1），
 * 装配时被复制成 server-bundle/entry.js，和 Next 的 server.js 并排放。
 *
 * 它只做三件事，然后把控制权交给 Next：
 *   1. 首次启动：把随包的模板库复制成用户自己的库，并把账号密码改成本机随机值
 *   2. 每次启动：按序重跑 migrations/（内容幂等），让老版本的库跟上新表结构
 *   3. require('./server.js')
 *
 * 这里刻意不用 Prisma：Prisma 的引擎要按平台解析路径，是 Electron 打包里最容易碎的
 * 一环，而建库和改密码这两件事用 node:sqlite + bcryptjs 就够了（Electron 38 自带的
 * Node 22 里 node:sqlite 不需要任何 flag）。Prisma 只在 Next 进程里用，那条路和
 * 容器部署完全一样，已经被线上验证过。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA = process.env.CRM_DATA_DIR;
if (!DATA) {
  console.error("[entry] 没有 CRM_DATA_DIR，不知道把数据放哪");
  process.exit(1);
}

const DB = path.join(DATA, "crm.db");
const 密码文件 = path.join(DATA, ".init-password");

fs.mkdirSync(DATA, { recursive: true });

/* ---------- 首次启动：复制模板库 ---------- */
const 新建 = !fs.existsSync(DB);
if (新建) {
  const 模板 = path.join(ROOT, "template.db");
  if (!fs.existsSync(模板)) {
    console.error("[entry] 安装包里没有模板库，装配环节出了问题");
    process.exit(1);
  }
  fs.copyFileSync(模板, DB);
  /**
   * 应用包里的文件在 macOS 上是只读的，复制会把只读一起带过来，
   * 于是第一次写入就是 "attempt to write a readonly database"。必须显式放开。
   */
  fs.chmodSync(DB, 0o600);
  console.log("[entry] 已创建本机数据库");

  /**
   * 模板库里的账号带的是构建期占位密码，所有安装包都一样。
   * 换成这台机器独有的随机密码。**用户永远用不到它**：本地模式靠云端账号自动登录，
   * 界面上也不再有任何地方显示它（2026-09-17 之前菜单里有一条「本机账号密码…」，
   * 显示的是这个文件——而用户在设置里改过密码后文件不会跟着变，于是它撒谎）。
   * 留着它只为一件事：哪天这个库被搬到服务器上，它是唯一一把钥匙，不能是公开的。
   */
  try {
    const bcrypt = require("./node_modules/bcryptjs");
    const 密码 = crypto.randomBytes(9).toString("base64url");
    const hash = bcrypt.hashSync(密码, 10);
    const db = new DatabaseSync(DB);
    db.prepare("UPDATE User SET password = ?").run(hash);
    db.close();
    fs.writeFileSync(密码文件, 密码, { mode: 0o600 });
    console.log("[entry] 已为本机账号生成独立密码");
  } catch (e) {
    console.error("[entry] 生成本机密码失败，账号仍是构建期占位密码：", e?.message ?? e);
  }
}

/* ---------- 每次启动：补迁移 ---------- */
/**
 * 按文件名顺序整个重跑一遍。每条语句都是幂等的（IF NOT EXISTS），所以不记录
 * 「执行到哪了」——少一套状态就少一处会和真实表结构对不上的地方。
 * SQLite 没有 ADD COLUMN IF NOT EXISTS，「列已存在」是预期内的，跳过即可。
 * 规矩与 docker-entrypoint.sh 完全一致，两种部署方式走同一套迁移文件。
 */
const 迁移目录 = path.join(ROOT, "migrations");
if (fs.existsSync(迁移目录)) {
  const db = new DatabaseSync(DB);
  for (const f of fs.readdirSync(迁移目录).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      db.exec(fs.readFileSync(path.join(迁移目录, f), "utf8"));
    } catch (e) {
      if (!/duplicate column name|already exists/i.test(String(e?.message))) {
        db.close();
        console.error(`[entry] 迁移 ${f} 失败：`, e?.message ?? e);
        process.exit(1);
      }
    }
  }
  db.close();
}

/* ---------- 以登录的云端账号身份进入 ---------- */
/**
 * 本地模式必须登录云端账号（2026-09-15 起），所以本地库里那个管理员就应该是「你」：
 * 名字、登录邮箱都改成账号的。每次启动都对一遍——换了账号登录，身份跟着换，数据不动。
 * 账号从数据目录的 .cloud.json 读（登录动作写的，见 src/lib/desktop/cloud.ts）；
 * 登录时那个动作也会当场对一遍，这里管的是「上次登录之后这个库被换过」这类情况。
 *
 * 张三 / 李四是自部署演示用的样例账号，桌面端是单人用，新建的库里不该有他们。
 * 只在**新建**时删：老库里他们可能已经挂着客户和跟进，删了就是删别人的数据。
 */
{
  let 云 = null;
  try {
    云 = JSON.parse(fs.readFileSync(path.join(DATA, ".cloud.json"), "utf8"));
  } catch {
    /* 还没登录 */
  }
  const 联系 = String(云?.contact || "").trim().toLowerCase();
  const 名字 = String(云?.name || "").trim() || 联系.split("@")[0];
  if (新建 || 联系) {
    const db = new DatabaseSync(DB);
    try {
      if (新建) {
        const r = db.prepare("DELETE FROM User WHERE email IN ('zhangsan', 'lisi')").run();
        if (r.changes) console.log(`[entry] 已去掉 ${r.changes} 个样例账号`);
      }
      if (联系) {
        const admin = db.prepare("SELECT id, email, name FROM User WHERE role = 'ADMIN' AND active = 1 ORDER BY createdAt ASC LIMIT 1").get();
        if (admin && (admin.email !== 联系 || admin.name !== 名字)) {
          try {
            db.prepare("UPDATE User SET email = ?, name = ?, title = '管理员', updatedAt = strftime('%s','now') * 1000 WHERE id = ?").run(联系, 名字, admin.id);
            console.log(`[entry] 管理员已对上云端账号：${名字} <${联系}>`);
          } catch (e) {
            // 邮箱撞上了别的本地账号（老库里手工建过同名同事）：名字照改，登录名不动
            db.prepare("UPDATE User SET name = ? WHERE id = ?").run(名字, admin.id);
            console.warn("[entry] 登录邮箱已被本地另一个账号占用，只改了名字：", e?.message ?? e);
          }
        }
      }
    } finally {
      db.close();
    }
  }
}

console.log(`[entry] 数据库就绪：${DB}`);

/* ---------- 交给 Next ---------- */
require("./server.js");
